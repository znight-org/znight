/**
 * Performance smoke test of schema-first mode (RFC 0007): an SDL of ~500 types spread over 80 files
 * (objects, interfaces, inputs, enums, unions, extensions of the root types), every root field and
 * a field resolver per module bound by name, resolvers typed like graphql-codegen output so that the
 * conformance walk visits every type. Timings are logged; the bound is generous and only catches
 * pathological regressions (quadratic walks, missing caches).
 */
import type { CompilerExtension } from '@znight/compiler'

import graphql from '../../src/compiler/index.ts'
import { cleanupApps, compileApp, render, SCHEMA_FIRST_CODES, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const MODULES = 80

function sources(): Record<string, string> {
  const files: Record<string, string> = {
    'src/schema.graphql': `interface Node {
  id: ID!
}

type Query {
  ping: Boolean
}

type Mutation {
  ping: Boolean
}
`,
    'src/types.ts': 'export type Maybe<T> = T | null\nexport type InputMaybe<T> = Maybe<T>\n',
    'src/ping.resolver.ts': `import { Mutation, Query, Resolver } from '@znight/graphql'

@Resolver()
export class PingResolver {
  @Query('ping')
  read(): boolean | null {
    return true
  }

  @Mutation('ping')
  write(): boolean | null {
    return true
  }
}
`,
  }
  for (let index = 0; index < MODULES; index++) {
    const next = (index + 1) % MODULES
    files[`src/m${index}/m${index}.graphql`] = `"""Status of module ${index}."""
enum Status${index} {
  DRAFT
  PUBLISHED
  ARCHIVED @deprecated(reason: "Use DRAFT.")
}

"""An item of module ${index}."""
type Item${index} implements Node {
  id: ID!
  title: String!
  name: String @deprecated(reason: "Use title.")
  count: Int
  status: Status${index}!
  tags: [String!]!
  next: Item${next}
  meta: Meta${index}!
  score: Float!
}

type Meta${index} {
  createdAt: String!
  views: Int!
}

type Other${index} implements Node {
  id: ID!
  label: String!
}

union Hit${index} = Item${index} | Other${index}

input Filter${index} {
  search: String
  limit: Int = 20
  status: Status${index}
}

input New${index} {
  title: String!
  status: Status${index}! = DRAFT
  tags: [String!]
}

extend type Query {
  items${index}(filter: Filter${index}): [Item${index}!]!
  search${index}(text: String!): [Hit${index}!]!
}

extend type Mutation {
  add${index}(input: New${index}!): Item${index}!
}
`
    files[`src/m${index}/types.ts`] = `import type { InputMaybe, Maybe } from '../types.ts'
import type { Item${next} } from '../m${next}/types.ts'

export enum Status${index} { ARCHIVED = 'ARCHIVED', DRAFT = 'DRAFT', PUBLISHED = 'PUBLISHED' }

export type Meta${index} = { __typename?: 'Meta${index}'; createdAt: string; views: number }

export type Item${index} = {
  __typename?: 'Item${index}'
  id: string
  title: string
  name?: Maybe<string>
  count?: Maybe<number>
  status: Status${index}
  tags: Array<string>
  next?: Maybe<Item${next}>
  meta: Meta${index}
}

export type Other${index} = { __typename?: 'Other${index}'; id: string; label: string }

export type Hit${index} = Item${index} | Other${index}

export type Filter${index} = { search?: InputMaybe<string>; limit?: InputMaybe<number>; status?: InputMaybe<Status${index}> }

export type New${index} = { title: string; status: Status${index}; tags?: InputMaybe<Array<string>> }
`
    files[`src/m${index}/resolver.ts`] =
      `import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@znight/graphql'
import type { Filter${index}, Hit${index}, Item${index}, New${index} } from './types.ts'

@Resolver('Item${index}')
export class Resolver${index} {
  @Query()
  items${index}(@Args('filter') filter: Filter${index} | null | undefined): Promise<Item${index}[]> {
    return Promise.resolve(filter as never)
  }

  @Query()
  search${index}(@Args('text') text: string): readonly Hit${index}[] {
    return [text as never]
  }

  @Mutation()
  add${index}(@Args('input') input: New${index}): Item${index} {
    return input as never
  }

  @ResolveField()
  score(@Parent() item: Item${index}): number {
    return item.title.length
  }
}
`
  }
  return files
}

describe('performance (schema-first)', () => {
  it(`compiles an SDL of ~${MODULES * 6} types quickly`, async () => {
    const app = tempApp(sources())
    const extension = graphql.configure({ schema: 'src/**/*.graphql' }) as unknown as CompilerExtension
    const started = performance.now()
    const result = await compileApp(app.root, { mode: 'build', extensions: [extension] })
    const elapsed = performance.now() - started
    expect(render({ root: app.root, diagnostics: result.diagnostics }, SCHEMA_FIRST_CODES)).toEqual([])
    const types = (result.code.match(/\['kind'\]: '(?:object|interface|input|enum|union|scalar)'/g) ?? []).length
    expect(types).toBeGreaterThanOrEqual(MODULES * 6)
    console.log('[perf] graphql schema-first compile', { types, files: MODULES * 3, ms: Math.round(elapsed) })
    // generous: the whole compile (parse, analysis, SDL validation, binding, conformance, generation)
    expect(elapsed).toBeLessThan(15_000)
  }, 60_000)
})
