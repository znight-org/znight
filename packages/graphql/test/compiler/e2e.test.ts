/**
 * End to end: the library application (`e2e-app.ts`) is compiled with `compile()` (the extension
 * configured to write the SDL artifact), the generated module is imported and booted with
 * `HttpPlugin` + `GraphQLPlugin` in a `TestApp`, and operations run through the whole HTTP pipeline
 * with `executeOperation()` / `subscribeOperation()`.
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
import { buildSchema, printSchema } from 'graphql'

import graphql from '../../src/compiler/index.ts'
import { GraphQLPlugin } from '../../src/index.ts'
import { schemaHash } from '../../src/schema-hash.ts'
import { executeOperation, subscribeOperation } from '../../src/testing.ts'
import { captureLogger } from '../support/app.ts'
import { LIBRARY } from './e2e-app.ts'
import { cleanupApps, compileApp, render, tempApp, typecheck, typecheckSanity } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** The catalog store of the application (its fields used here). */
interface Store {
  readonly authorBatches: (readonly string[])[]
  readonly reviewBatches: (readonly string[])[]
  readonly reviewLoaders: number
}

const STORE = 'src/catalog/catalog.store.ts#CatalogStore'
const EDITOR = { 'x-role': 'editor' }
const READER = { 'x-role': 'reader' }
const ADD_BOOK = `mutation Add($input: NewBookInput!) {
  addBook(input: $input) { id title isbn genre publishedYear author { name } }
}`

function compileLibrary(app: TempApp): Promise<CompileResult> {
  const extension = graphql.configure({ sdl: 'schema.graphql' }) as unknown as CompilerExtension
  return compileApp(app.root, { mode: 'build', extensions: [extension] })
}

describe('compiled GraphQL application (e2e)', () => {
  let app: TempApp
  let result: CompileResult
  let again: CompileResult
  let sdl: string
  let section: GraphQLMetadata
  let test: TestApp
  let store: Store

  beforeAll(async () => {
    app = tempApp(LIBRARY)
    result = await compileLibrary(app)
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    again = await compileLibrary(app)
    sdl = result.extraFiles.find(file => file.file === app.path('schema.graphql'))?.content ?? ''
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    const generated = (await import(pathToFileURL(result.outFile).href)) as { metadata: ZnightMetadata }
    section = generated.metadata.extensions?.graphql as GraphQLMetadata
    test = await TestApp.create({
      metadata: generated.metadata,
      plugins: [HttpPlugin.configure({ port: 0, host: '127.0.0.1' }), GraphQLPlugin.configure({ introspection: true })],
      logger: captureLogger(),
    })
    store = test.get(STORE) as Store
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

    it('hashes the SDL artifact', () => {
      expect(sdl.endsWith('}\n')).toBe(true)
      expect(section.schemaHash).toBe(schemaHash(sdl.slice(0, -1)))
    })

    it('type-checks under max-strict settings, with the application sources', () => {
      const outFile = path.relative(app.root, result.outFile)
      expect(typecheck(app, [outFile])).toEqual([])
      expect(typecheckSanity(app, outFile).length).toBeGreaterThan(0)
    }, 60_000)
  })

  describe('schema', () => {
    it('GraphQLPlugin prints the SDL the compiler emitted', () => {
      const plugin = test.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
      expect(`${plugin.printSchema()}\n`).toBe(sdl)
      expect(`${printSchema(buildSchema(sdl))}\n`).toBe(sdl)
    })

    it('carries descriptions, deprecations, enums, the union, the generic page and the custom scalar', () => {
      expect(sdl).toContain('"""A book of the catalog."""\ntype Book {')
      expect(sdl).toContain('category: String @deprecated(reason: "Use `genre`.")')
      expect(sdl).toContain('enum Genre {\n  Fantasy\n  ScienceFiction\n}')
      expect(sdl).toContain('enum BookSort {\n  title\n  newest\n}')
      expect(sdl).toContain('union SearchResult = Author | Book')
      expect(sdl).toContain('type BookPage {')
      expect(sdl).toContain(
        '"""An ISBN-13, thirteen digits."""\nscalar Isbn @specifiedBy(url: "https://www.isbn-international.org/content/what-isbn")',
      )
      expect(sdl.slice(sdl.indexOf('type Book {'), sdl.indexOf('type BookPage {'))).not.toContain('authorId') // @gqlHidden
    })
  })

  describe('queries', () => {
    it('resolves fields, enums, defaults, the custom scalar and DateTime', async () => {
      const res = await executeOperation(test, {
        query: `{ books(sort: newest, limit: 2) {
          total
          items { id title isbn genre publishedYear createdAt category }
        } }`,
      })
      expect(res.status).toBe(200)
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({
        books: {
          total: 3,
          items: [
            {
              id: 'b3',
              title: 'Children of Dune',
              isbn: '9780593098240',
              genre: 'ScienceFiction',
              publishedYear: null,
              createdAt: '2024-01-03T00:00:00.000Z',
              category: null,
            },
            {
              id: 'b2',
              title: 'A Wizard of Earthsea',
              isbn: '9780547773742',
              genre: 'Fantasy',
              publishedYear: 1968,
              createdAt: '2024-01-02T00:00:00.000Z',
              category: null,
            },
          ],
        },
      })
    })

    it('passes enum arguments as their internal values and nullable arguments as undefined', async () => {
      const res = await executeOperation(test, {
        query: 'query Q($genre: Genre) { books(genre: $genre, search: null) { items { title } } }',
        variables: { genre: 'Fantasy' },
      })
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({ books: { items: [{ title: 'A Wizard of Earthsea' }] } })
      const one = await executeOperation(test, {
        query: '{ book(id: "b1") { title category } nope: book(id: "x") { id } }',
      })
      expect(one.data).toEqual({ book: { title: 'Dune', category: 'classics' }, nope: null })
    })

    it('tells the members of the union apart by kind', async () => {
      const res = await executeOperation(test, {
        query: `{ search(text: "her") {
          __typename
          ... on Book { title }
          ... on Author { name }
        } }`,
      })
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({
        search: [{ __typename: 'Author', name: 'Frank Herbert' }],
      })
      const books = await executeOperation(test, { query: '{ search(text: "dune") { __typename } }' })
      expect(books.data).toEqual({ search: [{ __typename: 'Book' }, { __typename: 'Book' }] })
    })

    it('batches the field resolvers: one call per loader and execution (no N+1)', async () => {
      const authorBatches = store.authorBatches.length
      const reviewBatches = store.reviewBatches.length
      const loaders = store.reviewLoaders
      const res = await executeOperation(test, {
        query: '{ books { items { id author { name } reviews { id stars } } } }',
      })
      expect(res.errors).toBeUndefined()
      expect(res.data).toEqual({
        books: {
          items: [
            { id: 'b2', author: { name: 'Ursula K. Le Guin' }, reviews: [{ id: 'r3', stars: 5 }] },
            { id: 'b3', author: { name: 'Frank Herbert' }, reviews: [] },
            {
              id: 'b1',
              author: { name: 'Frank Herbert' },
              reviews: [
                { id: 'r1', stars: 5 },
                { id: 'r2', stars: 4 },
              ],
            },
          ],
        },
      })
      // three books, two authors: one batch of the singleton loader, keys deduplicated
      expect(store.authorBatches.slice(authorBatches)).toEqual([['a2', 'a1']])
      // one batch of the request-scoped loader, from one instance created for the request
      expect(store.reviewBatches.slice(reviewBatches)).toEqual([['b2', 'b3', 'b1']])
      expect(store.reviewLoaders - loaders).toBe(1)
      // a new execution: new DataLoaders (no cache across requests), a new request-scoped instance
      await executeOperation(test, { query: '{ books { items { author { name } reviews { id } } } }' })
      expect(store.authorBatches.length - authorBatches).toBe(2)
      expect(store.reviewBatches.length - reviewBatches).toBe(2)
      expect(store.reviewLoaders - loaders).toBe(2)
    })
  })

  describe('guards and route decisions', () => {
    it('lets public fields through without credentials', async () => {
      const res = await executeOperation(test, { query: '{ book(id: "b2") { title author { name } } }' })
      expect(res.data).toEqual({ book: { title: 'A Wizard of Earthsea', author: { name: 'Ursula K. Le Guin' } } })
    })

    it('fails an @Authenticated field with UNAUTHENTICATED without credentials', async () => {
      const denied = await executeOperation(test, { query: '{ whoami }' })
      expect(denied.status).toBe(200)
      expect(denied.data).toBeNull()
      expect(denied.errors).toEqual([
        expect.objectContaining({
          message: 'Sign in first',
          path: ['whoami'],
          extensions: expect.objectContaining({ code: 'UNAUTHENTICATED' }),
        }),
      ])
      const allowed = await executeOperation(test, { query: '{ whoami }', headers: READER })
      expect(allowed.errors).toBeUndefined()
      expect(allowed.data).toEqual({ whoami: 'reader' })
    })

    it('fails a @Roles field with FORBIDDEN for another role, UNAUTHENTICATED without one', async () => {
      const variables = {
        input: { title: 'Dune Messiah', isbn: '9780593098233', authorId: 'a1', genre: 'ScienceFiction' },
      }
      const forbidden = await executeOperation(test, { query: ADD_BOOK, variables, headers: READER })
      expect(forbidden.data).toBeNull()
      expect(forbidden.errors?.map(error => [error.path, error.extensions?.['code']])).toEqual([
        [['addBook'], 'FORBIDDEN'],
      ])
      const anonymous = await executeOperation(test, { query: ADD_BOOK, variables })
      expect(anonymous.errors?.map(error => error.extensions?.['code'])).toEqual(['UNAUTHENTICATED'])
    })
  })

  describe('mutations and subscriptions', () => {
    it('validates arguments with their Standard Schema: BAD_USER_INPUT with the issues', async () => {
      const res = await executeOperation(test, {
        query: ADD_BOOK,
        variables: {
          input: { title: '  ', isbn: '9780593098233', authorId: 'a1', genre: 'Fantasy', publishedYear: 3000 },
        },
        headers: EDITOR,
      })
      expect(res.status).toBe(200)
      expect(res.data).toBeNull()
      expect(res.errors).toHaveLength(1)
      const error = res.errors?.[0]
      expect(error?.path).toEqual(['addBook'])
      expect(error?.extensions?.['code']).toBe('BAD_USER_INPUT')
      expect(error?.extensions?.['issues']).toEqual([
        { path: 'title', message: 'A title is required' },
        { path: 'publishedYear', message: 'Not published yet' },
      ])
    })

    it('rejects a variable the custom scalar does not parse', async () => {
      const res = await executeOperation(test, {
        query: ADD_BOOK,
        variables: { input: { title: 'Dune Messiah', isbn: '978', authorId: 'a1', genre: 'ScienceFiction' } },
        headers: EDITOR,
      })
      expect(res.status).toBe(400)
      expect(res.data).toBeUndefined()
      expect(res.errors?.[0]?.message).toContain('An ISBN has 13 digits')
    })

    it('runs a validated mutation and delivers it to the subscribers of its genre', async () => {
      await using events = await subscribeOperation(test, {
        query: 'subscription { bookAdded(genre: Fantasy) { id title genre author { name } } }',
      })
      expect(events.status).toBe(200)
      const added = await executeOperation(test, {
        query: ADD_BOOK,
        variables: { input: { title: 'Dune Messiah', isbn: '9780593098233', authorId: 'a1', genre: 'ScienceFiction' } },
        headers: EDITOR,
      })
      expect(added.errors).toBeUndefined()
      expect(added.data).toEqual({
        addBook: {
          id: 'b4',
          title: 'Dune Messiah',
          isbn: '9780593098233',
          genre: 'ScienceFiction',
          publishedYear: null,
          author: { name: 'Frank Herbert' },
        },
      })
      const fantasy = await executeOperation(test, {
        query: ADD_BOOK,
        variables: {
          input: {
            title: ' The Tombs of Atuan ',
            isbn: '9780689845369',
            authorId: 'a2',
            genre: 'Fantasy',
            publishedYear: 1971,
          },
        },
        headers: EDITOR,
      })
      expect(fantasy.errors).toBeUndefined()
      // the validated output (trimmed title) reached the resolver; the science-fiction book was filtered out
      expect((await events.next()).value).toEqual({
        data: {
          bookAdded: { id: 'b5', title: 'The Tombs of Atuan', genre: 'Fantasy', author: { name: 'Ursula K. Le Guin' } },
        },
      })
    })
  })
})
