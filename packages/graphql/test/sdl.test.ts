import {
  buildSchema,
  type GraphQLArgumentConfig,
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLFieldConfig,
  GraphQLFloat,
  GraphQLID,
  type GraphQLInputFieldConfig,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  Kind,
  print,
  printSchema,
} from 'graphql'

import { BUILTIN_SCALARS, SPECIFIED_SCALARS } from '../src/names.ts'
import { schemaHash } from '../src/schema-hash.ts'
import {
  printSdl,
  type SdlInputValue,
  type SdlSchema,
  printBlockString as sdlPrintBlockString,
  printString as sdlPrintString,
} from '../src/sdl.ts'
import { type GraphQLTypeRef, parseTypeRef } from '../src/type-ref.ts'
import { describe, expect, it } from 'bun:test'

/**
 * Builds the graphql-js schema equivalent to a model, the way the runtime does: graphql-js
 * constructors, every type passed in model order, defaults as `default: { value }` (external
 * values: enum names), built-in scalars without description nor `valueToLiteral`.
 */
function toGraphQLSchema(model: SdlSchema): GraphQLSchema {
  const named = new Map<string, GraphQLNamedType>([
    ['String', GraphQLString],
    ['Int', GraphQLInt],
    ['Float', GraphQLFloat],
    ['Boolean', GraphQLBoolean],
    ['ID', GraphQLID],
  ])
  const lookup = (name: string): GraphQLNamedType => {
    const type = named.get(name)
    if (type === undefined) throw new Error(`unknown type ${name}`)
    return type
  }
  const typeOf = (ref: GraphQLTypeRef): GraphQLInputType & GraphQLOutputType => {
    const inner = ref.kind === 'named' ? lookup(ref.name) : new GraphQLList(typeOf(ref.of))
    return (ref.nonNull ? new GraphQLNonNull(inner) : inner) as GraphQLInputType & GraphQLOutputType
  }
  const parse = (text: string): GraphQLTypeRef => {
    const ref = parseTypeRef(text)
    if (ref === undefined) throw new Error(`bad type ${text}`)
    return ref
  }
  const inputValue = (value: SdlInputValue): GraphQLArgumentConfig & GraphQLInputFieldConfig => ({
    type: typeOf(parse(value.type)),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.deprecationReason === undefined ? {} : { deprecationReason: value.deprecationReason }),
    ...(value.defaultValue === undefined ? {} : { default: { value: value.defaultValue } }),
  })
  for (const type of model.types) {
    const description = type.description === undefined ? {} : { description: type.description }
    switch (type.kind) {
      case 'object':
        named.set(
          type.name,
          new GraphQLObjectType({
            name: type.name,
            ...description,
            fields: () =>
              Object.fromEntries(
                type.fields.map((field): [string, GraphQLFieldConfig<unknown, unknown>] => [
                  field.name,
                  {
                    type: typeOf(parse(field.type)),
                    ...(field.description === undefined ? {} : { description: field.description }),
                    ...(field.deprecationReason === undefined ? {} : { deprecationReason: field.deprecationReason }),
                    ...(field.args === undefined
                      ? {}
                      : { args: Object.fromEntries(field.args.map(arg => [arg.name, inputValue(arg)])) }),
                  },
                ]),
              ),
          }),
        )
        break
      case 'input':
        named.set(
          type.name,
          new GraphQLInputObjectType({
            name: type.name,
            ...description,
            fields: () => Object.fromEntries(type.fields.map(field => [field.name, inputValue(field)])),
          }),
        )
        break
      case 'enum':
        named.set(
          type.name,
          new GraphQLEnumType({
            name: type.name,
            ...description,
            values: Object.fromEntries(
              type.values.map(value => [
                value.name,
                {
                  value: `internal:${value.name}`,
                  ...(value.description === undefined ? {} : { description: value.description }),
                  ...(value.deprecationReason === undefined ? {} : { deprecationReason: value.deprecationReason }),
                },
              ]),
            ),
          }),
        )
        break
      case 'union':
        named.set(
          type.name,
          new GraphQLUnionType({
            name: type.name,
            ...description,
            types: () => type.members.map(member => lookup(member) as GraphQLObjectType),
          }),
        )
        break
      case 'scalar': {
        const builtin = type.builtin === true ? BUILTIN_SCALARS.get(type.name) : undefined
        const specifiedByURL = type.specifiedByURL ?? builtin?.specifiedByURL
        named.set(
          type.name,
          new GraphQLScalarType({
            name: type.name,
            ...description,
            ...(specifiedByURL === undefined ? {} : { specifiedByURL }),
          }),
        )
        break
      }
    }
  }
  const root = (name: string | undefined): GraphQLObjectType | undefined =>
    name === undefined ? undefined : (lookup(name) as GraphQLObjectType)
  return new GraphQLSchema({
    query: root(model.roots.query),
    mutation: root(model.roots.mutation),
    subscription: root(model.roots.subscription),
    types: model.types.map(type => lookup(type.name)),
  })
}

/** `printSdl(model)` must be byte-identical to graphql-js `printSchema` of the equivalent schema. */
function expectSameAsGraphQL(model: SdlSchema): string {
  const sdl = printSdl(model)
  expect(sdl).toBe(printSchema(toGraphQLSchema(model)))
  return sdl
}

/** The schema of RFC 0005 §5.13, as the compiler would describe it (types sorted by name). */
const catalog: SdlSchema = {
  roots: { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' },
  types: [
    {
      kind: 'object',
      name: 'Author',
      fields: [
        { name: 'kind', type: 'String!' },
        { name: 'id', type: 'ID!' },
        { name: 'name', type: 'String!' },
        { name: 'born', type: 'Int' },
      ],
    },
    {
      kind: 'object',
      name: 'Book',
      description: 'A book of the catalog.',
      fields: [
        { name: 'kind', type: 'String!' },
        { name: 'id', type: 'ID!' },
        { name: 'title', type: 'String!' },
        { name: 'isbn', type: 'String!' },
        { name: 'publishedYear', type: 'Int', description: 'Year of first publication, `null` when unknown.' },
        { name: 'genre', type: 'Genre!' },
        { name: 'tags', type: '[String!]!' },
        { name: 'createdAt', type: 'DateTime!' },
        { name: 'category', type: 'String', deprecationReason: 'Use `tags`.' },
        {
          name: 'author',
          type: 'Author!',
          description: 'Who wrote the book. Batched: one repository call per execution, whatever the number of books.',
        },
      ],
    },
    {
      kind: 'object',
      name: 'BookPage',
      fields: [
        { name: 'items', type: '[Book!]!' },
        { name: 'total', type: 'Int!' },
        { name: 'hasMore', type: 'Boolean!' },
      ],
    },
    {
      kind: 'enum',
      name: 'BookSort',
      description: 'Sort orders of the book list.',
      values: [{ name: 'title' }, { name: 'newest' }],
    },
    { kind: 'scalar', name: 'DateTime', builtin: true },
    {
      kind: 'enum',
      name: 'Genre',
      description: 'Literary genres.',
      values: [{ name: 'Fantasy' }, { name: 'ScienceFiction' }, { name: 'Mystery' }],
    },
    {
      kind: 'object',
      name: 'Mutation',
      fields: [
        {
          name: 'addBook',
          type: 'Book!',
          description: 'Adds a book to the catalog.',
          args: [{ name: 'input', type: 'NewBookInput!' }],
        },
      ],
    },
    {
      kind: 'input',
      name: 'NewBookInput',
      description: 'A new book. The interface is the GraphQL input type, the schema of the same name validates it.',
      fields: [
        { name: 'title', type: 'String!' },
        { name: 'isbn', type: 'String!' },
        { name: 'authorId', type: 'String!' },
        { name: 'genre', type: 'Genre!' },
        { name: 'publishedYear', type: 'Int' },
        { name: 'tags', type: '[String!]' },
      ],
    },
    {
      kind: 'object',
      name: 'Query',
      fields: [
        {
          name: 'books',
          type: 'BookPage!',
          description: 'Books of the catalog, filtered and paginated.',
          args: [
            { name: 'search', type: 'String', description: 'Case-insensitive search in titles.' },
            { name: 'genre', type: 'Genre' },
            { name: 'sort', type: 'BookSort', defaultValue: 'title' },
            { name: 'limit', type: 'Int', defaultValue: 20 },
            { name: 'offset', type: 'Int', defaultValue: 0 },
          ],
        },
        {
          name: 'book',
          type: 'Book',
          description: 'One book.',
          args: [{ name: 'id', type: 'ID!', description: 'The id of the book.' }],
        },
      ],
    },
    {
      kind: 'object',
      name: 'Subscription',
      fields: [
        {
          name: 'bookAdded',
          type: 'Book!',
          description: 'Books added from now on, optionally of one genre.',
          args: [{ name: 'genre', type: 'Genre' }],
        },
      ],
    },
  ],
}

describe('printSdl', () => {
  it('prints the SDL of RFC 0005 §5.13', () => {
    const sdl = expectSameAsGraphQL(catalog)
    expect(sdl).toMatchSnapshot()
    expect(sdl).toContain('scalar DateTime @specifiedBy(url: "https://datatracker.ietf.org/doc/html/rfc3339")')
    expect(sdl).toContain('  category: String @deprecated(reason: "Use `tags`.")')
    expect(sdl).toContain('    sort: BookSort = title\n    limit: Int = 20\n')
    expect(sdl.endsWith('}')).toBe(true)
  })

  it('prints the same thing as graphql-js for an SDL parsed by graphql-js', () => {
    const source = /* GraphQL */ `
      type Query { hello(name: String = "world", times: Int! = 1): String! }
    `
    const model: SdlSchema = {
      roots: { query: 'Query' },
      types: [
        {
          kind: 'object',
          name: 'Query',
          fields: [
            {
              name: 'hello',
              type: 'String!',
              args: [
                { name: 'name', type: 'String', defaultValue: 'world' },
                { name: 'times', type: 'Int!', defaultValue: 1 },
              ],
            },
          ],
        },
      ],
    }
    expect(printSdl(model)).toBe(printSchema(buildSchema(source)))
  })

  it('prints descriptions as block strings, or as strings when they cannot be one', () => {
    const descriptions = [
      'One line.',
      'Two\nlines.',
      '  Leading spaces.',
      'Trailing quote"',
      'Trailing backslash\\',
      'Triple """ quotes',
      'Ends with triple quotes """',
      'A long line that goes on and on and on and on, past seventy characters for sure.',
      'Indented\n  second line',
      '\nStarts with an empty line',
      'Ends with an empty line\n',
      '',
      'Carriage\rreturn',
      'Control \u0001 character',
      'Tab\tinside',
      'Unicode: é ∑ 😀',
      '\u2028separator',
      '  \n  only indented lines',
    ]
    const model: SdlSchema = {
      roots: { query: 'Query' },
      types: [
        {
          kind: 'object',
          name: 'Query',
          description: descriptions[1],
          fields: descriptions.map((description, i) => ({
            name: `f${i}`,
            type: 'Int',
            description,
            args: [{ name: 'a', type: 'Int', description }],
          })),
        },
      ],
    }
    expect(expectSameAsGraphQL(model)).toStartWith('"""\nTwo\nlines.\n"""\ntype Query {\n')
  })

  it('prints arguments inline without descriptions, one per line with descriptions', () => {
    const sdl = expectSameAsGraphQL({
      roots: { query: 'Query' },
      types: [
        {
          kind: 'object',
          name: 'Query',
          fields: [
            { name: 'none', type: 'Int', args: [] },
            {
              name: 'inline',
              type: 'Int',
              args: [
                { name: 'a', type: 'Int' },
                { name: 'b', type: '[String!]!' },
              ],
            },
            {
              name: 'described',
              type: 'Int',
              description: 'A field.',
              args: [
                { name: 'a', type: 'Int' },
                { name: 'b', type: 'Int', description: 'B.' },
                { name: 'c', type: 'Int', deprecationReason: 'Gone.' },
              ],
            },
          ],
        },
      ],
    })
    expect(sdl).toContain('  none: Int\n')
    expect(sdl).toContain('  inline(a: Int, b: [String!]!): Int\n')
  })

  it('prints deprecations, with a bare @deprecated for the default reason', () => {
    const sdl = expectSameAsGraphQL({
      roots: { query: 'Query' },
      types: [
        {
          kind: 'enum',
          name: 'Color',
          values: [
            { name: 'RED', deprecationReason: 'No longer supported' },
            { name: 'GREEN', deprecationReason: 'Use "BLUE".', description: 'Green.' },
            { name: 'BLUE', description: 'Blue.\nReally.' },
          ],
        },
        {
          kind: 'input',
          name: 'Filter',
          fields: [
            { name: 'color', type: 'Color', deprecationReason: 'No longer supported' },
            { name: 'old', type: 'String', deprecationReason: 'Use `color`.', description: 'Old.' },
          ],
        },
        {
          kind: 'object',
          name: 'Query',
          fields: [
            { name: 'a', type: 'Color', deprecationReason: 'No longer supported' },
            { name: 'b', type: 'Int', args: [{ name: 'filter', type: 'Filter', deprecationReason: 'Gone' }] },
          ],
        },
      ],
    })
    expect(sdl).toContain('  RED @deprecated\n')
    expect(sdl).toContain('  GREEN @deprecated(reason: "Use \\"BLUE\\".")\n')
  })

  it('prints unions, scalars and every built-in scalar', () => {
    const sdl = expectSameAsGraphQL({
      roots: { query: 'Query' },
      types: [
        { kind: 'object', name: 'A', fields: [{ name: 'a', type: 'Int' }] },
        { kind: 'object', name: 'B', fields: [{ name: 'b', type: 'Int' }] },
        { kind: 'scalar', name: 'BigInt', builtin: true },
        { kind: 'scalar', name: 'DateTime', builtin: true },
        { kind: 'scalar', name: 'EmailAddress', description: 'An e-mail address' },
        { kind: 'scalar', name: 'JSON', builtin: true },
        {
          kind: 'object',
          name: 'Query',
          fields: [
            { name: 'ab', type: '[AB!]!' },
            { name: 'at', type: 'DateTime' },
            { name: 'big', type: 'BigInt' },
            { name: 'json', type: 'JSON' },
            { name: 'email', type: 'EmailAddress' },
            { name: 'url', type: 'URL' },
          ],
        },
        { kind: 'union', name: 'AB', description: 'A or B.', members: ['A', 'B'] },
        { kind: 'scalar', name: 'URL', specifiedByURL: 'https://url.spec.whatwg.org/' },
      ],
    })
    expect(sdl).toContain('"""A or B."""\nunion AB = A | B')
    expect(sdl).toContain('scalar URL @specifiedBy(url: "https://url.spec.whatwg.org/")')
  })

  it('prints the types in model order, without sorting them', () => {
    const sdl = expectSameAsGraphQL({
      roots: { query: 'Query' },
      types: [
        { kind: 'object', name: 'Query', fields: [{ name: 'z', type: 'Zed' }] },
        { kind: 'object', name: 'Zed', fields: [{ name: 'a', type: 'Int' }] },
      ],
    })
    expect(sdl.indexOf('type Query')).toBeLessThan(sdl.indexOf('type Zed'))
  })

  it('prints a schema definition when the root types are not the default ones', () => {
    const cases: readonly SdlSchema['roots'][] = [
      { query: 'Root' },
      { query: 'Query', mutation: 'Changes' },
      { query: 'Query' }, // with an unused type named Mutation
    ]
    for (const roots of cases) {
      const names = new Set([roots.query, roots.mutation ?? 'Mutation', 'Mutation'])
      const sdl = expectSameAsGraphQL({
        roots,
        types: [...names].sort().map(name => ({ kind: 'object', name, fields: [{ name: 'ok', type: 'Boolean' }] })),
      })
      expect(sdl.startsWith('schema {\n')).toBe(true)
    }
  })

  it('prints the default values of every input type like graphql-js', () => {
    const cases: readonly { readonly type: string; readonly value: unknown }[] = [
      { type: 'Int', value: 0 },
      { type: 'Int', value: -2147483648 },
      { type: 'Int!', value: 42 },
      { type: 'Float', value: 20 },
      { type: 'Float', value: 1.5 },
      { type: 'Float', value: -0.25 },
      { type: 'Float', value: 1e21 },
      { type: 'Float', value: 1e-7 },
      { type: 'String', value: 'title' },
      { type: 'String', value: 'quote " backslash \\ newline \n tab \t nul \u0000 del \u007f' },
      { type: 'String', value: '' },
      { type: 'Boolean', value: true },
      { type: 'Boolean!', value: false },
      { type: 'ID', value: 'abc' },
      { type: 'ID', value: '123' },
      { type: 'ID', value: '-0' },
      { type: 'ID', value: 7 },
      { type: 'Int', value: null },
      { type: '[Int]', value: null },
      { type: '[Int]', value: [1, null, 3] },
      { type: '[Int!]!', value: [] },
      { type: '[Int]', value: 5 },
      { type: '[[String]]', value: [['a'], ['b', 'c']] },
      { type: '[String!]', value: Array.from({ length: 12 }, (_, i) => `value number ${i}`) },
      { type: 'Color', value: 'RED' },
      { type: '[Color!]', value: ['RED', 'GREEN'] },
      { type: 'Point', value: { x: 1, y: 2 } },
      { type: 'Point', value: { x: 1 } },
      { type: 'Point', value: { y: 3, x: 1, label: 'here' } },
      { type: 'Point', value: { x: 1, label: undefined } },
      {
        type: '[Point!]',
        value: [
          { x: 1, y: 2, label: 'a rather long label to overflow the line' },
          { x: 3, label: 'another one' },
        ],
      },
      { type: 'Shape', value: { kind: 'RED', points: [{ x: 1 }], nested: { x: 0, label: 'origin' } } },
      { type: 'Shape', value: { kind: 'GREEN', points: [], nested: null } },
      {
        type: 'Shape',
        value: {
          kind: 'GREEN',
          points: [{ x: 1, label: 'one long label that forces a block' }],
          nested: { x: 2, y: 3, label: 'two' },
        },
      },
      { type: 'Empty', value: {} },
      { type: 'DateTime', value: '2026-11-02T10:00:00Z' },
      { type: 'BigInt', value: '9007199254740993' },
      { type: 'JSON', value: { a: [1, 'two', true, null], b: { c: 1.5 } } },
      { type: 'JSON', value: [{ a: 1 }, 2] },
      { type: 'JSON', value: 'text' },
      { type: 'JSON', value: { skipped: undefined, kept: 1 } },
    ]
    const sdl = expectSameAsGraphQL({
      roots: { query: 'Query' },
      types: [
        { kind: 'scalar', name: 'BigInt', builtin: true },
        { kind: 'enum', name: 'Color', values: [{ name: 'RED' }, { name: 'GREEN' }] },
        { kind: 'scalar', name: 'DateTime', builtin: true },
        { kind: 'input', name: 'Empty', fields: [{ name: 'optional', type: 'Int' }] },
        { kind: 'scalar', name: 'JSON', builtin: true },
        {
          kind: 'input',
          name: 'Point',
          fields: [
            { name: 'x', type: 'Int!' },
            { name: 'y', type: 'Int!', defaultValue: 0 },
            { name: 'label', type: 'String' },
          ],
        },
        {
          kind: 'object',
          name: 'Query',
          fields: [
            {
              name: 'f',
              type: 'Int',
              args: cases.map((entry, i) => ({ name: `a${i}`, type: entry.type, defaultValue: entry.value })),
            },
          ],
        },
        {
          kind: 'input',
          name: 'Shape',
          fields: [
            { name: 'kind', type: 'Color!' },
            { name: 'points', type: '[Point!]!' },
            { name: 'nested', type: 'Point' },
          ],
        },
      ],
    })
    expect(sdl).toContain('a3: Float = 20,')
    expect(sdl).toContain('a14: ID = 123,')
    expect(sdl).toContain('a24: Color = RED,')
    expect(sdl).toContain('a26: Point = { x: 1, y: 2 },')
  })

  it('rejects default values that do not match their type, like graphql-js', () => {
    const invalid: readonly { readonly type: string; readonly value: unknown }[] = [
      { type: 'Int!', value: null },
      { type: 'Int', value: 1.5 },
      { type: 'Int', value: 2147483648 },
      { type: 'Int', value: '1' },
      { type: 'Float', value: Number.POSITIVE_INFINITY },
      { type: 'Float', value: '1.5' },
      { type: 'String', value: 1 },
      { type: 'Boolean', value: 'true' },
      { type: 'ID', value: 1.5 },
      { type: 'ID', value: true },
      { type: 'Color', value: 'BLUE' },
      { type: 'Color', value: 1 },
      { type: '[Int!]', value: [1, null] },
      { type: 'Point', value: { y: 1 } },
      { type: 'Point', value: { x: 1, z: 2 } },
      { type: 'Point', value: 'x' },
    ]
    for (const entry of invalid) {
      const model: SdlSchema = {
        roots: { query: 'Query' },
        types: [
          { kind: 'enum', name: 'Color', values: [{ name: 'RED' }] },
          {
            kind: 'input',
            name: 'Point',
            fields: [
              { name: 'x', type: 'Int!' },
              { name: 'y', type: 'Int' },
            ],
          },
          {
            kind: 'object',
            name: 'Query',
            fields: [{ name: 'f', type: 'Int', args: [{ name: 'a', type: entry.type, defaultValue: entry.value }] }],
          },
        ],
      }
      expect(() => printSchema(toGraphQLSchema(model))).toThrow('Invalid default value')
      expect(() => printSdl(model)).toThrow('Invalid default value for Query.f(a:): ')
    }
  })

  it('rejects malformed type references', () => {
    expect(() =>
      printSdl({
        roots: { query: 'Query' },
        types: [{ kind: 'object', name: 'Query', fields: [{ name: 'f', type: '[Int' }] }],
      }),
    ).toThrow("Invalid type reference '[Int' (Query.f)")
  })

  it('is deterministic and leaves graphql-js specified scalars out', () => {
    const model: SdlSchema = {
      roots: { query: 'Query' },
      types: [
        { kind: 'scalar', name: 'Int', builtin: true },
        { kind: 'object', name: 'Query', fields: [{ name: 'n', type: 'Int' }] },
      ],
    }
    expect(printSdl(model)).toBe('type Query {\n  n: Int\n}')
    expect(printSdl(model)).toBe(printSdl(model))
    expect(SPECIFIED_SCALARS.has('Int')).toBe(true)
  })
})

describe('escaping helpers', () => {
  it('match graphql-js for every code point class', () => {
    const { printBlockString, printString } = graphqlLanguageInternals()
    const samples = [
      '',
      'plain',
      '"""',
      'a"""b',
      '\\',
      '"',
      '\n',
      ' \n ',
      'a\r\nb',
      '\t\tindented',
      'x'.repeat(71),
      ...Array.from({ length: 0xa0 }, (_, code) => `c${String.fromCharCode(code)}c`),
    ]
    for (const sample of samples) {
      expect(sdlPrintString(sample)).toBe(printString(sample))
      expect(sdlPrintBlockString(sample)).toBe(printBlockString(sample))
    }
  })
})

describe('schemaHash', () => {
  it('is the first 16 hexadecimal characters of the SHA-256 of the SDL', () => {
    const sdl = printSdl(catalog)
    const hash = schemaHash(sdl)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hash).toBe(new Bun.CryptoHasher('sha256').update(sdl).digest('hex').slice(0, 16))
    expect(schemaHash(sdl)).toBe(hash)
    expect(schemaHash(`${sdl}\n`)).not.toBe(hash)
  })
})

/** graphql-js printers of string values, reached through `print()` of string nodes. */
function graphqlLanguageInternals(): {
  printString: (value: string) => string
  printBlockString: (value: string) => string
} {
  return {
    printString: value => print({ kind: Kind.STRING, value }),
    printBlockString: value => print({ kind: Kind.STRING, value, block: true }),
  }
}
