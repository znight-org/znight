import path from 'node:path'
import { buildSchema, printSchema } from 'graphql'

import { schemaHash } from '../../src/schema-hash.ts'
import { CATALOG } from './fixtures.ts'
import { cleanupApps, compileApp, render, schemaOf, section, tempApp, typecheck, typecheckSanity } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

/** The SDL of the catalog: the schema of RFC 0005 §5.13 as graphql-js 17 prints it. */
const CATALOG_SDL = `type Author {
  kind: String!
  id: ID!
  name: String!
  born: Int
}

"""A book of the catalog."""
type Book {
  kind: String!
  id: ID!
  title: String!
  isbn: String!

  """Year of first publication, \`null\` when unknown."""
  publishedYear: Int
  genre: Genre!
  tags: [String!]!
  createdAt: DateTime!
  category: String @deprecated(reason: "Use \`tags\`.")

  """
  Who wrote the book. Batched: one repository call per execution, whatever the number of books.
  """
  author: Author!
}

"""A page of results."""
type BookPage {
  items: [Book!]!
  total: Int!
  hasMore: Boolean!
}

"""Sort orders of the book list."""
enum BookSort {
  title
  newest
}

scalar DateTime @specifiedBy(url: "https://datatracker.ietf.org/doc/html/rfc3339")

"""Literary genres."""
enum Genre {
  Fantasy
  ScienceFiction
  Mystery
}

type Mutation {
  """Adds a book to the catalog."""
  addBook(input: NewBookInput!): Book!
}

"""
A new book. The interface is the GraphQL input type, the schema of the same name validates it.
"""
input NewBookInput {
  title: String!
  isbn: String!
  authorId: String!
  genre: Genre!
  publishedYear: Int
  tags: [String!]
}

type Query {
  """Books of the catalog, filtered and paginated."""
  books(
    """Case-insensitive search in titles."""
    search: String
    genre: Genre
    sort: BookSort = title
    limit: Int = 20
    offset: Int = 0
  ): BookPage!

  """One book."""
  book(
    """The id of the book."""
    id: ID!
  ): Book
  search(text: String!): [SearchResult!]!
}

"""A search hit: told apart at runtime by \`kind\`, found by the compiler."""
union SearchResult = Author | Book

type Subscription {
  """Books added from now on, optionally of one genre."""
  bookAdded(genre: Genre): Book!
}
`

describe('the catalog (RFC 0005 §5)', () => {
  it('generates the section of §7.1', async () => {
    const result = await schemaOf(CATALOG)
    expect(render(result)).toEqual([])
    expect(section(result.code)).toMatchSnapshot()
  })

  it('writes the SDL artifact, byte-identical to graphql-js printSchema', async () => {
    const result = await schemaOf(CATALOG)
    expect(result.sdl).toBe(CATALOG_SDL)
    expect(`${printSchema(buildSchema(result.sdl))}\n`).toBe(result.sdl)
  })

  it('hashes the SDL (schemaHash)', async () => {
    const result = await schemaOf(CATALOG)
    expect(result.code).toContain(`['schemaHash']: '${schemaHash(CATALOG_SDL.slice(0, -1))}'`)
  })

  it('imports validateArgs and isThenable only for validated arguments, the field types lazily', async () => {
    const result = await schemaOf(CATALOG)
    expect(result.code).toContain("import { isThenable } from '@znight/http'")
    expect(result.code).toContain("import { validateArgs } from '@znight/graphql'")
    expect(result.code).toContain("import type { GraphQLArgs, GraphQLContext } from '@znight/graphql'")
    expect(result.code).not.toContain('GraphQLResolveInfo')
    expect(result.code).toContain("import { NewBookInput } from '../catalog/book.inputs.js'")
  })

  it('is deterministic: two compiles, build and serve modes give the same section and SDL', async () => {
    const build = await schemaOf(CATALOG, {}, 'build')
    const again = await schemaOf(CATALOG, {}, 'build')
    const serve = await schemaOf(CATALOG, {}, 'serve')
    expect(section(again.code)).toBe(section(build.code))
    expect(section(serve.code)).toBe(section(build.code))
    expect(again.sdl).toBe(build.sdl)
    expect(serve.sdl).toBe(build.sdl)
  })

  it('generates a module that type-checks under max-strict settings', async () => {
    const app = tempApp(CATALOG)
    const result = await compileApp(app.root, { mode: 'build' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    const outFile = path.relative(app.root, result.outFile)
    app.write(outFile, result.code)
    expect(typecheck(app, [outFile])).toEqual([])
    expect(typecheckSanity(app, outFile).length).toBeGreaterThan(0)
  }, 60_000)
})

describe('invoke', () => {
  const RESOLVER = `import type { GraphQLResolveInfo } from 'graphql'
import { Args, Ctx, Info, type GraphQLContext, Parent, Query, ResolveField, Resolver } from '@znight/graphql'
import { Check, type Item, type Text } from './types.ts'

@Resolver()
export class R {
  @Query()
  items(): readonly Item[] {
    return []
  }

  @ResolveField()
  label(@Parent() item: Item): string {
    return item.id
  }

  @ResolveField()
  context(@Parent() item: Item, @Ctx() ctx: GraphQLContext): string {
    return item.id + ctx.requestId
  }

  @Query()
  path(@Info() info: GraphQLResolveInfo): string {
    return info.fieldName
  }

  @Query()
  checked(@Args('a', Check) a: Text, @Args('b') b: string, @Args('c', Check) c: Text): string {
    return a.text + b + c.text
  }
}
`
  const TYPES = `import type { StandardSchemaV1 } from '@znight/graphql'
export interface Item { readonly id: string }
export interface Text { readonly text: string }
export const Check: StandardSchemaV1<unknown, Text> = {
  '~standard': { version: 1, vendor: 'test', validate: value => ({ value: value as Text }) },
}
`

  it('passes only the used parameters (unused middle ones _-prefixed, trailing ones omitted)', async () => {
    const result = await schemaOf({ 'src/types.ts': TYPES, 'src/r.resolver.ts': RESOLVER })
    const code = section(result.code)
    expect(render(result)).toEqual([])
    expect(code).toContain("['invoke']: (r: R) => r.items(),")
    expect(code).toContain("['invoke']: (r: R, p: unknown) => r.label(p as never),")
    expect(code).toContain(
      "['invoke']: (r: R, p: unknown, _a: GraphQLArgs, c: GraphQLContext) => r.context(p as never, c),",
    )
    expect(code).toContain(
      "['invoke']: (r: R, _p: unknown, _a: GraphQLArgs, _c: GraphQLContext, i: GraphQLResolveInfo) =>\n                  r.path(i),",
    )
    expect(code).toContain(
      [
        "['invoke']: (r: R, _p: unknown, a: GraphQLArgs) => {",
        "                  const v0 = validateArgs(Check, a['a'], 'a')",
        '                  if (isThenable(v0)) return (async () =>',
        "                    r.checked(await v0 as never, a['b'] as never, await validateArgs(Check, a['c'], 'c') as never))()",
        "                  const v2 = validateArgs(Check, a['c'], 'c')",
        "                  if (isThenable(v2)) return (async () => r.checked(v0 as never, a['b'] as never, await v2 as never))()",
        "                  return r.checked(v0 as never, a['b'] as never, v2 as never)",
        '                },',
      ].join('\n'),
    )
    expect(result.code).toContain("import type { GraphQLResolveInfo } from 'graphql'")
  })

  it('runs synchronously with synchronous schemas and awaits asynchronous ones', async () => {
    const app = tempApp({ 'src/types.ts': TYPES, 'src/r.resolver.ts': RESOLVER })
    const result = await compileApp(app.root, { mode: 'build' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    const start = result.code.indexOf("['name']: 'checked'")
    const source = result.code.slice(result.code.indexOf("['invoke']: ", start) + 12)
    const body = source.slice(0, source.indexOf('\n                },') + 18)
    const isThenable = (value: unknown): value is PromiseLike<unknown> =>
      typeof (value as { then?: unknown } | null)?.then === 'function'
    const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(`export default ${body.replace(/,\s*$/, '')}`)
    const factory = new Function('validateArgs', 'isThenable', 'Check', transpiled.replace('export default', 'return'))
    const invoke = (validate: (schema: unknown, value: unknown) => unknown) =>
      factory(validate, isThenable, {}) as (
        r: { checked(a: unknown, b: unknown, c: unknown): unknown },
        p: unknown,
        a: Record<string, unknown>,
      ) => unknown
    const resolver = { checked: (a: unknown, b: unknown, c: unknown) => [a, b, c] }
    const sync = invoke((_, value) => `${value}!`)(resolver, undefined, { a: 'x', b: 'y', c: 'z' })
    expect(sync).toEqual(['x!', 'y', 'z!'])
    const async = invoke(async (_, value) => `${value}?`)(resolver, undefined, { a: 'x', b: 'y', c: 'z' })
    expect(async).toBeInstanceOf(Promise)
    expect(await async).toEqual(['x?', 'y', 'z?'])
  })
})

describe('the section', () => {
  it('is omitted when the application has no resolver', async () => {
    const result = await schemaOf({
      'src/service.ts': "import { Injectable } from '@znight/core'\n\n@Injectable()\nexport class Service {}\n",
    })
    expect(render(result)).toEqual([])
    expect(result.code).not.toContain("['graphql']")
    expect(result.sdl).toBe('')
  })

  it('emits the route decorator groups of resolvers', async () => {
    const result = await schemaOf(CATALOG)
    expect(section(result.code)).toContain(
      "['groups']: { ['access']: { ['keys']: ['public', 'roles'], ['required']: true } }",
    )
  })
})
