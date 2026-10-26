/**
 * Determinism: the application graph (providers, deps, externals, aliases, order, edges, extension
 * data, diagnostics) does not depend on the scan order, the include order or the number of runs.
 */
import type { ApplicationGraph } from '../../src/graph/types.ts'
import type { SourceFile } from '../../src/project/index.ts'

import { analyzeProject } from '../../src/analyze.ts'
import { loadExtensions } from '../../src/extensions/loader.ts'
import { ValueRef } from '../../src/project/index.ts'
import { fixtureProject } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

/** Stable JSON of a graph (ValueRefs by identity, functions by name, Maps as entries). */
function snapshot(graph: ApplicationGraph): string {
  return JSON.stringify(graph, (_key, value: unknown) => {
    if (value instanceof ValueRef) {
      return { ref: value.identity }
    }
    if (typeof value === 'function') {
      return '[function]'
    }
    if (value instanceof Map) {
      return [...value.entries()]
    }
    if (typeof value === 'bigint') {
      return `${value}n`
    }
    return value
  })
}

/** Seeded Fisher-Yates shuffle. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items]
  let state = seed
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[result[index], result[other]] = [result[other] as T, result[index] as T]
  }
  return result
}

async function graphOf(
  name: string,
  include?: string[],
  fileOrder?: (files: readonly SourceFile[]) => readonly SourceFile[],
): Promise<string> {
  const project = fixtureProject(name, include ? { include } : {})
  const extensions = await loadExtensions(project)
  return snapshot(analyzeProject(project, extensions, fileOrder ? { fileOrder } : {}).graph)
}

describe('determinism', () => {
  for (const fixture of ['app', 'missing', 'cycles', 'scopes', 'decorators']) {
    it(`produces an identical graph for shuffled scan orders (${fixture})`, async () => {
      const reference = await graphOf(fixture)
      expect(await graphOf(fixture, undefined, files => [...files].reverse())).toBe(reference)
      for (const seed of [1, 7, 42]) {
        expect(await graphOf(fixture, undefined, files => shuffle(files, seed))).toBe(reference)
      }
    })
  }

  it('does not depend on the order of the include globs', async () => {
    const reference = await graphOf('app', ['src/**/*.ts'])
    expect(await graphOf('app', ['src/users/**/*.ts', 'src/**/*.ts', 'src/core/*.ts'])).toBe(reference)
  })

  it('is stable across repeated compiles of the same project', async () => {
    const project = fixtureProject('app')
    const extensions = await loadExtensions(project)
    const first = snapshot(analyzeProject(project, extensions).graph)
    project.refresh()
    expect(snapshot(analyzeProject(project, extensions).graph)).toBe(first)
    project.refresh({ changed: ['src/users/user.service.ts'] })
    expect(snapshot(analyzeProject(project, extensions).graph)).toBe(first)
  })
})
