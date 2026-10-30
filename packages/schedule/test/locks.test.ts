/**
 * One runner across instances (RFC 0004 §4.7, §7.6): occurrence-fenced leases, heartbeats, lost
 * leases, store failures, abandoned leases, runs dropped while waiting for their lease, stores that
 * do not answer, ZNIGHT043, and the conformance scenarios.
 */
import type { ScheduledRunEvent } from '@znight/core'
import type { JobContext } from '../src/context.ts'
import type { LockClaim, LockLease, ScheduleLockStore } from '../src/index.ts'

import { hostname } from 'node:os'

import { memoryLockStore } from '../src/index.ts'
import { lockStoreScenarios } from '../src/testing/index.ts'
import { aborted, boot, deferred, metadataWith, testClock } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

/** A store recording its claims, delegating to a memory store. */
function recordingStore(inner: ScheduleLockStore): ScheduleLockStore & { readonly claims: [string, LockClaim][] } {
  const claims: [string, LockClaim][] = []
  return {
    name: 'recording',
    claims,
    acquire(key, claim) {
      claims.push([key, claim])
      return inner.acquire(key, claim)
    },
  }
}

describe('single runner', () => {
  it('two instances on one store and one clock: each occurrence runs once', async () => {
    const clock = testClock('2026-01-01T00:00:00Z')
    const lock = memoryLockStore({ clock })
    const runs: string[] = []
    const metadata = metadataWith([
      { name: 'digest', kind: 'cron', cron: '* * * * *', run: ctx => runs.push(ctx.scheduledAt.toISOString()) },
    ])
    await using a = await boot({ clock, metadata, schedule: { lock } })
    await using b = await boot({ clock, metadata, schedule: { lock } })
    await clock.advance('3m')
    expect(runs).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'])
    const outcomes = [a.registry.get('digest')?.lastRun?.outcome, b.registry.get('digest')?.lastRun?.outcome].sort()
    expect(outcomes).toEqual(['completed', 'not-acquired'])
    expect([...a.logs.messages('debug'), ...b.logs.messages('debug')]).toContain(
      "Schedule: job 'digest' not run: another instance holds the lock",
    )
  })

  it('locks every job once a store is configured, unless lock: false or overlap: allow', async () => {
    const store = recordingStore(memoryLockStore())
    await using booted = await boot({
      schedule: { lock: { store, keyPrefix: 'acme:', ttl: '10s', owner: 'instance-1' } },
      metadata: metadataWith([
        { name: 'locked', kind: 'cron', cron: '* * * * *' },
        { name: 'opt-out', kind: 'cron', cron: '* * * * *', lock: false },
        { name: 'parallel', kind: 'cron', cron: '* * * * *', overlap: 'allow' },
      ]),
    })
    expect(booted.registry.jobs().map(job => [job.name, job.locked])).toEqual([
      ['locked', true],
      ['opt-out', false],
      ['parallel', false],
    ])
    await booted.clock.advance('1m')
    expect(store.claims).toEqual([
      ['acme:locked', { owner: 'instance-1', occurrence: Date.parse('2026-01-01T00:01:00Z'), ttlMs: 10_000 }],
    ])
  })

  it('claims with the default key prefix, ttl and owner (<hostname>:<pid>:<random>)', async () => {
    const store = recordingStore(memoryLockStore())
    await using booted = await boot({
      schedule: { lock: store },
      metadata: metadataWith([{ name: 'job', kind: 'interval', every: 60_000 }]),
    })
    await booted.registry.trigger('job')
    const [key, claim] = store.claims[0] ?? []
    expect(key).toBe('znight:schedule:job')
    expect(claim?.ttlMs).toBe(30_000)
    expect(claim?.occurrence).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(claim?.owner).toMatch(
      new RegExp(`^${hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${process.pid}:[0-9a-f]{8}$`),
    )
  })
})

describe('leases', () => {
  it('extends the lease every ttl / 3 while the run lasts, then releases it', async () => {
    const clock = testClock('2026-01-01T00:00:00Z')
    const extensions: number[] = []
    let released = 0
    const store: ScheduleLockStore = {
      name: 'spy',
      acquire: () =>
        Promise.resolve<LockLease>({
          extend: ttl => {
            extensions.push(clock.now())
            expect(ttl).toBe(3000)
            return Promise.resolve(true)
          },
          release: () => {
            released++
            return Promise.resolve()
          },
        }),
    }
    const release = deferred()
    await using booted = await boot({
      clock,
      schedule: { lock: { store, ttl: '3s' } },
      metadata: metadataWith([{ name: 'long', kind: 'cron', cron: '* * * * *', run: () => release.promise }]),
    })
    await clock.advance('65s')
    expect(extensions.map(at => (at - Date.parse('2026-01-01T00:01:00Z')) / 1000)).toEqual([1, 2, 3, 4, 5])
    release.resolve()
    await booted.registry.idle()
    expect(released).toBe(1)
    await clock.advance('5s')
    expect(extensions).toHaveLength(5)
  })

  it("aborts the run ('lock-lost') when the lease is lost", async () => {
    let reason: unknown
    const store: ScheduleLockStore = {
      name: 'flaky',
      acquire: () => Promise.resolve({ extend: () => Promise.resolve(false), release: () => Promise.resolve() }),
    }
    await using booted = await boot({
      schedule: { lock: { store, ttl: '3s' } },
      metadata: metadataWith([
        {
          name: 'job',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            reason = await aborted(ctx.signal)
          },
        },
      ]),
    })
    await booted.clock.advance('62s')
    expect(reason).toMatchObject({ reason: 'lock-lost', code: 'ZNIGHT044' })
    expect(booted.logs.messages('warn')).toContain(
      `Schedule: run ${booted.registry.get('job')?.lastRun?.runId} of job 'job' lost its lock: aborting it`,
    )
    expect(booted.registry.get('job')?.lastRun).toMatchObject({ outcome: 'completed', aborted: 'lock-lost' })
  })

  it('retries failed extensions, and gives up once ttl elapsed since the last success', async () => {
    let reason: unknown
    const store: ScheduleLockStore = {
      name: 'down',
      acquire: () =>
        Promise.resolve({ extend: () => Promise.reject(new Error('store down')), release: () => Promise.resolve() }),
    }
    await using booted = await boot({
      schedule: { lock: { store, ttl: '3s' } },
      metadata: metadataWith([
        {
          name: 'job',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            reason = await aborted(ctx.signal)
          },
        },
      ]),
    })
    await booted.clock.advance('62s')
    expect(reason).toBeUndefined()
    expect(booted.logs.messages('warn').filter(message => message.includes('retrying'))).toHaveLength(2)
    await booted.clock.advance('1s')
    expect(reason).toMatchObject({ reason: 'lock-lost' })
  })

  it('fails closed when the store fails: no lease, no run', async () => {
    let ran = false
    const failure = new Error('connection refused')
    const events: unknown[] = []
    await using booted = await boot({
      schedule: { lock: { name: 'broken', acquire: () => Promise.reject(failure) } },
      metadata: metadataWith([
        {
          name: 'job',
          kind: 'cron',
          cron: '* * * * *',
          run: () => {
            ran = true
          },
        },
      ]),
    })
    booted.app.hooks.on('schedule:run', event => {
      events.push({ outcome: event.outcome, error: event.error, context: event.context })
    })
    await booted.clock.advance('1m')
    expect(ran).toBe(false)
    expect(booted.registry.get('job')?.lastRun).toMatchObject({
      outcome: 'failed',
      error: failure,
      startedAt: undefined,
    })
    expect(events).toEqual([{ outcome: 'failed', error: failure, context: undefined }])
    expect(booted.logs.entries.find(entry => entry.level === 'error')).toMatchObject({
      message: "Schedule: job 'job' did not run: the broken lock store failed",
      context: { job: 'job', err: failure },
    })
  })

  it('keeps the lease of a run abandoned at shutdown (it expires after its ttl)', async () => {
    const clock = testClock('2026-01-01T00:00:00Z')
    const lock = memoryLockStore({ clock })
    const never = deferred()
    const booted = await boot({
      clock,
      schedule: { lock: { store: lock, ttl: '10s' }, drainTimeoutMs: 10 },
      metadata: metadataWith([{ name: 'job', kind: 'cron', cron: '* * * * *', run: () => never.promise }]),
    })
    await clock.advance('1m')
    await booted.app.stop()
    expect(booted.logs.messages('warn').some(message => message.includes('abandoned'))).toBe(true)
    const key = 'znight:schedule:job'
    const next = { owner: 'other', occurrence: Date.parse('2026-01-01T00:02:00Z'), ttlMs: 1000 }
    expect(await lock.acquire(key, next)).toBeUndefined() // still held by the abandoned run
    await clock.advance('10s')
    expect(await lock.acquire(key, next)).toBeDefined()
    never.resolve()
  })
})

describe('runs waiting for their lease', () => {
  /** A memory store whose `acquire()` waits for `gate` (store latency). */
  function slowStore(inner: ScheduleLockStore, gate: Promise<void>): ScheduleLockStore {
    return {
      name: 'slow',
      acquire: async (key, claim) => {
        await gate
        return inner.acquire(key, claim)
      },
    }
  }
  const next = { owner: 'other', occurrence: Date.parse('2026-01-01T00:02:00Z'), ttlMs: 1000 }

  it('never start their job once the application stopped, and release the lease (drain timed out)', async () => {
    const clock = testClock()
    const inner = memoryLockStore({ clock })
    const gate = deferred()
    const executed: string[] = []
    const events: ScheduledRunEvent[] = []
    const booted = await boot({
      clock,
      schedule: { lock: { store: slowStore(inner, gate.promise), ttl: '30s' }, drainTimeoutMs: 20 },
      metadata: metadataWith([{ name: 'job', kind: 'interval', every: 60_000, run: () => executed.push('ran') }]),
    })
    booted.app.hooks.on('schedule:run', event => {
      events.push(event)
    })
    await clock.advance('1m')
    expect(booted.registry.get('job')?.running).toBe(1)
    await booted.app.stop() // abandoned after 20 ms, then disposed
    gate.resolve()
    await clock.settle()
    expect(executed).toEqual([])
    expect(events.map(event => [event.outcome, event.aborted])).toEqual([['skipped', 'shutdown']])
    expect(booted.logs.messages('debug')).toContain(
      "Schedule: job 'job' did not run: its run was aborted (shutdown) before it started",
    )
    expect(await inner.acquire('znight:schedule:job', next)).toBeDefined() // released: the job never ran
    expect(clock.pendingTimers).toBe(0) // no heartbeat nor store timer after dispose
  })

  it('never start their job once stop() began, even when the drain succeeds', async () => {
    const clock = testClock()
    const gate = deferred()
    const executed: string[] = []
    const booted = await boot({
      clock,
      schedule: { lock: { store: slowStore(memoryLockStore({ clock }), gate.promise) } },
      metadata: metadataWith([{ name: 'job', kind: 'interval', every: 60_000, run: () => executed.push('ran') }]),
    })
    await clock.advance('1m')
    const stopping = booted.app.stop()
    gate.resolve()
    await stopping
    expect(executed).toEqual([])
    expect(booted.logs.messages('warn').filter(message => message.includes('abandoned'))).toEqual([])
  })

  it('never start the job of a removed or paused job (manual runs of a paused job do)', async () => {
    const clock = testClock()
    const gate = deferred()
    const executed: string[] = []
    const run = (ctx: JobContext): void => {
      executed.push(`${ctx.job}:${ctx.trigger}`)
    }
    await using booted = await boot({
      clock,
      schedule: { lock: { store: slowStore(memoryLockStore({ clock }), gate.promise) } },
      metadata: metadataWith([
        { name: 'monitor.1', kind: 'cron', cron: '* * * * *', run },
        { name: 'monitor.2', kind: 'cron', cron: '* * * * *', run },
        { name: 'report', kind: 'cron', cron: '* * * * *', run },
      ]),
    })
    await clock.advance('1m')
    const [one, two, report] = ['monitor.1', 'monitor.2', 'report'].map(name => booted.registry.get(name))
    booted.registry.remove('monitor.1', { abort: true })
    booted.registry.remove('monitor.2')
    report?.pause()
    gate.resolve()
    await booted.registry.idle()
    expect(executed).toEqual([])
    expect(one?.lastRun).toMatchObject({ outcome: 'skipped', aborted: 'removed', startedAt: undefined })
    expect(two?.lastRun).toMatchObject({ outcome: 'skipped', startedAt: undefined })
    expect(report?.lastRun).toMatchObject({ outcome: 'skipped', startedAt: undefined })
    expect(booted.logs.messages('debug')).toEqual(
      expect.arrayContaining([
        "Schedule: job 'monitor.1' did not run: its run was aborted (removed) before it started",
        "Schedule: job 'monitor.2' did not run: it was removed",
        "Schedule: job 'report' did not run: it was paused",
      ]),
    )
    await clock.advance('1s') // a manual run claims now: after the occurrence claimed at 00:01:00
    expect((await report?.trigger())?.outcome).toBe('completed')
    expect(executed).toEqual(['report:manual'])
  })
})

describe('lock stores that do not answer', () => {
  it("loses the lease ttl after the last successful extension, even while extend() hangs ('lock-lost')", async () => {
    const clock = testClock()
    const inner = memoryLockStore({ clock })
    let extensions = 0
    const store: ScheduleLockStore = {
      name: 'partitioned',
      acquire: async (key, claim) => {
        const lease = await inner.acquire(key, claim)
        return (
          lease && {
            extend: () => {
              extensions++
              return new Promise<boolean>(() => undefined) // a client queuing commands offline
            },
            release: () => lease.release(),
          }
        )
      },
    }
    let reason: unknown
    await using booted = await boot({
      clock,
      schedule: { lock: { store, ttl: '3s' } },
      metadata: metadataWith([
        {
          name: 'job',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            reason = await aborted(ctx.signal)
          },
        },
      ]),
    })
    await clock.advance('62999ms')
    expect(reason).toBeUndefined()
    expect(extensions).toBe(1) // later beats skip the store while the extension is pending
    await clock.advance(1)
    expect(reason).toMatchObject({ reason: 'lock-lost' }) // at 00:01:03, when the store expires the lease
    expect(booted.logs.messages('warn')).toContain(
      `Schedule: run ${booted.registry.get('job')?.lastRun?.runId} of job 'job' lost its lock: aborting it`,
    )
  })

  it('fails closed when acquire() does not answer within the ttl, and releases a late lease', async () => {
    const clock = testClock()
    const inner = memoryLockStore({ clock })
    const late = deferred<LockLease | undefined>()
    let releasedLate = false
    let calls = 0
    const store: ScheduleLockStore = {
      name: 'hung',
      acquire: (key, claim) => (++calls === 1 ? late.promise : inner.acquire(key, claim)),
    }
    const runs: string[] = []
    await using booted = await boot({
      clock,
      schedule: { lock: { store, ttl: '3s' } },
      metadata: metadataWith([
        { name: 'job', kind: 'interval', every: 60_000, run: ctx => runs.push(ctx.scheduledAt.toISOString()) },
      ]),
    })
    await clock.advance('1m')
    const job = booted.registry.get('job')
    expect(job?.running).toBe(1)
    await clock.advance('3s')
    expect(job?.running).toBe(0)
    expect(job?.lastRun).toMatchObject({ outcome: 'failed', startedAt: undefined })
    expect(String((job?.lastRun?.error as Error | undefined)?.message)).toBe(
      'the hung lock store did not answer within the lock ttl (3000 ms)',
    )
    expect(booted.logs.messages('error')).toContain("Schedule: job 'job' did not run: the hung lock store failed")
    late.resolve({
      extend: () => Promise.resolve(true),
      release: () => {
        releasedLate = true
        return Promise.resolve()
      },
    })
    await clock.settle()
    expect(releasedLate).toBe(true)
    await clock.advance('57s')
    expect(runs).toEqual(['2026-01-01T00:02:00.000Z'])
  })

  it('frees the job when release() does not answer within the ttl (the lease expires)', async () => {
    const clock = testClock()
    const inner = memoryLockStore({ clock })
    const store: ScheduleLockStore = {
      name: 'hung',
      acquire: async (key, claim) => {
        const lease = await inner.acquire(key, claim)
        return lease && { extend: ttl => lease.extend(ttl), release: () => new Promise<void>(() => undefined) }
      },
    }
    const runs: string[] = []
    await using booted = await boot({
      clock,
      schedule: { lock: { store, ttl: '3s' } },
      metadata: metadataWith([
        { name: 'job', kind: 'interval', every: 60_000, run: ctx => runs.push(ctx.scheduledAt.toISOString()) },
      ]),
    })
    await clock.advance('1m')
    const job = booted.registry.get('job')
    expect(job?.running).toBe(1) // releasing
    await clock.advance('3s')
    expect(job?.running).toBe(0)
    expect(job?.lastRun?.outcome).toBe('completed')
    expect(booted.logs.messages('warn')).toContain(
      "Schedule: releasing the lock of job 'job' did not answer within 3000 ms (it expires after its ttl)",
    )
    await clock.advance('57s')
    expect(runs).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z'])
    await clock.advance('3s') // the second release times out as well
    expect(job?.running).toBe(0)
  })
})

describe('configuration errors', () => {
  it('ZNIGHT043: a job requiring a lock without store', async () => {
    const failure = boot({ metadata: metadataWith([{ name: 'job', kind: 'cron', cron: '* * * * *', lock: true }]) })
    await expect(failure).rejects.toMatchObject({ code: 'ZNIGHT043' })
    await expect(failure).rejects.toThrow("Job 'job' requires a lock (lock: true) but SchedulePlugin has no lock store")
    await using booted = await boot()
    expect(() => booted.registry.addInterval('dynamic', '1m', () => undefined, { lock: true })).toThrow(
      expect.objectContaining({ code: 'ZNIGHT043' }),
    )
  })

  it("ZNIGHT040: lock: true with overlap: 'allow'", async () => {
    await using booted = await boot({ schedule: { lock: memoryLockStore() } })
    expect(() =>
      booted.registry.addInterval('dynamic', '1m', () => undefined, { lock: true, overlap: 'allow' }),
    ).toThrow("lock: true cannot be combined with overlap: 'allow'")
    await expect(
      boot({
        schedule: { lock: memoryLockStore() },
        metadata: metadataWith([{ name: 'job', kind: 'cron', cron: '* * * * *', lock: true, overlap: 'allow' }]),
      }),
    ).rejects.toMatchObject({ code: 'ZNIGHT040' })
  })
})

describe('memoryLockStore conformance', () => {
  for (const scenario of lockStoreScenarios) {
    it(scenario.name, () => scenario.run(() => memoryLockStore()), 10_000)
  }

  it('validates claims', async () => {
    await expect(memoryLockStore().acquire('', { owner: 'a', occurrence: 1, ttlMs: 1 })).rejects.toThrow(TypeError)
    await expect(memoryLockStore().acquire('k', { owner: 'a', occurrence: 1, ttlMs: 0 })).rejects.toThrow(TypeError)
  })

  it('reports scenario failures with the store name', async () => {
    const broken: ScheduleLockStore = { name: 'broken', acquire: () => Promise.resolve(undefined) }
    const scenario = lockStoreScenarios[0]
    await expect(scenario?.run(() => broken)).rejects.toThrow(/^\[lock store 'broken'\] claims a free key/)
  })
})
