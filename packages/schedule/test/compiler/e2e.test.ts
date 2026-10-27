/**
 * End to end (RFC 0004 §12.2): an application is compiled with `compile()` (the extension discovered
 * through the manifest), then booted with `TestApp`, `SchedulePlugin` and a test clock. Hosts survive
 * `prune`; compiled libraries record their jobs and roots.
 */
import type { TempApp } from './helpers.ts'

import fs from 'node:fs'
import { compile, generate } from '@znight/compiler'
import { silentLogger } from '@znight/core'
import { TestApp } from '@znight/testing'

import { SchedulePlugin, SchedulerRegistry } from '../../src/index.ts'
import { createTestClock } from '../../src/testing/index.ts'
import { analyzeApp, cleanupApps, compileAndLoad, render, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const APP: Readonly<Record<string, string>> = {
  'src/log.ts': `export const log: string[] = []
`,
  'src/audit.ts': `import { Injectable, type Lazy, type MethodInterceptor, type MethodInvocation } from '@znight/core'
import type { JobContext } from '@znight/schedule'
import { log } from './log.ts'

@Injectable()
export class AuditTrail {
  constructor(private readonly job: Lazy<JobContext>) {}

  record(action: string): void {
    log.push(\`audit:\${action}:\${this.job.get().job}\`)
  }
}

export class Timing implements MethodInterceptor {
  intercept(invocation: MethodInvocation): unknown {
    log.push(\`intercept:\${invocation.methodName}\`)
    return invocation.proceed()
  }
}
`,
  'src/digest.ts': `import { Intercept } from '@znight/core'
import { Cron, Interval, Timeout, type JobContext } from '@znight/schedule'
import { AuditTrail, Timing } from './audit.ts'
import { log } from './log.ts'

export class DigestJobs {
  constructor(private readonly audit: AuditTrail) {}

  /** 08:00 in Paris, Monday to Friday. */
  @Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
  @Intercept(Timing)
  async sendDaily(ctx: JobContext): Promise<void> {
    await Promise.resolve()
    this.audit.record('digest')
    log.push(\`digest:\${ctx.scheduledAt.toISOString()}\`)
  }

  @Interval('1h', { name: 'status.refresh', runOnStart: true })
  refresh(): void {
    log.push('refresh')
  }

  @Timeout(0, { name: 'status.warm' })
  warm(): void {
    log.push('warm')
  }
}
`,
  'src/catalog.ts': `import { Injectable } from '@znight/core'
import { Interval, type JobContext } from '@znight/schedule'
import { log } from './log.ts'

@Injectable({ scope: 'request' })
export class CatalogImport {
  constructor(private readonly ctx: JobContext) {}

  @Interval('1d', { name: 'catalog.import', enabled: false })
  run(): void {
    log.push(\`catalog:\${this.ctx.trigger}\`)
  }
}
`,
}

describe('compiled application', () => {
  it('runs its jobs with TestApp and a test clock (RFC §4.8)', async () => {
    const app = tempApp(APP)
    const { metadata } = await compileAndLoad(app)
    const { log } = (await import(app.path('src/log.ts'))) as { log: string[] }
    log.length = 0
    const clock = createTestClock('2027-03-26T06:00:00Z') // Friday 07:00 in Paris (CET)
    await using test = await TestApp.create({
      metadata,
      plugins: [SchedulePlugin.configure({ clock })],
      logger: silentLogger,
    })
    await clock.settle()
    expect(log).toEqual(['refresh', 'warm'])
    log.length = 0
    await clock.advanceTo('2027-03-29T07:00:00Z') // Monday 09:00 in Paris (CEST)
    expect(log.filter(entry => !entry.startsWith('refresh'))).toEqual([
      'intercept:sendDaily',
      'audit:digest:digest.daily',
      'digest:2027-03-26T07:00:00.000Z',
      'intercept:sendDaily',
      'audit:digest:digest.daily',
      'digest:2027-03-29T06:00:00.000Z',
    ])
    const registry = test.get(SchedulerRegistry)
    const digest = registry.get('digest.daily')
    expect(digest?.lastRun?.scheduledAt.toISOString()).toBe('2027-03-29T06:00:00.000Z')
    expect(digest?.nextRun?.toISOString()).toBe('2027-03-30T06:00:00.000Z')
    expect(digest?.maxDuration).toBe(600_000)
    // a disabled job with a request-scoped host: triggered manually, in its own scope
    log.length = 0
    expect((await registry.trigger('catalog.import')).outcome).toBe('completed')
    expect(log).toEqual(['catalog:manual'])
  })

  it('a manual run goes through the whole pipeline with enabled: false', async () => {
    const app = tempApp(APP)
    const { metadata } = await compileAndLoad(app)
    await using test = await TestApp.create({
      metadata,
      plugins: [SchedulePlugin.configure({ enabled: false })],
      logger: silentLogger,
    })
    const result = await test.get(SchedulerRegistry).trigger('digest.daily')
    expect(result.outcome).toBe('completed')
  })

  it('keeps the hosts and their dependencies under prune, and reports none as unused', async () => {
    const app = tempApp({
      ...APP,
      'src/unused.ts': `import { Injectable } from '@znight/core'
@Injectable()
export class Unused {}
`,
    })
    const analysis = await analyzeApp(app.root, { reportUnused: true })
    expect(render(analysis, ['ZNIGHT019']).map(line => line.split(' ').slice(0, 3).join(' '))).toEqual([
      'warning ZNIGHT019 src/unused.ts:3:14',
    ])
    const pruned = await compile({ root: app.root, conditions: ['@znight/source'], prune: true })
    expect(pruned.ok).toBe(true)
    expect(pruned.code).toContain("['src/digest.ts#DigestJobs']")
    expect(pruned.code).toContain("['src/audit.ts#AuditTrail']")
    expect(pruned.code).toContain("['src/catalog.ts#CatalogImport']")
    expect(pruned.code).not.toContain('Unused')
  })
})

describe('compiled provider libraries', () => {
  function library(): TempApp {
    const lib = tempApp({
      'src/index.ts': "export * from './cleanup.ts'\nexport * from './store.ts'\n",
      'src/store.ts': "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Store {}\n",
      'src/cleanup.ts': `import { Cron } from '@znight/schedule'
import { Store } from './store.ts'
export class CleanupJobs {
  constructor(readonly store: Store) {}
  @Cron('0 3 * * *', { name: 'cleanup.purge' })
  purge(): void {}
}
`,
      'dist/index.js':
        'export class Store {}\nexport class CleanupJobs {\n  constructor(store) {\n    this.store = store\n  }\n  purge() {}\n}\n',
      'dist/index.d.ts':
        'export declare class Store {}\nexport declare class CleanupJobs {\n  readonly store: Store\n  constructor(store: Store)\n  purge(): void\n}\n',
    })
    lib.write(
      'package.json',
      JSON.stringify({
        name: '@acme/cleanup',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { 'acme-source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } },
        dependencies: { '@znight/core': '0.1.0', '@znight/schedule': '0.1.0' },
        znight: { apiVersion: 1, providers: './dist/znight.providers.json' },
      }),
    )
    return lib
  }

  it('records the jobs and roots in znight.providers.json; the application generates and checks them', async () => {
    const lib = library()
    const built = await generate({ root: lib.root, library: true, conditions: ['acme-source', '@znight/source'] })
    expect(built.diagnostics).toEqual([])
    const fragment = JSON.parse(fs.readFileSync(`${lib.root}/dist/znight.providers.json`, 'utf8')) as {
      readonly roots?: readonly string[]
      readonly extensions: Readonly<Record<string, readonly unknown[]>>
    }
    expect(fragment.roots).toEqual(['@acme/cleanup#CleanupJobs'])
    const stored = fragment.extensions['schedule'] as unknown as Record<string, unknown>[]
    expect(stored[0]).toMatchObject({
      name: 'cleanup.purge',
      host: { $znight: 'class', identity: '@acme/cleanup#CleanupJobs' },
    })

    const files = {
      'src/jobs.ts': `import { Cron } from '@znight/schedule'
import { Store } from '@acme/cleanup'
export class AppJobs {
  constructor(readonly store: Store) {}
  @Cron('@hourly', { name: 'app.hourly' })
  run(): void {}
}
`,
    }
    const app = tempApp(files)
    fs.mkdirSync(`${app.root}/node_modules/@acme`, { recursive: true })
    fs.symlinkSync(lib.root, `${app.root}/node_modules/@acme/cleanup`, 'dir')
    app.write(
      'package.json',
      JSON.stringify({ name: 'app', private: true, type: 'module', dependencies: { '@acme/cleanup': '1.0.0' } }),
    )
    const result = await compile({ root: app.root, conditions: ['@znight/source'], prune: true })
    expect(result.diagnostics).toEqual([])
    expect(result.code).toContain("['token']: '@acme/cleanup#CleanupJobs'")
    expect(result.code).toContain("['invoke']: (c: CleanupJobs) => c.purge()")
    expect(result.code).toContain("['@acme/cleanup#CleanupJobs']: {")

    // a name used by the library and the application
    app.write('src/jobs.ts', files['src/jobs.ts'].replace('app.hourly', 'cleanup.purge'))
    const duplicate = await compile({ root: app.root, conditions: ['@znight/source'] })
    expect(duplicate.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([
      ['ZNIGHT041', "Job name 'cleanup.purge' is used twice"],
    ])
  })
})
