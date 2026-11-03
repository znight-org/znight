/**
 * Naming (RFC 0005 §6.4): declaration names, alias names, generic instances, `@gqlName`, reserved
 * and invalid names, and conflicts across files and root fields (ZNIGHT061).
 */
import { cleanupApps, render, schemaOf } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

/** A resolver whose `@Query() value()` returns `type`, with `types` in `src/types.ts`. */
function app(type: string, types: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    'src/types.ts': types,
    'src/r.resolver.ts': `import { Query, Resolver } from '@znight/graphql'
import type * as T from './types.ts'

@Resolver()
export class R {
  @Query()
  value(): ${type} {
    return null as never
  }
}
`,
    ...extra,
  }
}

describe('type names', () => {
  it('@gqlName names a declaration (interfaces, enums, aliases, generic instances)', async () => {
    const result = await schemaOf(
      app(
        'T.Holder',
        `/** @gqlName Item */
export interface Thing { readonly id: string }

/** @gqlName Kind */
export enum Category { A = 'a' }

/**
 * Pages.
 * @gqlName ThingList
 */
export type Things = Page<Thing>

export interface Page<T> { readonly items: readonly T[] }

export interface Holder {
  readonly thing: Thing
  readonly category: Category
  readonly things: Things
}
`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain('type Holder {\n  thing: Item!\n  category: Kind!\n  things: ThingList!\n}')
    expect(result.sdl).toContain('type Item {')
    expect(result.sdl).toContain('enum Kind {')
    expect(result.sdl).toContain('"""Pages."""\ntype ThingList {\n  items: [Item!]!\n}')
  })

  it('names generic instances with scalar and list-free arguments', async () => {
    const result = await schemaOf(
      app(
        'T.Holder',
        `import type { ID, Int } from '@znight/graphql'

export interface Box<T> { readonly value: T }
export interface Pair<A, B> { readonly a: A; readonly b: B }

export interface Holder {
  readonly strings: Box<string>
  readonly ids: Box<ID>
  readonly counts: Box<Int>
  readonly pair: Pair<Box<string>, Int>
}
`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain(
      'type Holder {\n  strings: StringBox!\n  ids: IDBox!\n  counts: IntBox!\n  pair: StringBoxIntPair!\n}',
    )
  })

  it('rejects list type arguments without alias (ZNIGHT060)', async () => {
    const result = await schemaOf(app('T.Box<readonly string[]>', 'export interface Box<T> { readonly value: T }\n'))
    expect(render(result)).toEqual([
      [
        'error ZNIGHT060 src/types.ts:1:18 Cannot name the GraphQL type of Box<...> (Query.value): its type argument string[] has no GraphQL name',
        '  = Name the instance with an alias (export type BookPages = Box<...>) or with /** @gqlName Name */',
      ].join('\n'),
    ])
  })

  it('rejects two declarations with one GraphQL name, showing both (ZNIGHT061)', async () => {
    const result = await schemaOf(
      app(
        'T.Holder',
        `import type { Review as Other } from './other.ts'

export interface Review { readonly id: string }

export interface Holder {
  readonly a: Review
  readonly b: Other
}
`,
        { 'src/other.ts': 'export interface Review {\n  readonly stars: number\n}\n' },
      ),
    )
    expect(render(result)).toEqual([
      [
        "error ZNIGHT061 src/other.ts:1:18 Two types are named 'Review' in the GraphQL schema: src/other.ts#Review and src/types.ts#Review",
        '  = Rename one of them, or name one with /** @gqlName OtherName */',
        '  - the other declaration (src/types.ts:3:18)',
        '  - reached from Query.value → Holder (src/r.resolver.ts:7:3)',
      ].join('\n'),
    ])
  })

  it('rejects reserved and invalid names (ZNIGHT061)', async () => {
    const result = await schemaOf(
      app(
        'T.Holder',
        `export interface Query { readonly id: string }

/** @gqlName __Hidden */
export interface Secret { readonly id: string }

/** @gqlName String */
export interface Text { readonly id: string }

export enum Flag {
  'two words' = 'a',
  true = 'b',
}

export interface Holder {
  readonly query: Query
  readonly secret: Secret
  readonly text: Text
  readonly flag: Flag
}
`,
      ),
    )
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      "error ZNIGHT061 src/types.ts:1:18 'Query' is the name of a root operation type (src/types.ts#Query)",
      "error ZNIGHT061 src/types.ts:4:18 '__Hidden' is not a valid GraphQL type name (src/types.ts#Secret)",
      "error ZNIGHT061 src/types.ts:7:18 'String' is the name of a specified GraphQL scalar (src/types.ts#Text)",
      "error ZNIGHT061 src/types.ts:10:3 'two words' of Flag is not a valid GraphQL enum value",
      "error ZNIGHT061 src/types.ts:11:3 'true' of Flag is not a valid GraphQL enum value",
    ])
  })

  it('rejects invalid field names, unless hidden', async () => {
    const result = await schemaOf(
      app(
        'T.Holder',
        `export interface Holder {
  readonly 'kebab-case': string
  /** @gqlHidden */
  readonly 'hidden-one': string
  readonly ok: string
}
`,
      ),
    )
    expect(render(result)).toEqual([
      [
        "error ZNIGHT061 src/types.ts:2:12 'kebab-case' is not a valid GraphQL field name (Holder.kebab-case)",
        '  = GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __',
        '  = Hide the property with /** @gqlHidden */',
        '  - reached from Query.value → Holder (src/r.resolver.ts:7:3)',
      ].join('\n'),
    ])
  })
})

describe('root fields', () => {
  it('rejects two root fields with one name across resolvers (ZNIGHT061)', async () => {
    const resolver = (name: string): string => `import { Query, Resolver } from '@znight/graphql'

@Resolver()
export class ${name} {
  @Query('ping')
  check(): boolean {
    return true
  }
}
`
    const result = await schemaOf({ 'src/a.resolver.ts': resolver('A'), 'src/b.resolver.ts': resolver('B') })
    expect(render(result)).toEqual([
      [
        'error ZNIGHT061 src/b.resolver.ts:5:3 Two root fields are named Query.ping: B.check and A.check',
        "  = Rename one of them: @Query('otherName')",
        '  - the other field (src/a.resolver.ts:5:3)',
      ].join('\n'),
    ])
  })

  it('names root fields after the decorator argument, or the method', async () => {
    const result = await schemaOf({
      'src/r.resolver.ts': `import { Mutation, Query, Resolver } from '@znight/graphql'

@Resolver()
export class R {
  @Query('allBooks')
  books(): readonly string[] {
    return []
  }

  @Query()
  count(): number {
    return 0
  }

  @Mutation('reset')
  @Mutation()
  clear(): boolean {
    return true
  }
}
`,
    })
    expect(render(result)).toEqual([])
    expect(result.sdl).toBe(
      'type Mutation {\n  reset: Boolean!\n  clear: Boolean!\n}\n\ntype Query {\n  allBooks: [String!]!\n  count: Float!\n}\n',
    )
  })

  it('rejects invalid field names in decorators (ZNIGHT061)', async () => {
    const result = await schemaOf({
      'src/r.resolver.ts': `import { Query, Resolver } from '@znight/graphql'

@Resolver()
export class R {
  @Query('all-books')
  books(): boolean {
    return true
  }
}
`,
    })
    expect(render(result)).toEqual([
      [
        "error ZNIGHT061 src/r.resolver.ts:5:10 'all-books' is not a valid GraphQL field name (R.books)",
        '  = GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __',
      ].join('\n'),
    ])
  })

  it('rejects method names that are not valid GraphQL field names (ZNIGHT061)', async () => {
    const result = await schemaOf({
      'src/r.resolver.ts': `import { Query, Resolver } from '@znight/graphql'

@Resolver()
export class R {
  @Query()
  $search(): boolean {
    return true
  }

  @Query()
  __meta(): boolean {
    return true
  }

  @Query('meta')
  __renamed(): boolean {
    return true
  }
}
`,
    })
    expect(render(result)).toEqual([
      [
        "error ZNIGHT061 src/r.resolver.ts:5:3 '$search' is not a valid GraphQL field name (R.$search): name the field in the decorator",
        '  = GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __',
        "  = @Query('validName')",
      ].join('\n'),
      [
        "error ZNIGHT061 src/r.resolver.ts:10:3 '__meta' is not a valid GraphQL field name (R.__meta): name the field in the decorator",
        '  = GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __',
        "  = @Query('validName')",
      ].join('\n'),
    ])
  })
})
