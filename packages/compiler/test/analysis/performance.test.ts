/**
 * Performance smoke test: ~500 providers (classes, interfaces, factories, multi, Lazy, interceptors)
 * are analysed, bound and validated. Timings are logged; the bound is deliberately generous (CI
 * machines vary) and only catches pathological regressions (quadratic binding, missing memoization).
 */
import { analyzeProject } from '../../src/analyze.ts'
import { createProject, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const MODULES = 100 // 5 providers per module

function generate(): Record<string, string> {
  const files: Record<string, string> = {
    'src/shared.ts': [
      "import { Injectable, type MethodInterceptor, type MethodInvocation } from '@znight/core'",
      'export interface Clock { now(): number }',
      '@Injectable() export class SystemClock implements Clock { now(): number { return 0 } }',
      'export abstract class Plugin {}',
      'export class Timing implements MethodInterceptor { intercept(i: MethodInvocation): unknown { return i.proceed() } }',
    ].join('\n'),
  }
  for (let index = 0; index < MODULES; index++) {
    const previous = index > 0 ? index - 1 : undefined
    files[`src/m${index}/model.ts`] =
      `export interface Entity${index} { id: string }\nexport interface Repo${index}<T> { find(id: string): T }`
    files[`src/m${index}/repository.ts`] = [
      "import { Injectable } from '@znight/core'",
      "import type { Clock } from '../shared.ts'",
      `import type { Entity${index}, Repo${index} } from './model.ts'`,
      `export abstract class Base${index}<T> implements Repo${index}<T> { constructor(readonly clock: Clock) {} find(_id: string): T { throw new Error() } }`,
      `@Injectable() export class Repository${index} extends Base${index}<Entity${index}> {}`,
    ].join('\n')
    files[`src/m${index}/factory.ts`] = [
      "import { Factory, Provides } from '@znight/core'",
      `export class Client${index} {}`,
      `@Factory() export class Factory${index} {`,
      `  @Provides() async client(): Promise<Client${index}> { return new Client${index}() }`,
      '}',
    ].join('\n')
    files[`src/m${index}/service.ts`] = [
      "import { Injectable, Intercept, type Lazy } from '@znight/core'",
      "import { Plugin, Timing } from '../shared.ts'",
      `import type { Entity${index}, Repo${index} } from './model.ts'`,
      `import type { Client${index} } from './factory.ts'`,
      previous === undefined ? '' : `import { Service${previous} } from '../m${previous}/service.ts'`,
      `@Injectable() export class Plugin${index} extends Plugin {}`,
      `@Injectable() export class Service${index} {`,
      '  constructor(',
      `    readonly repo: Repo${index}<Entity${index}>,`,
      `    readonly client: Client${index},`,
      '    readonly plugins: Plugin[],',
      previous === undefined ? '' : `    readonly previous: Service${previous},`,
      previous === undefined ? '' : `    readonly lazy: Lazy<Service${previous}>,`,
      '  ) {}',
      '  @Intercept(Timing) run(): void {}',
      '}',
    ].join('\n')
  }
  return files
}

describe('performance', () => {
  const app = tempApp(generate())
  afterAll(() => app.cleanup())

  it('analyses, binds and validates ~500 providers quickly', () => {
    const refreshStart = performance.now()
    const project = createProject(app.root, { reportUnused: true })
    const refreshMs = performance.now() - refreshStart

    const cold = analyzeProject(project, { extensions: [], diagnostics: [] })
    project.refresh()
    const warm = analyzeProject(project, { extensions: [], diagnostics: [] })

    console.log('[perf] analysis', {
      providers: warm.stats.providers,
      classes: warm.stats.classes,
      files: warm.stats.files,
      scanAndParseMs: Math.round(refreshMs),
      coldAnalysisMs: Math.round(cold.stats.durationMs),
      warmAnalysisMs: Math.round(warm.stats.durationMs),
      edges: warm.graph.edges.length,
    })
    expect(warm.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([])
    // 5 per module (repository, factory, @Provides, plugin, service) + clock + auto-registered interceptor
    expect(warm.stats.providers).toBe(MODULES * 5 + 2)
    expect(warm.graph.resolutionOrder).toHaveLength(warm.stats.providers)
    expect(cold.stats.durationMs).toBeLessThan(10_000)
    expect(warm.stats.durationMs).toBeLessThan(5_000)
  })
})
