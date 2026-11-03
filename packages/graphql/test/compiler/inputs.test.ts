/**
 * Inputs and arguments (RFC 0005 §6.3): input types, args objects, defaults, null handling, input
 * versus output use, cycles (ZNIGHT061, ZNIGHT063).
 */
import { cleanupApps, render, schemaOf, section } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const TYPES = `import type { Int } from '@znight/graphql'

export enum Genre {
  Fantasy = 'fantasy',
  Mystery = 'mystery',
}

export type Sort = 'title' | 'newest'

export interface Money {
  readonly amount: Int
  readonly currency: string
}

export interface Book {
  readonly title: string
  readonly price: Money
}

export interface NewBook {
  readonly title: string
  /** @default "Fantasy" */
  readonly genre?: Genre
  readonly price: Money
}

export interface Filter {
  /** Text to search. */
  readonly search?: string | undefined
  /** @default "newest" */
  readonly sort?: Sort
  /** @default 20 */
  readonly limit?: Int
  /** @default null */
  readonly cursor?: string | null
}
`

function resolver(body: string): string {
  return `import { Args, Mutation, Query, Resolver, type Int } from '@znight/graphql'
import { Genre, type Book, type Filter, type Money, type NewBook, type Sort } from './types.ts'

@Resolver()
export class R {
${body}
}

void (0 as unknown as [Book, Filter, Money, NewBook, Sort, Int, typeof Genre])
`
}

const PING = `  @Query()
  ping(): boolean {
    return true
  }
`

describe('arguments', () => {
  it('@Args() spreads the properties of its type, with descriptions, defaults and null handling', async () => {
    const result = await schemaOf({
      'src/types.ts': TYPES,
      'src/r.resolver.ts': resolver(`  @Query()
  books(@Args() filter: Filter, @Args('extra') extra?: string): readonly string[] {
    void filter
    void extra
    return []
  }`),
    })
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain(
      [
        'type Query {',
        '  books(',
        '    """Text to search."""',
        '    search: String',
        '    sort: Sort = newest',
        '    limit: Int = 20',
        '    cursor: String = null',
        '    extra: String',
        '  ): [String!]!',
        '}',
      ].join('\n'),
    )
    const code = section(result.code)
    expect(code).toContain("['description']: 'Text to search.',\n                  ['nullAsUndefined']: true,")
    expect(code).toContain(
      "{ ['name']: 'sort', ['type']: 'Sort', ['defaultValue']: 'newest', ['nullAsUndefined']: true }",
    )
    // `cursor` accepts null: no normalisation
    expect(code).toContain("{ ['name']: 'cursor', ['type']: 'String', ['defaultValue']: null }")
    expect(code).toContain(
      "['invoke']: (r: R, _p: unknown, a: GraphQLArgs) => r.books(a as never, a['extra'] as never)",
    )
  })

  it('parameter defaults become schema defaults when statically evaluable', async () => {
    const result = await schemaOf({
      'src/types.ts': TYPES,
      'src/r.resolver.ts': resolver(`  @Query()
  page(
    @Args('limit') limit: Int = 20,
    @Args('genre') genre: Genre = Genre.Mystery,
    @Args('since') since: number = Date.now(),
    @Args('tags') tags: readonly string[] = ['a', 'b'],
  ): readonly string[] {
    void [limit, genre, since, tags]
    return []
  }`),
    })
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain(
      'page(limit: Int! = 20, genre: Genre! = Mystery, since: Float, tags: [String!]! = ["a", "b"]): [String!]!',
    )
    expect(section(result.code)).toContain("{ ['name']: 'since', ['type']: 'Float', ['nullAsUndefined']: true }")
  })

  it('rejects defaults that do not match their type (ZNIGHT063)', async () => {
    const result = await schemaOf({
      'src/types.ts': `import type { Int } from '@znight/graphql'
export interface Options {
  /** @default "many" */
  readonly limit?: Int
  /** @default 1.5 */
  readonly page?: Int
  /** @default "Unknown" */
  readonly sort?: Sorting
}
export type Sorting = 'title' | 'newest'
`,
      'src/r.resolver.ts': `import { Args, Query, Resolver } from '@znight/graphql'
import type { Options } from './types.ts'

@Resolver()
export class R {
  @Query()
  list(@Args() options: Options, @Args('flag') flag: boolean = 'yes' as never): boolean {
    return options !== undefined && flag
  }
}
`,
    })
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT063 src/r.resolver.ts:7:64 Invalid default value "yes" for Query.list(flag:) (Boolean!): expected a boolean',
      'error ZNIGHT063 src/types.ts:3:7 Invalid default value "many" for Query.list(limit:) (Int): expected a 32-bit integer',
      'error ZNIGHT063 src/types.ts:5:7 Invalid default value 1.5 for Query.list(page:) (Int): expected a 32-bit integer',
      'error ZNIGHT063 src/types.ts:7:7 Invalid default value "Unknown" for Query.list(sort:) (Sorting): expected one of title, newest',
    ])
  })

  it('rejects duplicate argument names (ZNIGHT061)', async () => {
    const result = await schemaOf({
      'src/types.ts': TYPES,
      'src/r.resolver.ts': resolver(`  @Query()
  books(@Args() filter: Filter, @Args('limit') limit: Int): boolean {
    return filter !== undefined && limit > 0
  }`),
    })
    expect(render(result)).toEqual([
      [
        "error ZNIGHT061 src/r.resolver.ts:7:48 Argument 'limit' of Query.books is declared twice",
        '  = Argument names must be unique: rename one of them',
        '  - first declared here (src/types.ts:33:12)',
      ].join('\n'),
    ])
  })

  it('rejects records and index signatures as @Args() objects and object types (ZNIGHT060)', async () => {
    const result = await schemaOf({
      'src/types.ts': `export interface Bag {
  readonly id: string
  readonly [key: string]: string
}
export type Tags = Record<string, string>
`,
      'src/r.resolver.ts': `import { Args, Query, Resolver } from '@znight/graphql'
import type { Bag, Tags } from './types.ts'

@Resolver()
export class R {
  @Query()
  search(@Args() args: Record<string, string>): string {
    return String(args)
  }

  @Query()
  bag(@Args() bag: Bag): string {
    return bag.id
  }

  @Query()
  tags(): Tags {
    return {}
  }
}
`,
    })
    expect(render(result)).toEqual([
      [
        "error ZNIGHT060 src/r.resolver.ts:7:24 @Args() parameter 'args' of Query.search cannot be a record or an index signature: GraphQL arguments are fixed",
        "  = GraphQL objects have fixed fields: declare an interface, or use JSONValue (import type { JSONValue } from '@znight/graphql')",
        "  = @Args('args') declares one argument named 'args'",
      ].join('\n'),
      [
        "error ZNIGHT060 src/r.resolver.ts:12:20 @Args() parameter 'bag' of Query.bag cannot be a record or an index signature: GraphQL arguments are fixed",
        "  = GraphQL objects have fixed fields: declare an interface, or use JSONValue (import type { JSONValue } from '@znight/graphql')",
        "  = @Args('bag') declares one argument named 'bag'",
      ].join('\n'),
      [
        'error ZNIGHT060 src/r.resolver.ts:17:3 Cannot map Tags, a record or an index signature, to a GraphQL type (Query.tags)',
        "  = GraphQL objects have fixed fields: declare an interface, or use JSONValue (import type { JSONValue } from '@znight/graphql')",
      ].join('\n'),
    ])
  })

  it('rejects a deprecated required argument (ZNIGHT063)', async () => {
    const result = await schemaOf({
      'src/r.resolver.ts': `import { Args, Query, Resolver } from '@znight/graphql'

@Resolver()
export class R {
  @Query()
  find(
    /** @deprecated Use code. */
    @Args('id') id: string,
    /** @deprecated Gone. */
    @Args('old') old?: string,
  ): boolean {
    return id !== old
  }
}
`,
    })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT063 src/r.resolver.ts:8:21 Query.find(id:) is required and cannot be deprecated',
        '  = Make it optional (?: T or T | undefined) or give it a default value before deprecating it',
      ].join('\n'),
    ])
  })
})

describe('input types', () => {
  it('maps input object types with @default, nullAsUndefined and nested inputs', async () => {
    const result = await schemaOf({
      'src/types.ts': TYPES.replace(
        'readonly price: Money\n}\n\nexport interface NewBook',
        'readonly price: number\n}\n\nexport interface NewBook',
      ),
      'src/r.resolver.ts': resolver(`${PING}
  @Mutation()
  add(@Args('book') book: NewBook): boolean {
    return book !== undefined
  }`),
    })
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain('input Money {\n  amount: Int!\n  currency: String!\n}')
    expect(result.sdl).toContain('input NewBook {\n  title: String!\n  genre: Genre = Fantasy\n  price: Money!\n}')
    expect(section(result.code)).toContain(
      "{ ['name']: 'genre', ['type']: 'Genre', ['defaultValue']: 'Fantasy', ['nullAsUndefined']: true }",
    )
  })

  it('rejects a declaration used as output and as input, with a fix-it (ZNIGHT063)', async () => {
    const result = await schemaOf({
      'src/types.ts': TYPES,
      'src/r.resolver.ts': resolver(`  @Query()
  book(): Book {
    return null as never
  }

  @Mutation()
  add(@Args('book') book: NewBook): Book {
    return book as never
  }`),
    })
    expect(render(result)).toEqual([
      [
        "error ZNIGHT063 src/types.ts:10:18 'Money' is used as an output type (Book.price) and as an input type (NewBook.price)",
        '  = GraphQL needs two types: declare `export interface MoneyInput extends Money {}` and use it in NewBook',
        '  - used as output: Book.price (src/types.ts:17:19)',
        '  - used as input: NewBook.price (src/types.ts:24:19)',
      ].join('\n'),
    ])
  })

  it('rejects unions in input position (ZNIGHT063)', async () => {
    const result = await schemaOf({
      'src/types.ts': `export interface A { readonly kind: 'a' }
export interface B { readonly kind: 'b' }
export type AorB = A | B
export interface Input { readonly value: AorB }
`,
      'src/r.resolver.ts': `import { Args, Query, Resolver } from '@znight/graphql'
import type { Input } from './types.ts'

@Resolver()
export class R {
  @Query()
  take(@Args('input') input: Input): boolean {
    return input !== undefined
  }
}
`,
    })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT063 src/types.ts:4:42 Input.value is the union AorB: unions cannot be input values',
        '  = Declare one input type with optional fields, or one argument per case',
        '  - reached from Query.take(input) → Input (src/r.resolver.ts:7:3)',
      ].join('\n'),
    ])
  })

  it('rejects cycles of non-null input fields; nullable or list fields break them (ZNIGHT063)', async () => {
    const result = await schemaOf({
      'src/types.ts': `export interface Node { readonly next: Link }
export interface Link { readonly node: Node }
export interface Tree { readonly children: readonly Tree[]; readonly parent?: Tree }
export interface Input { readonly node: Node; readonly tree: Tree }
`,
      'src/r.resolver.ts': `import { Args, Query, Resolver } from '@znight/graphql'
import type { Input } from './types.ts'

@Resolver()
export class R {
  @Query()
  take(@Args('input') input: Input): boolean {
    return input !== undefined
  }
}
`,
    })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT063 src/types.ts:1:18 The input types Node → Link → Node reference each other through non-null fields: no value can be written',
        '  = Make one of the fields of the cycle optional (?: T) or a list',
      ].join('\n'),
    ])
  })
})
