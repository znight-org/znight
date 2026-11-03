/**
 * Schema-first end to end (RFC 0007): the SDL files and resolvers of `schema-first-app.ts` are
 * compiled with `compile()` (the extension configured with `{ schema, sdl }`), the generated module
 * is imported and booted with `HttpPlugin` + `GraphQLPlugin` in a `TestApp`, and operations run
 * through the whole HTTP pipeline. The SDL artifact is the source schema, semantically.
 */
import type { CompileResult, CompilerExtension } from '@znight/compiler'
import type { ZnightMetadata } from '@znight/core'
import type { GraphQLMetadata } from '../../src/index.ts'
import type { TempApp } from './helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'
import {
  buildASTSchema,
  buildSchema,
  concatAST,
  GraphQLSchema,
  lexicographicSortSchema,
  parse,
  printSchema,
  specifiedDirectives,
} from 'graphql'

import graphql from '../../src/compiler/index.ts'
import { GraphQLPlugin } from '../../src/index.ts'
import { schemaHash } from '../../src/schema-hash.ts'
import { executeOperation, subscribeOperation } from '../../src/testing.ts'
import { captureLogger } from '../support/app.ts'
import {
  cleanupApps,
  compileApp,
  render,
  section as sectionOf,
  tempApp,
  typecheck,
  typecheckSanity,
} from './helpers.ts'
import { BASE_SDL, CATALOG_SDL, EVENTS_SDL, SCHEMA_FIRST_APP } from './schema-first-app.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const CODES = ['ZNIGHT001', 'ZNIGHT005', 'ZNIGHT061', 'ZNIGHT062', 'ZNIGHT064', 'ZNIGHT065', 'ZNIGHT067', 'ZNIGHT068']

function compileSchemaFirst(app: TempApp): Promise<CompileResult> {
  const extension = graphql.configure({
    schema: 'src/**/*.graphql',
    sdl: 'schema.graphql',
  }) as unknown as CompilerExtension
  return compileApp(app.root, { mode: 'build', extensions: [extension] })
}

/** A schema printed in a canonical order, without custom directives. */
function canonical(schema: GraphQLSchema): string {
  return printSchema(
    lexicographicSortSchema(new GraphQLSchema({ ...schema.toConfig(), directives: specifiedDirectives })),
  )
}

describe('schema-first application (e2e)', () => {
  let app: TempApp
  let result: CompileResult
  let again: CompileResult
  let sdl: string
  let section: GraphQLMetadata
  let test: TestApp
  let store: { readonly authorBatches: (readonly string[])[] }

  beforeAll(async () => {
    app = tempApp(SCHEMA_FIRST_APP)
    result = await compileSchemaFirst(app)
    expect(render({ root: app.root, diagnostics: result.diagnostics }, CODES)).toEqual([
      `warning ZNIGHT067 src/schema/base.graphql:7:12 The custom directive @resolved is ignored
  = Znight serves the schema without custom directives (and so does the SDL artifact): remove it, or keep it for other tools`,
    ])
    again = await compileSchemaFirst(app)
    sdl = result.extraFiles.find(file => file.file === app.path('schema.graphql'))?.content ?? ''
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    const generated = (await import(pathToFileURL(result.outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata }
    section = generated.__ZNIGHT_METADATA__.extensions?.graphql as GraphQLMetadata
    test = await TestApp.create({
      metadata: generated.__ZNIGHT_METADATA__,
      plugins: [HttpPlugin.configure({ port: 0, host: '127.0.0.1' }), GraphQLPlugin.configure({ introspection: true })],
      logger: captureLogger(),
    })
    store = test.get('src/catalog/catalog.store.ts#CatalogStore') as typeof store
  }, 60_000)

  afterAll(async () => {
    await test?.close()
    cleanupApps()
  })

  describe('generated module', () => {
    it('is byte-identical across two compiles, with the same SDL artifact', () => {
      expect(again.code).toBe(result.code)
      expect(again.extraFiles).toEqual(result.extraFiles)
    })

    it('lists the SDL files among the inputs of the compile', () => {
      for (const file of ['src/schema/base.graphql', 'src/catalog/catalog.graphql', 'src/catalog/events.graphql']) {
        expect(result.watchFiles).toContain(app.path(file))
      }
    })

    it('hashes the SDL artifact', () => {
      expect(section.schemaHash).toBe(schemaHash(sdl.slice(0, -1)))
    })

    it('binds the resolvers by name, with the same invokers as code-first', () => {
      const printed = sectionOf(result.code)
      expect(printed).toContain("['method']: 'find',")
      expect(printed).toContain("['method']: 'booksOf',")
      expect(printed).toContain("['interfaces']: ['Node', 'Named'],")
      expect(printed).toContain("['discriminator']: { ['by']: 'typename' },")
      // the scalar keeps the SDL description
      expect(printed).toContain("['description']: 'An ISBN-13, thirteen digits.',")
    })

    it('type-checks under max-strict settings, with the application sources', () => {
      const outFile = path.relative(app.root, result.outFile)
      expect(typecheck(app, [outFile])).toEqual([])
      expect(typecheckSanity(app, outFile).length).toBeGreaterThan(0)
    }, 60_000)
  })

  describe('schema', () => {
    it('serves the source schema: the artifact equals the SDL files without their custom directives', () => {
      const source = buildASTSchema(concatAST([BASE_SDL, CATALOG_SDL, EVENTS_SDL].map(text => parse(text))))
      expect(canonical(buildSchema(sdl))).toBe(canonical(source))
      const plugin = test.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
      expect(`${plugin.printSchema()}\n`).toBe(sdl)
      expect(`${printSchema(plugin.schema)}\n`).toBe(sdl)
      expect(sdl).not.toContain('@resolved')
    })
  })

  describe('operations', () => {
    it('resolves root fields, defaults, enums, the custom scalar and DateTime', async () => {
      const res = await executeOperation(test, {
        query: '{ books { id title isbn genre createdAt category } one: book(id: "b1") { title category } }',
      })
      expect(res.status).toBe(200)
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({
        books: [
          {
            id: 'b1',
            title: 'Dune',
            isbn: '9780441172719',
            genre: 'SCIENCE_FICTION',
            createdAt: '2024-01-01T00:00:00.000Z',
            category: 'classics',
          },
          {
            id: 'b2',
            title: 'A Wizard of Earthsea',
            isbn: '9780547773742',
            genre: 'FANTASY',
            createdAt: '2024-01-02T00:00:00.000Z',
            category: null,
          },
          {
            id: 'b3',
            title: 'Children of Dune',
            isbn: '9780593098240',
            genre: 'SCIENCE_FICTION',
            createdAt: '2024-01-03T00:00:00.000Z',
            category: null,
          },
        ],
        one: { title: 'Dune', category: 'classics' },
      })
    })

    it('passes input objects with their defaults and nullable arguments', async () => {
      const res = await executeOperation(test, {
        query: '{ fantasy: books(filter: { genre: FANTASY }) { title } none: books(filter: null) { id } }',
      })
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({
        fantasy: [{ title: 'A Wizard of Earthsea' }],
        none: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
      })
    })

    it('resolves the union and the interfaces from __typename', async () => {
      const res = await executeOperation(test, {
        query: `{
          search(text: "le") { __typename ... on Book { title } ... on Author { name } }
          node(id: "a1") { __typename id ... on Named { name } }
        }`,
      })
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({
        search: [{ __typename: 'Author', name: 'Ursula K. Le Guin' }],
        node: { __typename: 'Author', id: 'a1', name: 'Frank Herbert' },
      })
    })

    it('runs the field resolvers bound by name, batched by the loader', async () => {
      const batches = store.authorBatches.length
      const res = await executeOperation(test, {
        query: '{ books { author { name books(limit: 1) { title } } } }',
      })
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({
        books: [
          { author: { name: 'Frank Herbert', books: [{ title: 'Children of Dune' }] } },
          { author: { name: 'Ursula K. Le Guin', books: [{ title: 'A Wizard of Earthsea' }] } },
          { author: { name: 'Frank Herbert', books: [{ title: 'Children of Dune' }] } },
        ],
      })
      expect(store.authorBatches.slice(batches)).toEqual([['a1', 'a2']])
    })

    it('validates the mutation input with its schema and streams the subscription', async () => {
      const invalid = await executeOperation(test, {
        query: 'mutation { addBook(input: { title: "X", isbn: "1", authorId: "a1" }) { id } }',
      })
      expect(invalid.errors?.[0]?.message).toContain('An ISBN has 13 digits')
      await using events = await subscribeOperation(test, {
        query: 'subscription { bookAdded(genre: FANTASY) { title genre author { name } } }',
      })
      expect(events.status).toBe(200)
      const added = await executeOperation(test, {
        query: 'mutation Add($input: NewBook!) { addBook(input: $input) { id title genre } }',
        variables: { input: { title: ' The Tombs of Atuan ', isbn: '9780689845369', authorId: 'a2' } },
      })
      expect(added.errors).toBeUndefined()
      // the SDL default (genre: FANTASY) and the Zod transform (trim) both applied
      expect(added.data).toEqual({ addBook: { id: 'b4', title: 'The Tombs of Atuan', genre: 'FANTASY' } })
      expect((await events.next()).value).toEqual({
        data: { bookAdded: { title: 'The Tombs of Atuan', genre: 'FANTASY', author: { name: 'Ursula K. Le Guin' } } },
      })
    })
  })
})
