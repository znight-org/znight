/**
 * Performance smoke test of the extension: a schema of ~200 types (objects, inputs, enums, unions,
 * generic instances, field resolvers) compiled from scratch. Timings are logged; the bound is
 * generous and only catches pathological regressions (quadratic walks, missing caches).
 */
import { cleanupApps, compileApp, render, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const MODULES = 40

function sources(): Record<string, string> {
  const files: Record<string, string> = {
    'src/shared.ts': `import type { ID, Int } from '@znight/graphql'

/** A page of results. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: Int
}

export interface Node {
  readonly id: ID
}
`,
  }
  for (let index = 0; index < MODULES; index++) {
    const next = (index + 1) % MODULES
    files[`src/m${index}/types.ts`] = `import type { ID, Int } from '@znight/graphql'
import type { Node, Page } from '../shared.ts'
import type { Item${next} } from '../m${next}/types.ts'

/** Statuses of module ${index}. */
export enum Status${index} {
  Draft = 'draft',
  Published = 'published',
}

/** An item of module ${index}. */
export interface Item${index} extends Node {
  readonly kind: 'item${index}'
  readonly title: string
  /** @deprecated Use title. */
  readonly name?: string
  readonly count: Int | null
  readonly status: Status${index}
  readonly tags: readonly string[]
  readonly next: Item${next} | null
}

export interface Other${index} {
  readonly kind: 'other${index}'
  readonly id: ID
}

export type Hit${index} = Item${index} | Other${index}

export interface Filter${index} {
  readonly search?: string
  /** @default 20 */
  readonly limit?: Int
  readonly status?: Status${index}
}

export interface New${index} {
  readonly title: string
  readonly status: Status${index}
  readonly tags?: readonly string[]
}

export type Items${index} = Page<Item${index}>
`
    files[`src/m${index}/resolver.ts`] =
      `import { Args, Mutation, Parent, Query, ResolveField, Resolver, type ID } from '@znight/graphql'
import type { Filter${index}, Hit${index}, Item${index}, Items${index}, New${index} } from './types.ts'

@Resolver()
export class Resolver${index} {
  /** Items of module ${index}. */
  @Query()
  items${index}(@Args() filter: Filter${index}): Promise<Items${index}> {
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
  score${index}(@Parent() item: Item${index}, @Args('weight') weight?: number): number {
    return item.title.length * (weight ?? 1)
  }

  @ResolveField()
  ref${index}(@Parent() item: Item${index}): ID {
    return item.id
  }
}
`
  }
  return files
}

describe('performance', () => {
  it(`compiles a schema of ~${MODULES * 5} types quickly`, async () => {
    const app = tempApp(sources())
    const started = performance.now()
    const result = await compileApp(app.root, { mode: 'build' })
    const elapsed = performance.now() - started
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    const types = (result.code.match(/\['kind'\]: '(?:object|input|enum|union|scalar)'/g) ?? []).length
    expect(types).toBeGreaterThanOrEqual(MODULES * 5)
    console.log('[perf] graphql compile', { types, ms: Math.round(elapsed) })
    // generous: the whole compile (parse, analysis, shapes, model, generation) of ~200 types
    expect(elapsed).toBeLessThan(10_000)
  }, 60_000)
})
