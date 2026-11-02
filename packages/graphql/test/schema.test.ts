import type { GraphQLMetadata, GraphQLTypeDefinition } from '../src/index.ts'

import { ErrorCode } from '@znight/core'
import { GraphQLScalarType, printSchema } from 'graphql'

import { scalar } from '../src/index.ts'
import { buildGraphQLSchema, checkGraphQLSection } from '../src/schema.ts'
import { printSdl } from '../src/sdl.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

class Catalog {
  books(args: { genre?: string; limit?: number }): unknown[] {
    const books = [
      { kind: 'book', id: '1', title: 'Dune', genre: 'science-fiction', createdAt: new Date(0), views: 12n },
      { kind: 'book', id: '2', title: 'The Hobbit', genre: 'fantasy', createdAt: new Date(1000), views: 3n },
    ]
    return books.filter(book => args.genre === undefined || book.genre === args.genre).slice(0, args.limit)
  }

  search(args: { text: string }): unknown[] {
    return [
      { kind: 'book', id: '1', title: args.text },
      { kind: 'author', id: 'a1', name: 'Frank Herbert' },
    ]
  }

  echo(args: { at: Date; big: bigint; json: unknown; email: string }): string {
    return `${args.at.toISOString()} ${args.big + 1n} ${JSON.stringify(args.json)} ${args.email}`
  }
}

const EmailScalar = scalar<string>('Email', {
  serialize: value => value,
  parseValue: value => {
    if (typeof value !== 'string' || !value.includes('@')) throw new TypeError('Expected an e-mail address')
    return value.toLowerCase()
  },
})

const catalogTypes: readonly GraphQLTypeDefinition[] = [
  {
    kind: 'object',
    name: 'Book',
    description: 'A book of the catalog.',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'genre', type: 'Genre' },
      { name: 'createdAt', type: 'DateTime' },
      { name: 'views', type: 'BigInt', deprecationReason: 'Use stats.' },
    ],
  },
  {
    kind: 'object',
    name: 'Author',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'name', type: 'String!' },
    ],
  },
  {
    kind: 'enum',
    name: 'Genre',
    values: [
      { name: 'Fantasy', value: 'fantasy' },
      { name: 'ScienceFiction', value: 'science-fiction', description: 'Space!' },
    ],
  },
  {
    kind: 'union',
    name: 'SearchResult',
    members: ['Author', 'Book'],
    discriminator: { by: 'property', property: 'kind', values: { author: 'Author', book: 'Book' } },
  },
  { kind: 'scalar', name: 'DateTime', builtin: true },
  { kind: 'scalar', name: 'BigInt', builtin: true },
  { kind: 'scalar', name: 'JSON', builtin: true },
  { kind: 'scalar', name: 'Email', scalar: EmailScalar },
  {
    kind: 'object',
    name: 'Query',
    fields: [
      field('books', '[Book!]!', bind(Catalog, 'books'), {
        args: [
          { name: 'genre', type: 'Genre' },
          { name: 'limit', type: 'Int', defaultValue: 20 },
        ],
      }),
      field('search', '[SearchResult!]!', bind(Catalog, 'search'), { args: [{ name: 'text', type: 'String!' }] }),
      field('echo', 'String!', bind(Catalog, 'echo'), {
        args: [
          { name: 'at', type: 'DateTime!' },
          { name: 'big', type: 'BigInt!' },
          { name: 'json', type: 'JSON' },
          { name: 'email', type: 'Email!' },
        ],
      }),
    ],
  },
]

const catalog = (): ReturnType<typeof graphqlMetadata> => graphqlMetadata({ providers: [Catalog], types: catalogTypes })

function section(types: readonly unknown[], extra: Record<string, unknown> = {}): GraphQLMetadata {
  return { version: 1, schemaHash: 'x', roots: { query: 'Query' }, types, ...extra } as unknown as GraphQLMetadata
}

const QUERY = { kind: 'object', name: 'Query', fields: [{ name: 'ok', type: 'Boolean' }] }

describe('schema', () => {
  it('builds the schema of the metadata, printed like printSdl()', async () => {
    await using booted = await boot(catalog())
    const metadataSection = booted.app.metadata.extensions?.graphql as GraphQLMetadata
    const sdl = booted.plugin.printSchema()
    expect(sdl).toBe(printSdl({ roots: metadataSection.roots, types: metadataSection.types }))
    expect(sdl).toContain('scalar DateTime @specifiedBy(url: "https://datatracker.ietf.org/doc/html/rfc3339")')
    expect(sdl).toContain('books(genre: Genre, limit: Int = 20): [Book!]!')
    expect(sdl).toContain('views: BigInt @deprecated(reason: "Use stats.")')
    expect(printSchema(booted.plugin.schema)).toBe(sdl)
  })

  it('maps enums to their internal values, both ways', async () => {
    await using booted = await boot(catalog())
    const result = await booted.plugin.execute({ query: '{ books(genre: Fantasy) { title genre } }' })
    expect(result).toEqual({ data: { books: [{ title: 'The Hobbit', genre: 'Fantasy' }] } })
  })

  it('applies argument defaults', async () => {
    await using booted = await boot(catalog())
    const result = await booted.plugin.execute({ query: '{ books { id } }' })
    expect(result).toEqual({ data: { books: [{ id: '1' }, { id: '2' }] } })
  })

  it('resolves union members with the property discriminator', async () => {
    await using booted = await boot(catalog())
    const result = await booted.plugin.execute({
      query: '{ search(text: "x") { __typename ... on Book { title } ... on Author { name } } }',
    })
    expect(result).toEqual({
      data: {
        search: [
          { __typename: 'Book', title: 'x' },
          { __typename: 'Author', name: 'Frank Herbert' },
        ],
      },
    })
  })

  it('resolves union members with classes and __typename', () => {
    class Dog {
      readonly name = 'Rex'
    }
    class Cat {
      readonly name = 'Tom'
    }
    const types = (discriminator: unknown) =>
      section([
        { kind: 'object', name: 'Dog', fields: [{ name: 'name', type: 'String' }] },
        { kind: 'object', name: 'Cat', fields: [{ name: 'name', type: 'String' }] },
        { kind: 'union', name: 'Pet', members: ['Cat', 'Dog'], discriminator },
        { kind: 'object', name: 'Query', fields: [{ name: 'pet', type: 'Pet' }] },
      ])
    const byClass = buildGraphQLSchema(
      types({
        by: 'class',
        classes: [
          [Dog, 'Dog'],
          [Cat, 'Cat'],
        ],
      }),
      () => ({}),
    )
    const pet = byClass.getType('Pet') as unknown as { resolveType: (value: unknown) => unknown }
    expect(pet.resolveType(new Cat())).toBe('Cat')
    expect(pet.resolveType(new Dog())).toBe('Dog')
    const byTypename = buildGraphQLSchema(types({ by: 'typename' }), () => ({}))
    const pet2 = byTypename.getType('Pet') as unknown as { resolveType: (value: unknown) => unknown }
    expect(pet2.resolveType({ __typename: 'Dog' })).toBe('Dog')
    expect(pet2.resolveType('not an object')).toBeUndefined()
  })

  it('coerces the built-in scalars and user scalars', async () => {
    await using booted = await boot(catalog())
    const ok = await booted.plugin.execute({
      query: 'query($at: DateTime!) { echo(at: $at, big: "9007199254740993", json: {a: [1, true]}, email: "A@B.C") }',
      variables: { at: '2026-11-02T10:00:00+01:00' },
    })
    expect(ok).toEqual({ data: { echo: '2026-11-02T09:00:00.000Z 9007199254740994 {"a":[1,true]} a@b.c' } })
    const books = await booted.plugin.execute({ query: '{ books(limit: 1) { createdAt views } }' })
    expect(books).toEqual({ data: { books: [{ createdAt: '1970-01-01T00:00:00.000Z', views: '12' }] } })
    const bad = await booted.plugin.execute({
      query: 'query($at: DateTime!) { echo(at: $at, big: "1", email: "nope") }',
      variables: { at: '2026-11-02' },
    })
    expect(bad.errors?.map(error => error.extensions?.['code'])).toEqual(['GRAPHQL_VALIDATION_FAILED'])
    const badVariable = await booted.plugin.execute({
      query: 'query($at: DateTime!) { echo(at: $at, big: "1", email: "a@b") }',
      variables: { at: '2026-11-02' },
    })
    expect(badVariable.errors?.[0]?.extensions?.['code']).toBe('BAD_USER_INPUT')
    expect(badVariable.errors?.[0]?.message).toContain('RFC 3339')
  })

  it('accepts a graphql-js scalar whose name matches', () => {
    const url = new GraphQLScalarType({ name: 'URL' })
    const schema = buildGraphQLSchema(
      section([
        { kind: 'scalar', name: 'URL', scalar: url },
        { kind: 'object', name: 'Query', fields: [{ name: 'home', type: 'URL' }] },
      ]),
      () => ({}),
    )
    expect(schema.getType('URL')).toBe(url)
  })

  it('reports every structural problem in one ZNIGHT066 error', () => {
    const problems = checkGraphQLSection(
      section([
        QUERY,
        { kind: 'object', name: 'Query', fields: [{ name: 'dup', type: 'String' }] },
        {
          kind: 'object',
          name: 'Book',
          fields: [
            { name: 'author', type: 'Author!' },
            { name: 'bad', type: '[Int' },
          ],
        },
        { kind: 'input', name: 'In', fields: [{ name: 'book', type: 'Book' }] },
        { kind: 'enum', name: 'E', values: [{ name: 'true', value: 1 }] },
        { kind: 'union', name: 'U', members: ['E'], discriminator: { by: 'nope' } },
        { kind: 'scalar', name: 'Money', scalar: {} },
        { kind: 'scalar', name: 'Wrong', scalar: new GraphQLScalarType({ name: 'Other' }) },
        { kind: 'scalar', name: 'Decimal', builtin: true },
        {
          kind: 'object',
          name: 'Thing',
          fields: [
            { name: 'x', type: 'Int', resolver: { token: '', method: 1, operation: 'other', guards: [1], meta: null } },
          ],
        },
      ]),
    )
    expect(problems).toEqual([
      'the type Query is declared twice',
      'Book.author: unknown type Author',
      'Book.bad: invalid type reference "[Int"',
      'In fields.book: Book (object) cannot be used as an input type',
      'E: invalid enum value {"name":"true","value":1} (expected { name, value: string | number })',
      'U: the member "E" is not an object type',
      'U: unknown discriminator "nope"',
      'the scalar Money needs a definition { serialize, parseValue, parseLiteral? } or a GraphQLScalarType (received {})',
      'the scalar Wrong is implemented by the graphql-js scalar Other (names must match)',
      'Decimal is not a built-in scalar (BigInt, DateTime, JSON)',
      'Thing.x: invalid resolver binding (token, method, operation, guards, meta, invoke)',
    ])
    expect(() => buildGraphQLSchema(section([{ kind: 'object', name: 'Query', fields: [] }]), () => ({}))).toThrow(
      expect.objectContaining({ code: ErrorCode.InvalidGraphQLSetup }),
    )
  })

  it('checks the version, the roots and subscription resolvers', () => {
    expect(checkGraphQLSection({ ...section([QUERY]), version: 2 })[0]).toContain('unsupported version 2')
    expect(checkGraphQLSection(section([QUERY], { roots: { query: 'Missing' } }))).toEqual([
      'the query root "Missing" is not an object type',
    ])
    expect(
      checkGraphQLSection(
        section([QUERY, { kind: 'object', name: 'Subscription', fields: [{ name: 'tick', type: 'Int' }] }], {
          roots: { query: 'Query', subscription: 'Subscription' },
        }),
      ),
    ).toEqual(['Subscription."tick" needs a subscription resolver (its source event stream)'])
    expect(checkGraphQLSection('nope')).toEqual(['expected an object (received "nope")'])
  })

  it('reports graphql-js schema validation errors', () => {
    let error: unknown
    try {
      buildGraphQLSchema(
        section([
          {
            kind: 'object',
            name: 'Query',
            fields: [{ name: 'ok', type: 'Boolean', args: [{ name: 'x', type: 'Int!', deprecationReason: 'old' }] }],
          },
        ]),
        () => ({}),
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: ErrorCode.InvalidGraphQLSetup })
    expect(String((error as Error).message)).toContain('Required argument Query.ok(x:) cannot be deprecated.')
  })

  it('fails the boot without a GraphQL section', async () => {
    const metadata = { ...graphqlMetadata({ types: [] }), extensions: {} }
    await expect(boot(metadata)).rejects.toMatchObject({ code: ErrorCode.InvalidGraphQLSetup })
  })
})
