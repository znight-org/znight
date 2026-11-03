/**
 * Mapping of the SDL constructs to the metadata and the SDL artifact (RFC 0007 §5.5): extensions of
 * every kind across files, descriptions, deprecations, default values, custom root type names,
 * interfaces implementing interfaces, union members sorted, deterministic output.
 */

import type { CompilerExtension } from '@znight/compiler'

import { generate } from '@znight/compiler'
import { buildSchema, GraphQLSchema, lexicographicSortSchema, printSchema, specifiedDirectives } from 'graphql'

import graphql from '../../src/compiler/index.ts'
import { cleanupApps, compileApp, schemaOf, section, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const A = `"""
The root of reads.
Two lines.
"""
type RootQuery {
  "One item."
  item(
    "Its id."
    id: ID!
    "Legacy lookup."
    legacy: String @deprecated(reason: "Use id.")
  ): Item
  items(
    tags: [String!] = ["a", "b"]
    sort: Sort = NEWEST
    sorts: [Sort!] = [NEWEST, OLDEST]
    page: Page = { size: 10, cursor: { after: "x" } }
    ratio: Float = 1.5
    archived: Boolean = false
    note: String = null
    quote: String = "say \\"hi\\""
  ): [Item!]!
}

type RootMutation {
  touch(id: ID!): Item
}

schema {
  query: RootQuery
  mutation: RootMutation
}

interface Entity {
  id: ID!
}

interface Named implements Entity {
  id: ID!
  name: String!
}

type Item implements Entity & Named {
  id: ID!
  name: String!
}

enum Sort {
  NEWEST
}

input Page {
  size: Int!
  cursor: Cursor
}

input Cursor {
  after: String
}

union Hit = Item
`

const B = `extend type Item {
  "Added by another file."
  extra: String @deprecated
}

extend interface Entity {
  createdAt: String
}

extend type Item {
  createdAt: String
}

extend interface Named {
  createdAt: String
}

extend enum Sort {
  "Oldest first."
  OLDEST @deprecated(reason: "Use NEWEST.")
}

extend input Page {
  "Deprecated input field."
  offset: Int @deprecated(reason: "Use cursor.")
}

type Other {
  id: ID!
}

extend union Hit = Other
`

const RESOLVER = `import { Args, Mutation, Query, Resolver } from '@znight/graphql'

interface Item {
  readonly __typename: 'Item'
  readonly id: string
  readonly name: string
  readonly extra?: string | null
  readonly createdAt?: string | null
}

@Resolver()
export class ItemResolver {
  @Query()
  item(@Args('id') id: string): Item | null {
    return { __typename: 'Item', id, name: 'x' }
  }

  @Query()
  items(): readonly Item[] {
    return []
  }

  @Mutation()
  touch(@Args('id') id: string): Item | null {
    return { __typename: 'Item', id, name: 'x' }
  }
}
`

const FILES = { 'src/a.graphql': A, 'src/b.graphql': B, 'src/item.resolver.ts': RESOLVER }

function canonical(schema: GraphQLSchema): string {
  return printSchema(
    lexicographicSortSchema(new GraphQLSchema({ ...schema.toConfig(), directives: specifiedDirectives })),
  )
}

describe('SDL constructs', () => {
  it('map to the metadata and an artifact semantically equal to the source', async () => {
    const { sdl, code, diagnostics } = await schemaOf(FILES, { schema: 'src/**/*.graphql' })
    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    expect(canonical(buildSchema(sdl))).toBe(canonical(buildSchema(`${A}\n${B}`)))
    const printed = section(code)
    expect(printed).toContain("['roots']: { ['query']: 'RootQuery', ['mutation']: 'RootMutation' },")
    expect(sdl.startsWith('schema {\n  query: RootQuery\n  mutation: RootMutation\n}\n')).toBe(true)
    // descriptions: block strings, arguments, enum values, input fields
    expect(sdl).toContain('"""\nThe root of reads.\nTwo lines.\n"""\ntype RootQuery {')
    expect(sdl).toContain('    """Its id."""\n    id: ID!')
    // deprecations: arguments, fields (default reason), enum values, input fields
    expect(sdl).toContain('legacy: String @deprecated(reason: "Use id.")')
    expect(sdl).toContain('extra: String @deprecated')
    expect(sdl).toContain('OLDEST @deprecated(reason: "Use NEWEST.")')
    expect(sdl).toContain('offset: Int @deprecated(reason: "Use cursor.")')
    // defaults, as external values
    expect(printed).toContain("['defaultValue']: ['a', 'b']")
    expect(printed).toContain("['defaultValue']: 'NEWEST'")
    expect(printed).toContain("['defaultValue']: ['NEWEST', 'OLDEST']")
    expect(printed).toContain("['defaultValue']: { ['size']: 10, ['cursor']: { ['after']: 'x' } }")
    expect(printed).toContain("['defaultValue']: 1.5")
    expect(printed).toContain("['defaultValue']: false")
    expect(printed).toContain("['defaultValue']: null")
    expect(sdl).toContain('quote: String = "say \\"hi\\""')
    // extensions: fields after the definition, in file order; interfaces implementing interfaces
    expect(sdl).toContain(
      'type Item implements Entity & Named {\n  id: ID!\n  name: String!\n\n  """Added by another file."""\n  extra: String @deprecated\n  createdAt: String\n}',
    )
    expect(sdl).toContain('interface Named implements Entity {')
    expect(sdl).toContain('union Hit = Item | Other')
    expect(printed).toContain("['members']: ['Item', 'Other'],")
    // enum values are their names
    expect(printed).toContain("{ ['name']: 'NEWEST', ['value']: 'NEWEST' },")
  })

  it('is deterministic: the same module and artifact on every compile', async () => {
    const first = await schemaOf(FILES, { schema: 'src/**/*.graphql' })
    const second = await schemaOf(FILES, { schema: ['src/b.graphql', 'src/a.graphql'] })
    expect(second.code).toBe(first.code)
    expect(second.sdl).toBe(first.sdl)
  })
})

describe('the SDL artifact', () => {
  it('is never read back as an input, even when the globs match it', async () => {
    const app = tempApp(FILES)
    const extension = graphql.configure({
      schema: 'src/**/*.graphql',
      sdl: 'src/generated/schema.graphql',
    }) as unknown as CompilerExtension
    const first = await generate({ root: app.root, conditions: ['@znight/source'], extensions: [extension] })
    expect(first.written).toContain(app.path('src/generated/schema.graphql'))
    const second = await compileApp(app.root, { extensions: [extension] })
    expect(second.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    expect(second.watchFiles).not.toContain(app.path('src/generated/schema.graphql'))
  })
})
