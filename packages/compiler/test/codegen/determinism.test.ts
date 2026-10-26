/**
 * Determinism (§3.3): the generated module is byte-identical whatever the scan order, the include
 * order, the number of runs, and for a full compile vs any sequence of incremental compiles.
 */
import type { SourceFile } from '../../src/project/index.ts'

import fs from 'node:fs'

import { analyzeProject } from '../../src/analyze.ts'
import { generateContainer } from '../../src/codegen/container.ts'
import { compile, createCompiler } from '../../src/compiler.ts'
import { loadExtensions } from '../../src/extensions/loader.ts'
import { normalizeOptions } from '../../src/options.ts'
import { Project } from '../../src/project/index.ts'
import { COMPILER_VERSION } from '../../src/version.ts'
import { tempApp } from '../analysis/helpers.ts'
import { CODEGEN, fixtureRoot } from './helpers.ts'
import { webExtension } from './web-extension.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items]
  let state = seed
  for (let index = result.length - 1; index > 0; index--) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    const other = Math.floor((state / 2_147_483_648) * (index + 1))
    ;[result[index], result[other]] = [result[other] as T, result[index] as T]
  }
  return result
}

async function generateWithOrder(
  name: string,
  fileOrder: (files: readonly SourceFile[]) => readonly SourceFile[],
): Promise<string> {
  const project = new Project(
    normalizeOptions({ root: fixtureRoot(name), conditions: ['@znight/source'], extensions: [webExtension] }),
  )
  project.refresh()
  const extensions = await loadExtensions(project)
  const analysis = analyzeProject(project, extensions, { fileOrder })
  const output = generateContainer({
    project,
    graph: analysis.graph,
    extensions: analysis.extensions,
    mode: 'serve',
    version: COMPILER_VERSION,
  })
  expect(output.diagnostics).toEqual([])
  return output.code
}

describe('determinism of the generated module', () => {
  for (const name of ['app', 'naming', 'web']) {
    it(`is byte-identical for shuffled scan orders (${name})`, async () => {
      const reference = await generateWithOrder(name, files => files)
      for (const seed of [1, 7, 42, 1234]) {
        expect(await generateWithOrder(name, files => shuffle(files, seed))).toBe(reference)
      }
      expect(await generateWithOrder(name, files => [...files].reverse())).toBe(reference)
    })
  }

  it('does not depend on the include order nor on repeated runs', async () => {
    const root = fixtureRoot('app')
    const first = await compile({ root, conditions: ['@znight/source'], include: ['src/**/*.ts'] })
    const second = await compile({
      root,
      conditions: ['@znight/source'],
      include: ['src/users/**/*.ts', 'src/**/*.ts', 'src/aop/*.ts'],
    })
    const compiler = createCompiler({ root, conditions: ['@znight/source'] })
    const third = await compiler.compile()
    const fourth = await compiler.compile()
    expect(second.code).toBe(first.code)
    expect(third.code).toBe(first.code)
    expect(fourth.code).toBe(first.code)
  })

  describe('incremental compiles', () => {
    const sources: Record<string, string> = {}
    for (const file of ['clock.ts', 'plugins.ts', 'events.ts']) {
      sources[`src/${file}`] = fs.readFileSync(`${CODEGEN}/app/src/${file}`, 'utf8')
    }
    const app = tempApp(sources)
    afterAll(() => app.cleanup())
    const options = { root: app.root, conditions: ['@znight/source'] }
    const full = async (): Promise<string> => (await compile(options)).code

    it('produce the same output as full compiles after changes, additions and removals', async () => {
      const compiler = createCompiler(options)
      expect((await compiler.compile()).code).toBe(await full())

      app.write(
        'src/plugins.ts',
        `${sources['src/plugins.ts']}\n@Injectable()\nexport class GammaPlugin extends Plugin {\n  name(): string {\n    return 'gamma'\n  }\n}\n`,
      )
      const changed = await compiler.compile({ changed: [`${app.root}/src/plugins.ts`] })
      expect(changed.code).toContain('GammaPlugin')
      expect(changed.code).toBe(await full())

      app.write('src/extra.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Extra {}\n")
      const added = await compiler.compile({ added: [`${app.root}/src/extra.ts`] })
      expect(added.code).toContain("['src/extra.ts#Extra']")
      expect(added.code).toBe(await full())

      app.remove('src/extra.ts')
      app.write('src/plugins.ts', sources['src/plugins.ts'] as string)
      const reverted = await compiler.compile({ removed: [`${app.root}/src/extra.ts`], changed: ['src/plugins.ts'] })
      expect(reverted.code).toBe(await full())
      expect(reverted.code).not.toContain('Extra')
      expect(reverted.stats.parsed).toBe(1)
    })
  })
})
