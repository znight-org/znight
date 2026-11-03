/**
 * GraphQL interfaces in the metadata (RFC 0007 §6): built by the runtime, printed alike by
 * `printSdl()` and graphql-js, resolved with the `typename` and `class` discriminators, checked at
 * boot (ZNIGHT066). Custom scalars take their description and `@specifiedBy` from the metadata.
 */
import type { GraphQLMetadata, GraphQLTypeDefinition } from '../src/index.ts'

import { ErrorCode } from '@znight/core'
import { GraphQLScalarType, printSchema } from 'graphql'

import { scalar } from '../src/index.ts'
import { checkGraphQLSection } from '../src/schema.ts'
import { printSdl } from '../src/sdl.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

class Book {
  constructor(
    readonly id: string,
    readonly title: string,
  ) {}
}

class Library {
  nodes(): readonly unknown[] {
    return [new Book('1', 'Dune'), { __typename: 'Author', id: '2', name: 'Frank Herbert' }]
  }

  node(): unknown {
    return { __typename: 'Author', id: '2', name: 'Frank Herbert' }
  }
}

const Url = scalar<string>('Url', { serialize: value => String(value), parseValue: value => String(value) })

const types: readonly GraphQLTypeDefinition[] = [
  {
    kind: 'interface',
    name: 'Node',
    description: 'An object with an id.',
    fields: [field('id', 'ID!')],
    discriminator: { by: 'typename' },
  },
  {
    kind: 'interface',
    name: 'Named',
    interfaces: ['Node'],
    fields: [field('id', 'ID!'), field('name', 'String!')],
    discriminator: { by: 'typename' },
  },
  { kind: 'object', name: 'Book', interfaces: ['Node'], fields: [field('id', 'ID!'), field('title', 'String!')] },
  {
    kind: 'object',
    name: 'Author',
    interfaces: ['Node', 'Named'],
    fields: [field('id', 'ID!'), field('name', 'String!'), field('site', 'Url')],
  },
  { kind: 'scalar', name: 'Url', scalar: Url, description: 'A URL.', specifiedByURL: 'https://url.spec.whatwg.org' },
  {
    kind: 'object',
    name: 'Query',
    fields: [field('nodes', '[Node!]!', bind(Library, 'nodes')), field('node', 'Named', bind(Library, 'node'))],
  },
]

const metadata = (): ReturnType<typeof graphqlMetadata> => graphqlMetadata({ providers: [Library], types })

describe('interfaces', () => {
  it('builds interfaces and implementations, printed like printSdl()', async () => {
    await using booted = await boot(metadata())
    const section = booted.app.metadata.extensions?.graphql as GraphQLMetadata
    const sdl = booted.plugin.printSchema()
    expect(sdl).toBe(printSdl({ roots: section.roots, types: section.types }))
    expect(printSchema(booted.plugin.schema)).toBe(sdl)
    expect(sdl).toContain('type Author implements Node & Named {')
    expect(sdl).toContain('interface Named implements Node {')
    expect(sdl).toContain('"""An object with an id."""\ninterface Node {')
    expect(sdl).toContain('"""A URL."""\nscalar Url @specifiedBy(url: "https://url.spec.whatwg.org")')
  })

  it('resolves implementations from __typename', async () => {
    await using booted = await boot(metadata())
    const result = await booted.plugin.execute({
      query: '{ nodes { __typename id } node { __typename name } }',
    })
    // the Book instance has no __typename and no class discriminator: graphql-js cannot resolve it
    // (an internal error, masked)
    expect(result.errors?.[0]?.message).toBe('Unexpected error.')
    expect(result.errors?.[0]?.path).toEqual(['nodes', 0])
    const named = await booted.plugin.execute({ query: '{ node { __typename id name } }' })
    expect(named).toEqual({ data: { node: { __typename: 'Author', id: '2', name: 'Frank Herbert' } } })
  })

  it('resolves implementations with the class discriminator', async () => {
    const withClasses = types.map(type =>
      type.name === 'Node' && type.kind === 'interface'
        ? { ...type, discriminator: { by: 'class' as const, classes: [[Book, 'Book'] as const] } }
        : type,
    )
    await using booted = await boot(graphqlMetadata({ providers: [Library], types: withClasses }))
    const result = await booted.plugin.execute({ query: '{ nodes { __typename id } }' })
    expect(result).toEqual({
      data: {
        nodes: [
          { __typename: 'Book', id: '1' },
          { __typename: 'Author', id: '2' },
        ],
      },
    })
  })

  it('keeps a graphql-js scalar unless the metadata overrides its description', async () => {
    const native = new GraphQLScalarType({ name: 'Url', description: 'native' })
    const replaced = types.map(type =>
      type.name === 'Url' ? { kind: 'scalar' as const, name: 'Url', scalar: native } : type,
    )
    await using kept = await boot(graphqlMetadata({ providers: [Library], types: replaced }))
    expect(kept.plugin.schema.getType('Url')).toBe(native)
    const overridden = types.map(type =>
      type.name === 'Url' ? { kind: 'scalar' as const, name: 'Url', scalar: native, description: 'SDL' } : type,
    )
    await using booted = await boot(graphqlMetadata({ providers: [Library], types: overridden }))
    expect(booted.plugin.schema.getType('Url')?.description).toBe('SDL')
  })

  it('reports invalid interfaces at boot (ZNIGHT066)', () => {
    const problems = checkGraphQLSection({
      version: 1,
      schemaHash: 'x',
      roots: { query: 'Query' },
      types: [
        { kind: 'object', name: 'Query', interfaces: ['Missing', 'Query'], fields: [field('ok', 'Boolean')] },
        {
          kind: 'interface',
          name: 'Node',
          interfaces: 'Query',
          fields: [field('id', 'ID!', bind(Library, 'node'))],
          discriminator: { by: 'property', property: 'kind', values: { a: 'Query' } },
        },
        { kind: 'scalar', name: 'Url', scalar: Url, description: 1 },
      ],
    })
    expect(problems).toEqual([
      'Query: "Missing" is not an interface type',
      'Query: "Query" is not an interface type',
      'Node: interfaces must be an array of interface type names (received "Query")',
      'Node.id: interface fields have no resolver (bind it on the object types)',
      'Node: the discriminator names "Query", not a member',
      'Url: description must be a string',
    ])
    expect(ErrorCode.InvalidGraphQLSetup).toBe('ZNIGHT066')
  })
})
