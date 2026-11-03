/**
 * Type conformance of schema-first resolvers (RFC 0007 §5.4): one application per row, the SDL type
 * of a field (or an argument) against the TypeScript type of the resolver method (or parameter).
 * Output positions must be assignable to the SDL type, input positions must accept every value
 * graphql-js passes; every mismatch is one ZNIGHT068 located on the TypeScript annotation.
 */
import type { GraphQLAnalysis } from './helpers.ts'

import { analyzeSchemaFirst, cleanupApps, pointed, schemaOf, section } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const SDL = `scalar Isbn
scalar DateTime
scalar JSON

interface Node {
  id: ID!
}

type Book implements Node {
  id: ID!
  title: String!
}

type Author implements Node {
  id: ID!
  name: String!
}

union Result = Book | Author

enum Genre {
  FANTASY
  SF
}

input Filter {
  genre: Genre
  limit: Int
}

type Query {
  ping: Boolean
}
`

const TYPES = `import type { Float, ID, Int, JSONValue } from '@znight/graphql'
import type { Isbn } from './isbn.ts'

export type { Float, ID, Int, Isbn, JSONValue }
export enum Genre { FANTASY = 'FANTASY', SF = 'SF' }
export enum Level { Low = 1, High = 2 }
export interface Book { __typename?: 'Book'; id: string; title: string }
export interface Author { __typename?: 'Author'; id: string; name: string }
export class BookClass { constructor(readonly id: string, readonly title: string) {} }
export class AuthorClass { constructor(readonly id: string, readonly name: string) {} }
export interface Bare { id: string; title: string }
export interface Filter { genre?: Genre | null; limit?: number | null }
export interface FilterExtra { genre?: Genre | null; extra: string }
`

const CLASSES = `/** Classes named like the members: told apart with instanceof. */
export class Book {
  constructor(readonly id: string, readonly title: string) {}
}

export class Author {
  constructor(readonly id: string, readonly name: string) {}
}
`

const PLAIN = `/** Book without __typename: union members cannot be told apart. */
export interface Book { id: string; title: string }
export interface Author { id: string; name: string }
`

const ISBN = `import { scalar } from '@znight/graphql'

export type Isbn = string & { readonly __brand: 'Isbn' }

export const IsbnScalar = scalar<Isbn>('Isbn', { serialize: value => value as Isbn, parseValue: value => value as Isbn })
`

const PING = `import { Query, Resolver } from '@znight/graphql'

@Resolver()
export class PingResolver {
  @Query()
  ping(): boolean {
    return true
  }
}
`

function files(sdl: string, body: string, imports = ''): Record<string, string> {
  return {
    'src/schema.graphql': SDL,
    'src/field.graphql': sdl,
    'src/types.ts': TYPES,
    'src/plain.ts': PLAIN,
    'src/classes.ts': CLASSES,
    'src/isbn.ts': ISBN,
    'src/ping.resolver.ts': PING,
    'src/f.resolver.ts': `import { Args, Parent, Query, ResolveField, Resolver, Subscription } from '@znight/graphql'
import type { Author, AuthorClass, Bare, Book, BookClass, Filter, FilterExtra, Float, Genre, ID, Int, Isbn, JSONValue, Level } from './types.ts'
${imports}
@Resolver('Book')
export class F {
${body}
}

void [Args, Parent, Query, ResolveField, Subscription]
void (0 as unknown as [Author, AuthorClass, Bare, Book, BookClass, Filter, FilterExtra, Float, Genre, ID, Int, Isbn, JSONValue, Level])
`,
  }
}

const CODES = new Set(['ZNIGHT062', 'ZNIGHT064', 'ZNIGHT067', 'ZNIGHT068'])

function messages(result: GraphQLAnalysis): string[] {
  return result.diagnostics.filter(diagnostic => CODES.has(diagnostic.code)).map(diagnostic => diagnostic.message)
}

/** `Query.f: <sdl>` resolved by `f(): <ts>`. */
async function output(sdl: string, ts: string): Promise<string[]> {
  return messages(
    await analyzeSchemaFirst(
      files(`extend type Query {\n  f: ${sdl}\n}\n`, `  @Query()\n  f(): ${ts} {\n    return null as never\n  }`),
    ),
  )
}

/** `Query.f(x: <sdl>): Boolean` resolved by `f(@Args('x') x: <ts>)`. */
async function input(sdl: string, ts: string): Promise<string[]> {
  return messages(
    await analyzeSchemaFirst(
      files(
        `extend type Query {\n  f(x: ${sdl}): Boolean\n}\n`,
        `  @Query()\n  f(@Args('x') x: ${ts}): boolean {\n    return x !== undefined\n  }`,
      ),
    ),
  )
}

describe('output positions: the TypeScript type is assignable to the SDL type', () => {
  const conforming: readonly (readonly [sdl: string, ts: string])[] = [
    ['String!', 'string'],
    ['String!', 'Promise<string>'],
    ['String', 'string | null | undefined'],
    ['String!', "'a' | 'b'"],
    ['String!', 'Genre'],
    ['String!', 'Isbn'],
    ['ID!', 'ID'],
    ['ID!', 'number'],
    ['Int!', 'number'],
    ['Int!', 'Int'],
    ['Int!', 'Level'],
    ['Float!', '42'],
    ['Float!', 'Float'],
    ['Boolean!', 'boolean'],
    ['Boolean!', 'true'],
    ['DateTime!', 'Date'],
    ['JSON', 'JSONValue'],
    ['Isbn!', 'Isbn'],
    ['[String!]!', 'string[]'],
    ['[String!]!', 'readonly string[]'],
    ['[String!]!', 'Set<string>'],
    ['[[Int!]]', '(readonly number[] | null)[]'],
    ['Genre!', 'Genre'],
    ['Genre!', "'FANTASY'"],
    ['Book!', 'Book'],
    ['Book!', 'BookClass'],
    ['Book', 'Promise<Book | undefined>'],
    ['Result!', 'Book | Author'],
    ['Result!', 'Book'],
    ['Result!', "Bare & { readonly __typename: 'Book' }"],
    ['Node!', 'Book | Author'],
    ['String!', 'unknown'],
    // biome-ignore lint/suspicious/noExplicitAny: any opts out of the checks
    ['String!', 'any'],
  ]
  it.each(conforming)('%s ← %s', async (sdl, ts) => {
    expect(await output(sdl, ts)).toEqual([])
  })

  const mismatches: readonly (readonly [sdl: string, ts: string, message: string])[] = [
    ['String!', 'string | null', 'F.f returns string | null, which may be null, but Query.f is String! (non-null)'],
    [
      'String!',
      'string | undefined',
      'F.f returns string | undefined, which may be undefined, but Query.f is String! (non-null)',
    ],
    ['String!', 'number', 'F.f returns number, which does not conform to String (Query.f)'],
    ['Int', 'string', 'F.f returns string, which does not conform to Int (Query.f)'],
    ['DateTime', 'string', 'F.f returns string, which does not conform to DateTime (Query.f)'],
    ['Isbn', 'string', 'F.f returns string, which does not conform to Isbn (Query.f)'],
    [
      '[String!]!',
      '(string | null)[]',
      'F.f returns a list of string | null, which may be null, but Query.f is String! (non-null)',
    ],
    ['[String!]!', 'string', 'F.f returns string, not a list, but Query.f is [String!]!'],
    ['Genre!', "'FANTASY' | 'HORROR'", 'F.f returns "HORROR", not a value of the enum Genre (Query.f)'],
    ['Genre!', 'string', 'F.f returns string, wider than the enum Genre (Query.f)'],
    ['Book!', 'string', 'F.f returns string, not an object type, but Query.f is Book'],
    [
      'Book!',
      '{ readonly id: string }',
      "Book.title has no resolver, and the returned object type (returned by F.f) has no property 'title'",
    ],
    [
      'Book',
      '{ readonly id: string; readonly title: number }',
      "property 'title' is number, which does not conform to String (Book.title)",
    ],
    ['Result', 'Bare', 'F.f returns Bare, which is not a member of Result (Book, Author)'],
    ['Result', 'string', 'F.f returns string, not an object type, but Query.f is Result'],
  ]
  it.each(mismatches)('%s ← %s', async (sdl, ts, message) => {
    expect(await output(sdl, ts)).toEqual([message])
  })

  it('locates the mismatch on the return type annotation', async () => {
    const result = await analyzeSchemaFirst(
      files(
        'extend type Query {\n  f: String!\n}\n',
        '  @Query()\n  f(): Promise<string | null> {\n    return null as never\n  }',
      ),
    )
    const [diagnostic] = result.diagnostics.filter(candidate => candidate.code === 'ZNIGHT068')
    expect(diagnostic === undefined ? '' : pointed(diagnostic)).toBe('Promise<string | null>')
    expect(diagnostic?.related?.[0]?.message).toBe('Query.f is declared here')
    expect(diagnostic?.hints).toEqual(['Return a value in every case, or make Query.f nullable in the SDL (String)'])
  })

  it('tells union members apart with instanceof when they are exported classes', async () => {
    const { diagnostics, code } = await schemaOf(
      files(
        'extend type Query {\n  f: [Result!]!\n}\n',
        '  @Query()\n  f(): (ClassBook | ClassAuthor)[] {\n    return []\n  }',
        "import type { Author as ClassAuthor, Book as ClassBook } from './classes.ts'",
      ),
      { schema: 'src/**/*.graphql' },
    )
    expect(diagnostics.filter(diagnostic => CODES.has(diagnostic.code))).toEqual([])
    expect(section(code)).toContain(
      "['discriminator']: { ['by']: 'class', ['classes']: [[Author, 'Author'], [Book, 'Book']] },",
    )
  })

  it('reports union members without __typename that are not classes (ZNIGHT064)', async () => {
    const result = await analyzeSchemaFirst(
      files(
        'extend type Query {\n  f: [Result!]!\n}\n',
        '  @Query()\n  f(): (PlainBook | PlainAuthor)[] {\n    return []\n  }',
        "import type { Author as PlainAuthor, Book as PlainBook } from './plain.ts'",
      ),
    )
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'ZNIGHT064').map(d => d.message)).toEqual([
      'Author cannot be told apart among the members of Result at runtime: it declares no __typename and is not an exported class',
      'Book cannot be told apart among the members of Result at runtime: it declares no __typename and is not an exported class',
    ])
  })

  it('checks subscriptions against the event type', async () => {
    const result = await analyzeSchemaFirst(
      files(
        'type Subscription {\n  s: String!\n  t: String!\n}\n',
        `  @Subscription()
  async *s(): AsyncGenerator<string | null> {}

  @Subscription()
  t(): string {
    return ''
  }`,
      ),
    )
    expect(messages(result)).toEqual([
      'F.s returns string | null, which may be null, but Subscription.s is String! (non-null)',
      '@Subscription F.t must return an async iterable (Subscription.t)',
    ])
  })

  it('checks the properties of the @Parent() type named like the fields', async () => {
    const result = await analyzeSchemaFirst(
      files(
        'extend type Book {\n  upper: String!\n}\n',
        `  @ResolveField()
  upper(@Parent() book: { readonly id: number; readonly title: string | null; readonly other: boolean }): string {
    return String(book.title)
  }`,
      ),
    )
    expect(messages(result)).toEqual([
      "property 'title' is string | null, which may be null, but Book.title is String! (non-null)",
    ])
  })
})

describe('input positions: the TypeScript type accepts every value of the SDL type', () => {
  const conforming: readonly (readonly [sdl: string, ts: string])[] = [
    ['String!', 'string'],
    ['String!', 'string | null'],
    ['String', 'string | null | undefined'],
    ['String', 'string | undefined'],
    ['String = "a"', 'string | null'],
    ['ID!', 'string'],
    ['ID!', 'ID'],
    ['Int!', 'number'],
    ['Int!', 'Int'],
    ['Genre!', 'Genre'],
    ['Genre!', 'string'],
    ['Isbn!', 'Isbn'],
    ['[Int!]!', 'readonly number[]'],
    ['Filter!', 'Filter'],
    ['Filter!', '{ readonly genre?: Genre }'],
    ['DateTime!', 'Date'],
    ['String!', 'unknown'],
  ]
  it.each(conforming)('%s → %s', async (sdl, ts) => {
    expect(await input(sdl, ts)).toEqual([])
  })

  const mismatches: readonly (readonly [sdl: string, ts: string, message: string])[] = [
    ['String!', "'a' | 'b'", 'parameter \'x\' of F.f is "a" | "b", which does not accept every String (Query.f(x:))'],
    ['String', 'string', "parameter 'x' of F.f does not accept undefined, but Query.f(x:) (String) may be omitted"],
    [
      'String',
      'string | null',
      "parameter 'x' of F.f does not accept undefined, but Query.f(x:) (String) may be omitted",
    ],
    ['String = "a"', 'string', "parameter 'x' of F.f does not accept null, but Query.f(x:) (String) may be null"],
    ['ID!', 'number', "parameter 'x' of F.f is number, which does not accept every ID (Query.f(x:))"],
    [
      'Genre!',
      "'FANTASY'",
      'parameter \'x\' of F.f is "FANTASY", which does not accept SF of the enum Genre (Query.f(x:))',
    ],
    ['[Int!]!', 'number', "parameter 'x' of F.f is number, not an array, but Query.f(x:) is [Int!]!"],
    ['Isbn!', 'number', "parameter 'x' of F.f is number, which does not accept every Isbn (Query.f(x:))"],
    ['Filter!', 'FilterExtra', 'FilterExtra.extra is not a field of the input Filter: it is always undefined'],
    [
      'Filter!',
      '{ readonly limit: number }',
      'the input type.limit does not accept undefined, but Filter.limit (Int) may be omitted',
    ],
    ['Filter!', 'string', "parameter 'x' of F.f is string, not an object type, but Query.f(x:) is Filter"],
  ]
  it.each(mismatches)('%s → %s', async (sdl, ts, message) => {
    expect(await input(sdl, ts)).toEqual([message])
  })

  it('turns null into undefined where the TypeScript type only accepts undefined (nullAsUndefined)', async () => {
    const { code, diagnostics } = await schemaOf(
      files(
        'extend type Query {\n  f(a: String, b: String, filter: Filter): Boolean\n}\n',
        `  @Query()
  f(@Args('a') a: string | undefined, @Args('b') b: string | null | undefined, @Args('filter') filter?: { readonly limit?: number }): boolean {
    return a === b && filter === undefined
  }`,
      ),
      { schema: 'src/**/*.graphql' },
    )
    expect(diagnostics.filter(diagnostic => CODES.has(diagnostic.code))).toEqual([])
    const printed = section(code)
    expect(printed).toContain("{ ['name']: 'a', ['type']: 'String', ['nullAsUndefined']: true },")
    expect(printed).toContain("{ ['name']: 'b', ['type']: 'String' },")
    expect(printed).toContain("{ ['name']: 'filter', ['type']: 'Filter', ['nullAsUndefined']: true },")
    expect(printed).toContain("{ ['name']: 'limit', ['type']: 'Int', ['nullAsUndefined']: true },")
  })

  it('checks @Args() objects property by property, unknown arguments included', async () => {
    const result = await analyzeSchemaFirst(
      files(
        'extend type Query {\n  f(x: String!, y: Int): Boolean\n}\n',
        `  @Query()
  f(@Args() args: { readonly x: string; readonly y?: number; readonly z: boolean }): boolean {
    return args.z
  }`,
      ),
    )
    expect(messages(result)).toEqual(["Query.f has no argument 'z' (property 'z' of the @Args() parameter of F.f)"])
  })

  it('does not check arguments validated by a schema (their type is the schema output)', async () => {
    const result = await analyzeSchemaFirst({
      ...files(
        'extend type Query {\n  f(x: String!): Boolean\n}\n',
        `  @Query()
  f(@Args('x', Upper) x: { readonly upper: string }): boolean {
    return x.upper !== ''
  }`,
        "import { Upper } from './upper.ts'",
      ),
      'src/upper.ts': `import { z } from 'zod'\nexport const Upper = z.string().transform(value => ({ upper: value.toUpperCase() }))\n`,
    })
    expect(messages(result)).toEqual([])
  })
})
