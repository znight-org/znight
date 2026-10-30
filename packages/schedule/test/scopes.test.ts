/**
 * Scopes (RFC 0004 §7.8): one container scope per run seeded with `JobContext`, request-scoped hosts
 * created per run and disposed after it, `Lazy<JobContext>`, request values of other plugins absent.
 */
import type { Lazy } from '@znight/core'
import type { JobContext } from '../src/context.ts'

import { ScheduleTokens } from '../src/index.ts'
import { boot, metadataWith } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

class CatalogImport {
  static readonly instances: CatalogImport[] = []
  disposed = false
  constructor(readonly ctx: JobContext) {
    CatalogImport.instances.push(this)
  }
  run(): string {
    return this.ctx.runId
  }
  [Symbol.dispose](): void {
    this.disposed = true
  }
}

class AuditTrail {
  constructor(private readonly job: Lazy<JobContext>) {}
  current(): string {
    return this.job.get().job
  }
}

const IMPORT = 'src/catalog.ts#CatalogImport'
const AUDIT = 'src/audit.ts#AuditTrail'

describe('scopes', () => {
  it('creates a request-scoped host per run, seeded with its JobContext, and disposes it after', async () => {
    CatalogImport.instances.length = 0
    const seen: string[] = []
    await using booted = await boot({
      metadata: metadataWith(
        [
          {
            name: 'catalog.import',
            kind: 'interval',
            every: 60_000,
            token: IMPORT,
            method: 'run',
            invoke: (host: CatalogImport) => host.run(),
          },
        ],
        {
          [IMPORT]: {
            scope: 'request',
            class: CatalogImport,
            deps: [ScheduleTokens.JobContext],
            factory: d => new CatalogImport(d[0]),
          },
        },
      ),
    })
    booted.app.hooks.on('schedule:run', event => {
      seen.push(event.runId)
    })
    // the generated invoker receives the host resolved in the run's scope
    await booted.clock.advance('2m')
    expect(CatalogImport.instances).toHaveLength(2)
    expect(CatalogImport.instances.map(instance => instance.disposed)).toEqual([true, true])
    expect(CatalogImport.instances.map(instance => instance.ctx.runId)).toEqual(seen)
  })

  it('resolves Lazy<JobContext> in the current run', async () => {
    const jobs: string[] = []
    await using booted = await boot({
      metadata: metadataWith(
        [
          {
            name: 'audited',
            kind: 'cron',
            cron: '* * * * *',
            run: () => {
              jobs.push(booted.app.get<AuditTrail>(AUDIT).current())
            },
          },
        ],
        {
          [AUDIT]: {
            scope: 'singleton',
            class: AuditTrail,
            deps: [{ lazy: ScheduleTokens.JobContext }],
            factory: d => new AuditTrail(d[0]),
          },
        },
      ),
    })
    await booted.clock.advance('1m')
    expect(jobs).toEqual(['audited'])
    expect(() => booted.app.get<AuditTrail>(AUDIT).current()).toThrow(expect.objectContaining({ code: 'ZNIGHT013' }))
  })

  it('fails the run with ZNIGHT013 when a request value of another plugin is resolved', async () => {
    await using booted = await boot({
      metadata: metadataWith(
        [
          {
            name: 'http-bound',
            kind: 'cron',
            cron: '* * * * *',
            run: () => booted.app.get('@znight/http#HttpContext'),
          },
        ],
        {},
        [{ token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' }],
      ),
    })
    await booted.clock.advance('1m')
    const last = booted.registry.get('http-bound')?.lastRun
    expect(last?.outcome).toBe('failed')
    expect(last?.error).toMatchObject({ code: 'ZNIGHT013' })
  })

  it('runs a manual trigger in its own scope, not the caller’s', async () => {
    let inner: unknown = 'unset'
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'manual',
          kind: 'cron',
          cron: '@yearly',
          run: () => {
            inner = booted.app.container.currentScope()?.get('caller')
          },
        },
      ]),
    })
    await booted.app.container.runInScope(() => booted.registry.trigger('manual'), [['caller', 'request']])
    expect(inner).toBeUndefined()
  })
})
