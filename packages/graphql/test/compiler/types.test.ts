/**
 * Unions and their discriminators (ZNIGHT064), custom scalars, JSDoc (descriptions, `@param`,
 * `@deprecated`, `@gqlHidden`) and field resolvers (replacing or adding fields, ZNIGHT061, unreachable
 * parents).
 */
import { cleanupApps, render, schemaOf, section } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

/** A resolver with `@Query() value(): <type>`. */
function app(type: string, types: string, resolverBody = ''): Record<string, string> {
  return {
    'src/types.ts': types,
    'src/r.resolver.ts': `import { Args, Parent, Query, ResolveField, Resolver } from '@znight/graphql'
import type * as T from './types.ts'

@Resolver()
export class R {
  @Query()
  value(): ${type} {
    return null as never
  }
${resolverBody}
}

void [Args, Parent, ResolveField]
`,
  }
}

describe('unions', () => {
  it('tells members apart by a literal property', async () => {
    const result = await schemaOf(
      app(
        'readonly T.Hit[]',
        `export interface Book { readonly kind: 'book'; readonly title: string }
export interface Author { readonly kind: 'author'; readonly name: string }
/** A search hit. */
export type Hit = Book | Author
`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain('"""A search hit."""\nunion Hit = Author | Book')
    expect(section(result.code)).toContain(
      "['by']: 'property',\n            ['property']: 'kind',\n            ['values']: { ['author']: 'Author', ['book']: 'Book' },",
    )
  })

  it('tells exported classes apart with instanceof, subclasses first', async () => {
    const result = await schemaOf(
      app(
        'T.Shape | null',
        `export class Circle { readonly radius!: number }
export class Square { readonly side!: number }
export class Big extends Square { readonly huge!: boolean }
export type Shape = Circle | Square | Big
`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain('union Shape = Big | Circle | Square')
    expect(result.sdl).toContain('value: Shape\n')
    expect(section(result.code)).toContain(
      "['discriminator']: { ['by']: 'class', ['classes']: [[Big, 'Big'], [Circle, 'Circle'], [Square, 'Square']] }",
    )
    expect(result.code).toContain("import { Big, Circle, Square } from '../types.js'")
  })

  it('tells members apart by __typename', async () => {
    const result = await schemaOf(
      app(
        'T.Pet',
        `export interface Cat { readonly __typename: 'Cat'; readonly lives: number }
export interface Dog { readonly __typename: string; readonly barks: boolean }
export type Pet = Cat | Dog
`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain('type Cat {\n  lives: Float!\n}')
    expect(section(result.code)).toContain("['discriminator']: { ['by']: 'typename' }")
  })

  it('reports members that cannot be told apart (ZNIGHT064)', async () => {
    const result = await schemaOf(
      app(
        'T.SearchResult',
        `export interface Book { readonly kind: string; readonly title: string }
export interface Author { readonly name: string }
export type SearchResult = Book | Author
`,
      ),
    )
    expect(render(result)).toEqual([
      [
        'error ZNIGHT064 src/types.ts:3:13 The members of union SearchResult cannot be told apart at runtime: Author and Book have no common literal property',
        "  = Add a literal property to each member (readonly kind: 'author' / readonly kind: 'book'), or make the members classes",
      ].join('\n'),
    ])
  })

  it('reports duplicated literal values and unions of scalars', async () => {
    const duplicated = await schemaOf(
      app(
        'T.U',
        `export interface A { readonly kind: 'x' }
export interface B { readonly kind: 'x' }
export type U = A | B
`,
      ),
    )
    expect(render(duplicated).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT064 src/types.ts:3:13 The members of union U cannot be told apart at runtime: A and B have no common literal property',
    ])
    const scalars = await schemaOf(
      app('T.U', 'export interface A { readonly a: string }\nexport type U = A | string\n'),
    )
    expect(render(scalars).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT060 src/r.resolver.ts:7:3 Cannot map the union A | string to a GraphQL type (Query.value)',
    ])
  })
})

describe('custom scalars', () => {
  const SCALARS = `import { scalar } from '@znight/graphql'

/** An e-mail address. */
export type EmailAddress = string & { readonly __brand: 'EmailAddress' }

export const EmailAddressScalar = scalar<EmailAddress>('EmailAddress', {
  description: 'An e-mail address',
  specifiedByURL: 'https://html.spec.whatwg.org/#valid-e-mail-address',
  serialize: value => value,
  parseValue: value => value as EmailAddress,
})

export const UrlScalar = scalar<URL>('URL', { serialize: value => value.href, parseValue: value => new URL(String(value)) })

export const Base64 = scalar<Uint8Array>('Base64', {
  serialize: value => Buffer.from(value).toString('base64'),
  parseValue: value => Buffer.from(String(value), 'base64'),
})

export interface Contact {
  readonly email: EmailAddress
  readonly site: URL | null
  readonly avatar: Uint8Array
}
`

  it('maps the type of scalar<T>() to the scalar, with its static description and URL', async () => {
    const result = await schemaOf(app('T.Contact', SCALARS))
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain('type Contact {\n  email: EmailAddress!\n  site: URL\n  avatar: Base64!\n}')
    expect(result.sdl).toContain(
      '"""An e-mail address"""\nscalar EmailAddress @specifiedBy(url: "https://html.spec.whatwg.org/#valid-e-mail-address")',
    )
    expect(result.sdl).toContain('scalar URL\n')
    const code = section(result.code)
    expect(code).toContain("{ ['kind']: 'scalar', ['name']: 'EmailAddress', ['scalar']: EmailAddressScalar }")
    expect(code).toContain("{ ['kind']: 'scalar', ['name']: 'URL', ['scalar']: UrlScalar }")
  })

  it('reports unexported, unnamed and conflicting scalars', async () => {
    const result = await schemaOf(
      app(
        'string',
        `import { scalar } from '@znight/graphql'
export type A = string & { readonly __a: true }
const Hidden = scalar<A>('A', { serialize: value => value, parseValue: value => value as A })
export const Inline = scalar<{ a: string }>('Inline', { serialize: value => value, parseValue: value => value as never })
export const Reserved = scalar<A>('String', { serialize: value => value, parseValue: value => value as A })
void Hidden
`,
      ),
    )
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT005 src/types.ts:3:16 The scalar Hidden must be exported: the generated module imports it',
      "error ZNIGHT060 src/types.ts:4:23 scalar('Inline') of Inline needs a named type argument: scalar<T>('Inline', ...)",
      "error ZNIGHT061 src/types.ts:5:35 'String' is a specified GraphQL scalar: scalar() cannot redefine it (Reserved)",
    ])
  })
})

describe('JSDoc', () => {
  it('reads descriptions, @param, @deprecated and @gqlHidden', async () => {
    const result = await schemaOf(
      app(
        'T.Book',
        `/**
 * A book.
 *
 * With a second paragraph.
 */
export interface Book {
  /** The title. */
  readonly title: string
  /** @deprecated */
  readonly old?: string
  /**
   * Use \`title\`.
   * @deprecated Use \`title\`.
   */
  readonly name?: string
  /** @gqlHidden */
  readonly secret: string
  readonly genre: Genre
}

/** Genres. */
export enum Genre {
  /** Dragons. */
  Fantasy = 'fantasy',
  /** @deprecated Merged into Fantasy. */
  Myth = 'myth',
}

export class Summary {
  readonly text!: string
  /** @gqlHidden */
  get length(): number {
    return this.text.length
  }
}
`,
        `
  /**
   * Books by author.
   * @param author The author.
   * @param limit - At most this many.
   * @deprecated Use value.
   */
  @Query()
  byAuthor(@Args('author') author: string, @Args('max') limit?: number, /** Skipped. */ @Args('skip') skip?: number): readonly T.Book[] {
    void [author, limit, skip]
    return []
  }

  @Query()
  summary(): T.Summary {
    return null as never
  }`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain(
      [
        '"""',
        'A book.',
        '',
        'With a second paragraph.',
        '"""',
        'type Book {',
        '  """The title."""',
        '  title: String!',
        '  old: String @deprecated',
        '',
        '  """Use `title`."""',
        '  name: String @deprecated(reason: "Use `title`.")',
        '  genre: Genre!',
        '}',
      ].join('\n'),
    )
    expect(result.sdl).toContain(
      [
        '"""Genres."""',
        'enum Genre {',
        '  """Dragons."""',
        '  Fantasy',
        '  Myth @deprecated(reason: "Merged into Fantasy.")',
        '}',
      ].join('\n'),
    )
    expect(result.sdl).toContain(
      [
        '  """Books by author."""',
        '  byAuthor(',
        '    """The author."""',
        '    author: String!',
        '',
        '    """At most this many."""',
        '    max: Float',
        '',
        '    """Skipped."""',
        '    skip: Float',
        '  ): [Book!]! @deprecated(reason: "Use value.")',
      ].join('\n'),
    )
    expect(result.sdl).toContain('type Summary {\n  text: String!\n}')
  })
})

describe('field resolvers', () => {
  const TYPES = `export interface Book { readonly id: string; readonly authorId: string; readonly rating: number }
export interface Author { readonly name: string }
export interface Orphan { readonly id: string }
`

  it('adds fields after the properties and replaces properties in place', async () => {
    const result = await schemaOf(
      app(
        'T.Book',
        TYPES,
        `
  /** Who wrote it. */
  @ResolveField()
  author(@Parent() book: T.Book): T.Author {
    void book
    return null as never
  }

  /** Average rating. */
  @ResolveField()
  rating(@Parent() book: T.Book, @Args('precision') precision?: number): number {
    void precision
    return book.rating
  }`,
      ),
    )
    expect(render(result)).toEqual([])
    expect(result.sdl).toContain(
      [
        'type Book {',
        '  id: String!',
        '  authorId: String!',
        '',
        '  """Average rating."""',
        '  rating(precision: Float): Float!',
        '',
        '  """Who wrote it."""',
        '  author: Author!',
        '}',
      ].join('\n'),
    )
  })

  it('rejects a field resolver whose type differs from the property it replaces (ZNIGHT061)', async () => {
    const result = await schemaOf(
      app(
        'T.Book',
        TYPES,
        `
  @ResolveField('rating')
  stars(@Parent() book: T.Book): string {
    return String(book.rating)
  }`,
      ),
    )
    expect(render(result)).toEqual([
      [
        'error ZNIGHT061 src/r.resolver.ts:11:3 @ResolveField R.stars returns String!, but the property Book.rating is Float!',
        '  = A field resolver replacing a property must resolve the same GraphQL type: change its return type, or rename the field',
        '  - the property (src/types.ts:1:82)',
      ].join('\n'),
    ])
  })

  it('warns about field resolvers whose parent is not reachable, and rejects non-object parents (ZNIGHT062)', async () => {
    const result = await schemaOf(
      app(
        'T.Book',
        TYPES,
        `
  @ResolveField()
  extra(@Parent() orphan: T.Orphan): string {
    return orphan.id
  }

  @ResolveField()
  bad(@Parent() text: string): string {
    return text
  }`,
      ),
    )
    expect(render(result)).toEqual([
      [
        'warning ZNIGHT062 src/r.resolver.ts:11:3 @ResolveField R.extra adds a field to Orphan, which no root field reaches as an output type: it is not part of the schema',
        '  = Return Orphan from a @Query (or another reachable field), or remove the field resolver',
      ].join('\n'),
      [
        "error ZNIGHT062 src/r.resolver.ts:17:23 The @Parent() parameter 'text' of R.bad must have an object type, not string",
        '  = The parent type is the object type the field is added to: an interface, a class or a named alias of an object type',
      ].join('\n'),
    ])
  })
})
