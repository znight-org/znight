/**
 * The type mapping of RFC 0005 §6.2, row by row, in output position (object fields, resolver
 * return types) and in input position (input fields, arguments), with nullability and lists.
 */
import { cleanupApps, render, schemaOf } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const PRELUDE = `import { scalar, type Float, type ID, type Int, type JSONValue } from '@znight/graphql'

export type Email = string & { readonly __brand: 'Email' }
export const EmailScalar = scalar<Email>('Email', { serialize: value => value, parseValue: value => value as Email })

export enum Genre {
  Fantasy = 'fantasy',
  Mystery = 'mystery',
}

export enum Level {
  Low = 1,
  High = 2,
}

export type Sort = 'title' | 'newest'

export type Alias = string
`

/** An application whose `Out.value` (output) and `In.value` (input) have the given types. */
function app(output: string, input: string = output, prelude = ''): Record<string, string> {
  return {
    'src/types.ts': `${PRELUDE}
${prelude}

void (0 as unknown as [Float, ID, Int, JSONValue])

export interface Out {
  readonly value: ${output}
}

export interface In {
  readonly value: ${input}
}
`,
    'src/types.resolver.ts': `import { Args, Mutation, Query, Resolver } from '@znight/graphql'
import type { In, Out } from './types.ts'

@Resolver()
export class TypesResolver {
  @Query()
  out(): Out {
    return null as never
  }

  @Mutation()
  take(@Args('input') input: In): boolean {
    return input !== undefined
  }
}
`,
  }
}

/** The body of a type of the SDL (`type Out { ... }`). */
function block(sdl: string, head: string): string {
  const start = sdl.indexOf(`${head} {\n`)
  if (start === -1) return `<no ${head} in>\n${sdl}`
  return sdl.slice(start + head.length + 3, sdl.indexOf('\n}', start)).trim()
}

describe('§6.2 rows in both positions', () => {
  const rows: readonly (readonly [ts: string, graphql: string])[] = [
    ['string', 'String!'],
    ["'a'", 'String!'],
    ['number', 'Float!'],
    ['42', 'Float!'],
    ['Int', 'Int!'],
    ['Float', 'Float!'],
    ['ID', 'ID!'],
    ['boolean', 'Boolean!'],
    ['true', 'Boolean!'],
    ['Date', 'DateTime!'],
    ['bigint', 'BigInt!'],
    ['JSONValue', 'JSON'],
    ['Email', 'Email!'],
    ['Genre', 'Genre!'],
    ['Level', 'Level!'],
    ['Sort', 'Sort!'],
    ['Alias', 'String!'],
    ['string[]', '[String!]!'],
    ['readonly string[]', '[String!]!'],
    ['Array<Int>', '[Int!]!'],
    ['ReadonlyArray<ID>', '[ID!]!'],
    ['Int[][]', '[[Int!]!]!'],
    ['string | null', 'String'],
    ['string | undefined', 'String'],
    ['readonly (string | null)[]', '[String]!'],
    ['readonly string[] | null', '[String!]'],
    ['Genre | null', 'Genre'],
  ]
  for (const [ts, graphql] of rows) {
    it(`${ts} → ${graphql}`, async () => {
      const result = await schemaOf(app(ts))
      expect(render(result)).toEqual([])
      expect(block(result.sdl, 'type Out')).toBe(`value: ${graphql}`)
      expect(block(result.sdl, 'input In')).toBe(`value: ${graphql}`)
    })
  }

  it('an optional property is nullable', async () => {
    const files = app('string')
    files['src/types.ts'] = (files['src/types.ts'] as string).replaceAll('readonly value:', 'readonly value?:')
    const result = await schemaOf(files)
    expect(block(result.sdl, 'type Out')).toBe('value: String')
    expect(block(result.sdl, 'input In')).toBe('value: String')
  })

  it("number maps to Int with { number: 'Int' }", async () => {
    const result = await schemaOf(app('number'), { number: 'Int' })
    expect(block(result.sdl, 'type Out')).toBe('value: Int!')
    expect(block(result.sdl, 'input In')).toBe('value: Int!')
  })

  it('built-in scalars appear only when used, with their @specifiedBy', async () => {
    const plain = await schemaOf(app('string'))
    expect(plain.sdl).not.toContain('scalar')
    const dates = await schemaOf(app('Date', 'bigint'))
    expect(dates.sdl).toContain('scalar BigInt\n')
    expect(dates.sdl).toContain('scalar DateTime @specifiedBy(url: "https://datatracker.ietf.org/doc/html/rfc3339")')
    expect(dates.sdl).not.toContain('scalar JSON')
  })

  it('enums: member names and values in declaration order, literal unions in source order', async () => {
    const result = await schemaOf(app('Genre', 'Sort'))
    expect(block(result.sdl, 'enum Genre')).toBe('Fantasy\n  Mystery')
    expect(block(result.sdl, 'enum Sort')).toBe('title\n  newest')
    expect(result.code).toContain("{ ['name']: 'Fantasy', ['value']: 'fantasy' }")
    expect(result.code).toContain("{ ['name']: 'title', ['value']: 'title' }")
    const numeric = await schemaOf(app('Level'))
    expect(numeric.code).toContain("{ ['name']: 'Low', ['value']: 1 }")
  })
})

describe('§6.2 output-only rows', () => {
  for (const [ts, graphql] of [
    ['Set<string>', '[String!]!'],
    ['ReadonlySet<Int>', '[Int!]!'],
    ['Iterable<ID>', '[ID!]!'],
    ['Set<string | null>', '[String]!'],
  ] as const) {
    it(`${ts} → ${graphql} (output)`, async () => {
      const result = await schemaOf(app(ts, 'string'))
      expect(render(result)).toEqual([])
      expect(block(result.sdl, 'type Out')).toBe(`value: ${graphql}`)
    })
  }

  it('sets are not input values (ZNIGHT063)', async () => {
    const result = await schemaOf(app('string', 'Set<string>'))
    expect(render(result)).toEqual([
      [
        'error ZNIGHT063 src/types.ts:29:19 In.value is a Set: input lists are arrays',
        '  = Declare an array (readonly T[]) for input values',
        '  - reached from Mutation.take(input) → In (src/types.resolver.ts:12:3)',
      ].join('\n'),
    ])
  })
})

describe('object types', () => {
  const OBJECTS = `
/** A class. */
export class Thing {
  constructor(readonly id: ID) {}
  readonly name!: string
  /** Computed. */
  get label(): string {
    return this.name
  }
  protected secret = 'x'
  #hidden = 1
  method(): void {}
}

export class Base {
  readonly id!: ID
}

export class Derived extends Base {
  readonly extra!: Int
}

export interface Named {
  readonly name: string
}

export interface Child extends Named {
  readonly age: Int
}

export type Literal = { readonly a: string; readonly b?: Int }

export type Both = Named & { readonly flag: boolean }

export interface Page<T> {
  readonly items: readonly T[]
  readonly total: Int
}

export interface Edge<T> {
  readonly node: T
}

export type BookList = Page<Derived>

export type Changes = Partial<Child>
`

  it('maps classes (parameter properties, fields, getters, base members first), interfaces, aliases and generics', async () => {
    const result = await schemaOf(
      app(
        'Thing | null',
        'string',
        `${OBJECTS}
export interface All {
  readonly thing: Thing
  readonly derived: Derived
  readonly child: Child
  readonly literal: Literal
  readonly both: Both
  readonly page: Page<Child>
  readonly nested: Page<Edge<Derived>>
  readonly list: BookList
  readonly changes: Changes
}`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(block(result.sdl, 'type Thing')).toBe(
      ['id: ID!', '  name: String!', '', '  """Computed."""', '  label: String!'].join('\n'),
    )
  })

  it('names generic instances after their arguments, or after the alias', async () => {
    const files = app('All', 'string', OBJECTS)
    files['src/types.ts'] = `${files['src/types.ts']}
export interface All {
  readonly thing: Thing
  readonly derived: Derived
  readonly child: Child
  readonly literal: Literal
  readonly both: Both
  readonly page: Page<Child>
  readonly nested: Page<Edge<Derived>>
  readonly list: BookList
  readonly changes: Changes
}
`
    const result = await schemaOf(files)
    expect(render(result)).toEqual([])
    expect(block(result.sdl, 'type All')).toBe(
      [
        'thing: Thing!',
        '  derived: Derived!',
        '  child: Child!',
        '  literal: Literal!',
        '  both: Both!',
        '  page: ChildPage!',
        '  nested: DerivedEdgePage!',
        '  list: BookList!',
        '  changes: Changes!',
      ].join('\n'),
    )
    expect(block(result.sdl, 'type Derived')).toBe('id: ID!\n  extra: Int!')
    expect(block(result.sdl, 'type Child')).toBe('name: String!\n  age: Int!')
    expect(block(result.sdl, 'type Literal')).toBe('a: String!\n  b: Int')
    expect(block(result.sdl, 'type Both')).toBe('name: String!\n  flag: Boolean!')
    expect(block(result.sdl, 'type ChildPage')).toBe('items: [Child!]!\n  total: Int!')
    expect(block(result.sdl, 'type DerivedEdgePage')).toBe('items: [DerivedEdge!]!\n  total: Int!')
    expect(block(result.sdl, 'type DerivedEdge')).toBe('node: Derived!')
    expect(block(result.sdl, 'type BookList')).toBe('items: [Derived!]!\n  total: Int!')
    expect(block(result.sdl, 'type Changes')).toBe('name: String\n  age: Int')
  })

  it('maps object types in input position to input types (getters excluded: ZNIGHT063)', async () => {
    const result = await schemaOf(app('string', 'Derived', OBJECTS))
    expect(render(result)).toEqual([])
    expect(block(result.sdl, 'input Derived')).toBe('id: ID!\n  extra: Int!')
    const getters = await schemaOf(app('string', 'Thing', OBJECTS))
    expect(render(getters)).toEqual([
      [
        'error ZNIGHT063 src/types.ts:26:16 Thing.label is a getter: input values are plain data',
        '  = Declare a property instead, or hide the getter with /** @gqlHidden */',
        '  - reached from Mutation.take(input) → In.value → Thing (src/types.resolver.ts:12:3)',
      ].join('\n'),
    ])
  })
})

describe('subscriptions and promises', () => {
  for (const returned of [
    'AsyncIterable<Int>',
    'AsyncGenerator<Int>',
    'AsyncIterableIterator<Int>',
    'Promise<AsyncIterable<Int>>',
  ]) {
    it(`a @Subscription returning ${returned} has the type of its events`, async () => {
      const result = await schemaOf({
        'src/r.resolver.ts': `import { Query, Resolver, Subscription, type Int } from '@znight/graphql'

@Resolver()
export class R {
  @Query()
  ping(): boolean {
    return true
  }

  @Subscription()
  ticks(): ${returned} {
    return null as never
  }
}
`,
      })
      expect(render(result)).toEqual([])
      expect(block(result.sdl, 'type Subscription')).toBe('ticks: Int!')
    })
  }

  it('unwraps the Promise of a return type', async () => {
    const result = await schemaOf({
      'src/r.resolver.ts': `import { Query, Resolver } from '@znight/graphql'

@Resolver()
export class R {
  @Query()
  async names(): Promise<readonly (string | null)[] | null> {
    return null
  }
}
`,
    })
    expect(block(result.sdl, 'type Query')).toBe('names: [String]')
  })
})

describe('rejected types (ZNIGHT060)', () => {
  const rows: readonly (readonly [ts: string, message: string, hint: string])[] = [
    ['any', "Cannot map 'unknown' or 'any' to a GraphQL type (Out.value)", 'JSONValue'],
    ['unknown', "Cannot map 'unknown' or 'any' to a GraphQL type (Out.value)", 'JSONValue'],
    ['never', "Cannot map 'never' to a GraphQL type (Out.value)", 'Declare the type'],
    ['symbol', "Cannot map 'symbol' to a GraphQL type (Out.value)", ''],
    ['[string, Int]', 'Cannot map a tuple to a GraphQL type (Out.value)', 'Use an array'],
    ['Map<string, Int>', "Cannot map 'Map<string, Int>' to a GraphQL type (Out.value)", 'JSONValue'],
    ['Record<string, Int>', 'Cannot map a record or an index signature to a GraphQL type (Out.value)', 'JSONValue'],
    ['{ [key: string]: Int }', 'Cannot map a record or an index signature to a GraphQL type (Out.value)', 'JSONValue'],
    ['Uint8Array', 'Cannot map binary data to a GraphQL type (Out.value)', "scalar<Uint8Array>('Base64'"],
    ['Blob', 'Cannot map binary data to a GraphQL type (Out.value)', '@gqlHidden'],
    ['URL', "Cannot map 'URL' to a GraphQL type (Out.value)", "scalar<URL>('URL'"],
    ['string | Int', 'Cannot map the union Int | string to a GraphQL type (Out.value)', 'only contain object types'],
    ['{ readonly a: string }', 'Cannot map an anonymous object type to a GraphQL type (Out.value)', 'export interface'],
    [
      "'a' | 'b'",
      "Cannot map the anonymous union 'a' | 'b' to a GraphQL type (Out.value)",
      "export type Sort = 'a' | 'b'",
    ],
    ['Promise<string>', "Cannot map 'Promise<string>' to a GraphQL type (Out.value)", 'only unwrapped at the top'],
    ['AsyncIterable<string>', "Cannot map 'AsyncIterable' to a GraphQL type (Out.value)", '@Subscription'],
    ['null', "Cannot map 'null' to a GraphQL type (Out.value)", 'Declare the type'],
  ]
  for (const [ts, message, hint] of rows) {
    it(ts, async () => {
      const result = await schemaOf(app(ts, 'string'))
      const lines = render(result)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('ZNIGHT060 src/types.ts:')
      expect(lines[0]).toContain(message)
      expect(lines[0]).toContain(hint)
      expect(lines[0]).toContain('reached from Query.out → Out (src/types.resolver.ts:')
      expect(result.sdl).toBe('')
    })
  }

  it('functions and hidden members are left out of object types', async () => {
    const result = await schemaOf(
      app(
        'Holder',
        'string',
        `export interface Holder {
  readonly kept: string
  readonly callback: () => void
  /** @gqlHidden */
  readonly hidden: Uint8Array
}`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(block(result.sdl, 'type Holder')).toBe('kept: String!')
  })

  it('a resolver without return type annotation', async () => {
    const result = await schemaOf({
      'src/r.resolver.ts': `import { Query, Resolver } from '@znight/graphql'

@Resolver()
export class R {
  @Query()
  ping() {
    return true
  }
}
`,
    })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT060 src/r.resolver.ts:6:3 R.ping has no return type annotation (Query.ping)',
        '  = Annotate the return type: the schema is derived from it (ping(...): Promise<Book>)',
      ].join('\n'),
    ])
  })

  it('void and async iterables outside @Subscription', async () => {
    const result = await schemaOf({
      'src/r.resolver.ts': `import { Mutation, Query, Resolver } from '@znight/graphql'

@Resolver()
export class R {
  @Query()
  ping(): AsyncIterable<string> {
    return null as never
  }

  @Mutation()
  async touch(): Promise<void> {}
}
`,
    })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT060 src/r.resolver.ts:6:3 R.ping returns an async iterable: only @Subscription fields stream values (Query.ping)',
        '  = Use @Subscription() for a stream of events, or return a list (Promise<readonly Book[]>)',
      ].join('\n'),
      [
        'error ZNIGHT060 src/r.resolver.ts:11:9 R.touch returns void: GraphQL fields must return a value (Mutation.touch)',
        '  = Return a payload type (the changed object) or a boolean',
      ].join('\n'),
    ])
  })
})
