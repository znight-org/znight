/**
 * Performance smoke test of the full pipeline (~500 providers): full compile, then an incremental
 * compile after one change. Timings are logged; the bounds are generous and only catch
 * pathological regressions (quadratic printing, missing caches).
 */
import { analyzeProject } from '../../src/analyze.ts'
import { generateContainer } from '../../src/codegen/container.ts'
import { createCompiler } from '../../src/compiler.ts'
import { createProject, tempApp } from '../analysis/helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const MODULES = 100

function sources(): Record<string, string> {
  const files: Record<string, string> = {
    'src/shared.ts': [
      "import { Injectable, type MethodInterceptor, type MethodInvocation } from '@znight/core'",
      'export interface Clock { now(): number }',
      '@Injectable() export class SystemClock implements Clock { now(): number { return 0 } }',
      'export abstract class Plugin {}',
      'export class Timing implements MethodInterceptor<{ label: string }> { intercept(i: MethodInvocation): unknown { return i.proceed() } }',
    ].join('\n'),
  }
  for (let index = 0; index < MODULES; index++) {
    const previous = index > 0 ? index - 1 : undefined
    files[`src/m${index}/service.ts`] = [
      "import { Factory, Injectable, Intercept, Provides, type Lazy } from '@znight/core'",
      "import { type Clock, Plugin, Timing } from '../shared.ts'",
      previous === undefined ? '' : `import { Service${previous} } from '../m${previous}/service.ts'`,
      `export class Client${index} {}`,
      `@Factory() export class Factory${index} { @Provides() async client(): Promise<Client${index}> { return new Client${index}() } }`,
      `@Injectable() export class Plugin${index} extends Plugin {}`,
      `@Injectable({ scope: 'transient' }) export class Helper${index} { constructor(readonly clock: Clock) {} }`,
      `@Injectable() export class Service${index} {`,
      `  constructor(readonly client: Client${index}, readonly helper: Helper${index}, readonly plugins: Plugin[]${
        previous === undefined ? '' : `, readonly previous: Service${previous}, readonly lazy: Lazy<Service${previous}>`
      }) {}`,
      `  @Intercept(Timing, { label: 'run${index}' }) run(): void {}`,
      '}',
    ].join('\n')
  }
  return files
}

describe('performance', () => {
  const app = tempApp(sources())
  afterAll(() => app.cleanup())

  it('compiles ~500 providers and recompiles incrementally quickly', async () => {
    const compiler = createCompiler({ root: app.root, mode: 'build' })
    const full = await compiler.compile()
    expect(full.diagnostics).toEqual([])
    expect(full.stats.providers).toBe(MODULES * 5 + 2)

    app.write('src/m50/service.ts', `${sources()['src/m50/service.ts']}\n// edited\n`)
    const incremental = await compiler.compile({ changed: ['src/m50/service.ts'] })
    expect(incremental.code).toBe(full.code)
    expect(incremental.stats.parsed).toBe(1)

    console.log('[perf] compile', {
      providers: full.stats.providers,
      files: full.stats.files,
      fullMs: Math.round(full.stats.durationMs),
      incrementalMs: Math.round(incremental.stats.durationMs),
      bytes: full.code.length,
    })
    expect(full.stats.durationMs).toBeLessThan(15_000)
    expect(incremental.stats.durationMs).toBeLessThan(5_000)
  }, 60_000)

  it('prints multi-megabyte modules in linear time', () => {
    const files: Record<string, string> = {
      'src/shared.ts': 'export abstract class Plugin {}\n',
    }
    for (let index = 0; index < 100; index++) {
      files[`src/m${index}.ts`] = [
        "import { Injectable } from '@znight/core'",
        "import { Plugin } from './shared.ts'",
        ...[0, 1, 2, 3, 4].map(
          j =>
            `@Injectable() export class S${index}_${j} extends Plugin { constructor(${
              j > 0 ? `readonly previous: S${index}_${j - 1}, readonly all: Plugin[]` : ''
            }) { super() } }`,
        ),
      ].join('\n')
    }
    const big = tempApp(files)
    try {
      const project = createProject(big.root)
      const analysis = analyzeProject(project, { extensions: [], diagnostics: [] })
      const start = performance.now()
      const output = generateContainer({ project, graph: analysis.graph, extensions: [], mode: 'build', version: '0' })
      const durationMs = performance.now() - start
      console.log('[perf] codegen', { bytes: output.code.length, durationMs: Math.round(durationMs) })
      expect(output.diagnostics).toEqual([])
      expect(output.code.length).toBeGreaterThan(5_000_000)
      expect(durationMs).toBeLessThan(5_000)
    } finally {
      big.cleanup()
    }
  }, 60_000)
})
