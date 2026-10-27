/**
 * `SchedulerRegistry` and the plugin's validation at boot (RFC 0004 §4.5, §4.6, §6.3): static and
 * dynamic jobs, pause / resume / reschedule / remove / trigger / idle, ZNIGHT021/040/041/042, options,
 * `jobs` overrides, hand-written metadata, plugin reuse.
 */
import type { JobContext } from '../src/context.ts'

import { Application, silentLogger } from '@znight/core'

import { compileExpression } from '../src/cron.ts'
import { SchedulePlugin } from '../src/index.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import { boot, captureLogger, deferred, iso, metadataWith, testClock } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const STATIC = metadataWith([
  { name: 'digest.daily', kind: 'cron', cron: '0 8 * * MON-FRI', timeZone: 'Europe/Paris', maxDuration: 600_000 },
  { name: 'status.refresh', kind: 'interval', every: 60_000, lock: false, runOnStart: true },
  { name: 'warm', kind: 'timeout', delay: 2000 },
  { name: 'off', kind: 'cron', cron: '@daily', enabled: false },
])

describe('jobs', () => {
  it('lists the static jobs, sorted by name, with their settings', async () => {
    await using booted = await boot({ metadata: STATIC })
    const jobs = booted.registry.jobs()
    expect(jobs.map(job => job.name)).toEqual(['digest.daily', 'off', 'status.refresh', 'warm'])
    expect(
      jobs.map(job => ({
        name: job.name,
        kind: job.kind,
        origin: job.origin,
        schedule: job.schedule,
        cron: job.cron,
        timeZone: job.timeZone,
        every: job.every,
        delay: job.delay,
        overlap: job.overlap,
        locked: job.locked,
        maxDuration: job.maxDuration,
        state: job.state,
      })),
    ).toEqual([
      {
        name: 'digest.daily',
        kind: 'cron',
        origin: 'decorator',
        schedule: '0 8 * * MON-FRI (Europe/Paris)',
        cron: '0 8 * * MON-FRI',
        timeZone: 'Europe/Paris',
        every: undefined,
        delay: undefined,
        overlap: 'skip',
        locked: false,
        maxDuration: 600_000,
        state: 'scheduled',
      },
      {
        name: 'off',
        kind: 'cron',
        origin: 'decorator',
        schedule: '@daily (UTC)',
        cron: '@daily',
        timeZone: 'UTC',
        every: undefined,
        delay: undefined,
        overlap: 'skip',
        locked: false,
        maxDuration: undefined,
        state: 'disabled',
      },
      {
        name: 'status.refresh',
        kind: 'interval',
        origin: 'decorator',
        schedule: 'every 1m',
        cron: undefined,
        timeZone: undefined,
        every: 60_000,
        delay: undefined,
        overlap: 'skip',
        locked: false,
        maxDuration: undefined,
        state: 'scheduled',
      },
      {
        name: 'warm',
        kind: 'timeout',
        origin: 'decorator',
        schedule: 'once after 2s',
        cron: undefined,
        timeZone: undefined,
        every: undefined,
        delay: 2000,
        overlap: 'skip',
        locked: false,
        maxDuration: undefined,
        state: 'scheduled',
      },
    ])
    expect(booted.registry.has('warm')).toBe(true)
    expect(booted.registry.get('missing')).toBeUndefined()
    expect(iso(booted.registry.get('digest.daily')?.nextRuns(2, new Date('2026-10-23T12:00:00Z')) ?? [])).toEqual([
      '2026-10-26T07:00:00.000Z',
      '2026-10-27T07:00:00.000Z',
    ])
    expect(iso(booted.registry.get('warm')?.nextRuns(3) ?? [])).toEqual(['2026-01-01T00:00:02.000Z'])
    expect(JSON.parse(JSON.stringify(booted.registry.get('warm')))).toMatchObject({ name: 'warm', state: 'scheduled' })
  })

  it('adds dynamic jobs: armed now when the scheduler runs, else when it starts', async () => {
    const runs: string[] = []
    const record = (ctx: JobContext): void => {
      runs.push(`${ctx.job}@${ctx.scheduledAt.toISOString().slice(11, 19)}`)
    }
    const booted = await boot({ start: false })
    booted.registry.addInterval('early', '1m', record) // before onReady: armed when the scheduler starts
    await booted.app.start()
    const cron = booted.registry.addCron('cron', '*/30 * * * * *', record, { timeZone: 'Europe/Paris' })
    booted.registry.addTimeout('once', '10s', record)
    expect(cron).toMatchObject({ origin: 'dynamic', kind: 'cron', schedule: '*/30 * * * * * (Europe/Paris)' })
    await booted.clock.advance('1m')
    expect(runs).toEqual(['once@00:00:10', 'cron@00:00:30', 'cron@00:01:00', 'early@00:01:00'])
    await booted.app.stop()
  })

  it('runs a dynamic runOnStart job right away when added while the scheduler runs', async () => {
    const runs: string[] = []
    await using booted = await boot()
    booted.registry.addInterval('probe', '1m', ctx => runs.push(ctx.trigger), { runOnStart: true, maxDuration: '10s' })
    await booted.clock.settle()
    expect(runs).toEqual(['start'])
    expect(booted.registry.get('probe')?.maxDuration).toBe(10_000)
  })

  it('validates dynamic jobs (ZNIGHT040, ZNIGHT041)', async () => {
    await using booted = await boot({ metadata: STATIC })
    const noop = (): void => undefined
    const registry = booted.registry
    expect(() => registry.addCron('bad name', '* * * * *', noop)).toThrow(
      expect.objectContaining({ code: 'ZNIGHT040' }),
    )
    expect(() => registry.addCron('warm', '* * * * *', noop)).toThrow("ZNIGHT041: Job name 'warm' is used twice")
    expect(() => registry.addCron('x', '0 24 * * *', noop)).toThrow(
      "addCron('x'): invalid cron expression '0 24 * * *': hour 24 is out of range (0-23)",
    )
    try {
      registry.addCron('x', '0 24 * * *', noop)
    } catch (error) {
      expect(error).toMatchObject({ field: 'hour', start: 2, end: 4 })
    }
    expect(() => registry.addCron('x', '@daily', noop, { timeZone: 'Europe/Pari' })).toThrow(
      "(did you mean 'Europe/Paris'?)",
    )
    expect(() => registry.addInterval('x', 0, noop)).toThrow(
      "addInterval('x'): the interval must be at least 1 ms, got 0",
    )
    expect(() => registry.addInterval('x', '5 min' as never, noop)).toThrow("use '5m'")
    expect(() => registry.addInterval('x', '1m', noop, { timezone: 'UTC' } as never)).toThrow(
      "addInterval('x'): unknown option 'timezone'",
    )
    expect(() => registry.addTimeout('x', '1m', noop, { overlap: 'queue' } as never)).toThrow(
      expect.objectContaining({ hints: ['A timeout runs once: overlap and runOnStart do not apply'] }),
    )
    expect(() => registry.addCron('x', '@daily', noop, { overlap: 'sometimes' } as never)).toThrow(
      "'overlap' must be 'skip', 'queue' or 'allow'",
    )
    expect(() => registry.addCron('x', '@daily', 'nope' as never)).toThrow('the handler must be a function')
    expect(() => registry.addCron('x', 42 as never, noop)).toThrow('the expression must be a string')
    expect(registry.has('x')).toBe(false)
  })

  it('pauses, resumes and reschedules jobs', async () => {
    const runs: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'tick',
          kind: 'interval',
          every: 60_000,
          run: ctx => runs.push(ctx.scheduledAt.toISOString().slice(11, 16)),
        },
      ]),
    })
    const tick = booted.registry.get('tick')
    tick?.pause()
    tick?.pause()
    expect(tick?.state).toBe('paused')
    expect(tick?.nextRun).toBeUndefined()
    await booted.clock.advance('3m')
    expect(runs).toEqual([])
    tick?.resume()
    expect(tick?.nextRun?.toISOString()).toBe('2026-01-01T00:04:00.000Z')
    await booted.clock.advance('1m')
    tick?.reschedule('5m')
    expect(tick?.schedule).toBe('every 5m')
    expect(tick?.nextRun?.toISOString()).toBe('2026-01-01T00:05:00.000Z')
    await booted.clock.advance('6m')
    expect(runs).toEqual(['00:04', '00:05', '00:10'])
    expect(() => tick?.reschedule('0 * * * *')).toThrow("reschedule() of job 'tick': the interval")
    expect(() => tick?.reschedule('1m', { timeZone: 'UTC' })).toThrow('intervals have no time zone')
  })

  it('reschedules cron jobs (expression and zone) and re-arms timeouts', async () => {
    const runs: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'cron',
          kind: 'cron',
          cron: '0 9 * * *',
          run: ctx => runs.push(`cron@${ctx.scheduledAt.toISOString()}`),
        },
        { name: 'once', kind: 'timeout', delay: 0, run: ctx => runs.push(`once@${ctx.scheduledAt.toISOString()}`) },
      ]),
    })
    await booted.clock.settle()
    const cron = booted.registry.get('cron')
    cron?.reschedule('0 9 * * *', { timeZone: 'Asia/Tokyo' })
    expect(cron?.schedule).toBe('0 9 * * * (Asia/Tokyo)')
    expect(cron?.nextRun?.toISOString()).toBe('2026-01-02T00:00:00.000Z') // 09:00 in Tokyo
    expect(() => cron?.reschedule(60_000)).toThrow('a cron job takes a cron expression')
    expect(() => cron?.reschedule('0 0 31 2 *')).toThrow('never fires')
    const once = booted.registry.get('once')
    expect(once?.state).toBe('done')
    once?.reschedule('30s')
    expect(once?.state).toBe('scheduled')
    await booted.clock.advance('30s')
    expect(runs).toEqual(['once@2026-01-01T00:00:00.000Z', 'once@2026-01-01T00:00:30.000Z'])
  })

  it('re-arms a timeout rescheduled from its own run, before or after its first await, whatever the delay', async () => {
    const runs: string[] = []
    await using booted = await boot()
    const { registry } = booted
    const retry =
      (name: string, delays: readonly (string | number)[], awaitFirst: boolean) => async (ctx: JobContext) => {
        if (awaitFirst) await Promise.resolve()
        runs.push(`${name}@${ctx.scheduledAt.toISOString().slice(14, 23)}`)
        const delay = delays[runs.filter(run => run.startsWith(`${name}@`)).length - 1]
        if (delay !== undefined) registry.get(name)?.reschedule(delay)
      }
    registry.addTimeout('sync', '5s', retry('sync', ['10s', '10s'], false))
    registry.addTimeout('async', '5s', retry('async', ['10s', '10s'], true))
    registry.addTimeout('zero', '1s', retry('zero', [0, 0], false))
    await booted.clock.advance('1m')
    expect(runs.filter(run => run.startsWith('sync@'))).toEqual(['sync@00:05.000', 'sync@00:15.000', 'sync@00:25.000'])
    expect(runs.filter(run => run.startsWith('async@'))).toEqual([
      'async@00:05.000',
      'async@00:15.000',
      'async@00:25.000',
    ])
    // reschedule(0) in the millisecond of the run: a new occurrence, 1 ms later
    expect(runs.filter(run => run.startsWith('zero@'))).toEqual(['zero@00:01.000', 'zero@00:01.001', 'zero@00:01.002'])
    expect(registry.jobs().map(job => [job.name, job.state])).toEqual([
      ['async', 'done'],
      ['sync', 'done'],
      ['zero', 'done'],
    ])
  })

  it('re-arms a cron job that had no further occurrence when it is rescheduled', () => {
    const clock = testClock()
    const runtime = new ScheduleRuntime(
      { enabled: true, timeZone: 'UTC', lock: undefined, drainTimeoutMs: 100, clock },
      { container: undefined as never, hooks: undefined as never, logger: captureLogger() },
    )
    const weekly = compileExpression('0 0 * * 0', 'UTC')
    const job = runtime.add({
      name: 'weekly',
      origin: 'dynamic',
      host: undefined,
      method: undefined,
      token: undefined,
      // an engine without further occurrence (the parser rejects such expressions: ZNIGHT040)
      schedule: {
        kind: 'cron',
        cron: '0 0 * * 0',
        timeZone: 'UTC',
        ownZone: undefined,
        engine: { ...weekly, next: () => undefined },
      },
      overlap: 'skip',
      lock: undefined,
      maxDuration: undefined,
      enabled: true,
      runOnStart: false,
      invoke: () => undefined,
    })
    runtime.start()
    expect(job.handle.state).toBe('done')
    job.handle.reschedule('0 0 * * 0')
    expect(job.handle.state).toBe('scheduled')
    expect(job.handle.nextRun?.toISOString()).toBe('2026-01-04T00:00:00.000Z')
    runtime.dispose()
  })

  it('releases removed and rescheduled jobs at once (the deadline heap keeps one entry per live job)', async () => {
    await using booted = await boot()
    const alive: WeakRef<object>[] = []
    const add = (name: string): void => {
      const payload = { bytes: new Uint8Array(1024 * 1024) } // captured by the handler
      alive.push(new WeakRef(payload))
      booted.registry.addTimeout(name, '30d', () => payload.bytes.length)
    }
    for (let index = 0; index < 20; index++) add(`reminder.${index}`)
    for (let index = 0; index < 20; index++) booted.registry.remove(`reminder.${index}`)
    // a debounce: re-armed on every event, one armed occurrence at a time
    const debounce = booted.registry.addTimeout('debounce', '30d', () => undefined)
    for (let index = 0; index < 1000; index++) debounce.reschedule('30d')
    await new Promise(resolve => setTimeout(resolve, 0))
    Bun.gc(true)
    expect(alive.filter(ref => ref.deref() !== undefined)).toHaveLength(0)
    expect(booted.registry.jobs().map(job => job.name)).toEqual(['debounce'])
  })

  it('removes jobs (ZNIGHT042 for unknown names), aborting their runs on demand', async () => {
    const release = deferred()
    let reason: unknown
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'monitor.1',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            ctx.signal.addEventListener('abort', () => {
              reason = ctx.signal.reason
            })
            await release.promise
          },
        },
      ]),
    })
    await booted.clock.advance('1m')
    const handle = booted.registry.get('monitor.1')
    booted.registry.remove('monitor.1', { abort: true })
    expect(reason).toMatchObject({ reason: 'removed' })
    expect(handle?.state).toBe('removed')
    expect(booted.registry.has('monitor.1')).toBe(false)
    await expect(handle?.trigger()).rejects.toMatchObject({ code: 'ZNIGHT042' })
    expect(() => handle?.pause()).toThrow(expect.objectContaining({ code: 'ZNIGHT042' }))
    expect(() => booted.registry.remove('monitor.2')).toThrow("ZNIGHT042: No job named 'monitor.2'")
    expect(() => booted.registry.remove('monitor.1', 'yes' as never)).toThrow('options must be { abort?: boolean }')
    await expect(booted.registry.trigger('monitr.1')).rejects.toMatchObject({ code: 'ZNIGHT042' })
    release.resolve()
    await booted.registry.idle()
    // the name is free again
    booted.registry.addInterval('monitor.1', '1m', () => undefined)
    expect(booted.registry.get('monitor.1')?.origin).toBe('dynamic')
  })

  it('triggers jobs manually (disabled ones too) and waits for idleness', async () => {
    const runs: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'off', kind: 'cron', cron: '@daily', enabled: false, run: ctx => runs.push(ctx.trigger) },
      ]),
    })
    const result = await booted.registry.trigger('off')
    expect(result).toMatchObject({ job: 'off', trigger: 'manual', outcome: 'completed' })
    expect(result.scheduledAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(Object.isFrozen(result)).toBe(true)
    expect(runs).toEqual(['manual'])
    await booted.registry.idle()
  })
})

describe('lifecycle of the registry', () => {
  it('throws ZNIGHT021 before the bootstrap (provider constructors)', () => {
    const plugin = SchedulePlugin.configure()
    expect(() => plugin.registry.jobs()).toThrow('SchedulerRegistry.jobs(): the scheduler is not bootstrapped yet')
    expect(() => plugin.registry.addCron('x', '@daily', () => undefined)).toThrow(
      expect.objectContaining({ code: 'ZNIGHT021', hints: [expect.stringContaining('onStart/onReady')] }),
    )
    expect(plugin.state).toBe('created')
    expect(plugin.clock).toBeUndefined()
  })

  it('exposes state and clock, and serves one running application at a time (ZNIGHT004)', async () => {
    const booted = await boot()
    expect(booted.plugin.state).toBe('running')
    expect(booted.plugin.clock).toBe(booted.clock)
    await expect(
      Application.create({
        metadata: metadataWith(),
        plugins: [booted.plugin],
        logger: silentLogger,
        shutdown: { signals: false },
      }),
    ).rejects.toMatchObject({ code: 'ZNIGHT004' })
    await booted.app.stop()
    const again = await Application.create({
      metadata: metadataWith(),
      plugins: [booted.plugin],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    expect(again.getPlugin('schedule')).toBe(booted.plugin)
    await again.stop()
  })

  it('declares the job hosts as init roots (TestApp)', () => {
    const plugin = SchedulePlugin.configure()
    expect(plugin.initRoots({ metadata: STATIC })).toEqual(['src/host.ts#Host'])
    expect(plugin.initRoots({ metadata: metadataWith() })).toEqual([])
    expect(plugin.initRoots({ metadata: null as never })).toEqual([])
  })

  it('logs the next occurrence when it starts', async () => {
    await using booted = await boot({ metadata: STATIC })
    expect(booted.logs.messages('info')).toContain('Schedule: 4 job(s), next: warm at 2026-01-01T00:00:02.000Z')
  })
})

describe('options and metadata validation (boot)', () => {
  it('validates the plugin options (ZNIGHT040)', async () => {
    await expect(boot({ schedule: { timezone: 'UTC' } as never })).rejects.toThrow(
      "SchedulePlugin.configure(): unknown option 'timezone' (did you mean 'timeZone'?)",
    )
    await expect(boot({ schedule: { timeZone: 'Europe/Pari' } })).rejects.toThrow("(did you mean 'Europe/Paris'?)")
    await expect(boot({ schedule: { enabled: 'yes' } as never })).rejects.toThrow("'enabled' must be a boolean")
    await expect(boot({ schedule: { drainTimeoutMs: -1 } })).rejects.toThrow("'drainTimeoutMs' must be a number")
    await expect(boot({ schedule: { clock: {} } as never })).rejects.toThrow("'clock' must be a ScheduleClock")
    await expect(boot({ schedule: { lock: {} } as never })).rejects.toThrow("'lock' must be a lock store")
    await expect(
      boot({ schedule: { lock: { store: { name: 'x', acquire: () => Promise.resolve(undefined) }, ttl: '500ms' } } }),
    ).rejects.toThrow("'lock.ttl' must be at least 1000 ms")
    await expect(boot({ schedule: { jobs: [] } as never })).rejects.toThrow(
      "'jobs' must be an object keyed by job name",
    )
  })

  it('evaluates options given as a function of the container', async () => {
    await using booted = await boot({ schedule: () => ({ enabled: false }) })
    expect(booted.plugin.state).toBe('running')
    expect(booted.logs.messages('info')).toContain('Schedule: disabled (0 job(s) declared, none scheduled)')
  })

  it('applies jobs overrides (ZNIGHT042 for unknown names, ZNIGHT040 for the wrong kind)', async () => {
    await using booted = await boot({
      metadata: STATIC,
      schedule: {
        timeZone: 'America/New_York',
        jobs: {
          'digest.daily': { cron: '0 7 * * *', maxDuration: false },
          off: { enabled: true, timeZone: 'Asia/Tokyo' },
          'status.refresh': { every: '5m', overlap: 'queue' },
          warm: { delay: '1s' },
        },
      },
    })
    const jobs = Object.fromEntries(booted.registry.jobs().map(job => [job.name, job]))
    expect(jobs['digest.daily']).toMatchObject({ schedule: '0 7 * * * (Europe/Paris)', maxDuration: undefined })
    expect(jobs['off']).toMatchObject({ state: 'scheduled', schedule: '@daily (Asia/Tokyo)' })
    expect(jobs['status.refresh']).toMatchObject({ every: 300_000, overlap: 'queue' })
    expect(jobs['warm']).toMatchObject({ delay: 1000 })

    await expect(boot({ metadata: STATIC, schedule: { jobs: { 'digest.dail': { enabled: false } } } })).rejects.toThrow(
      "ZNIGHT042: SchedulePlugin option 'jobs': no job named 'digest.dail' (did you mean 'digest.daily'?)",
    )
    await expect(boot({ metadata: STATIC, schedule: { jobs: { warm: { cron: '@daily' } } } })).rejects.toThrow(
      "'cron' and 'timeZone' apply to cron jobs, this job is a timeout",
    )
    await expect(boot({ metadata: STATIC, schedule: { jobs: { 'digest.daily': { every: '1m' } } } })).rejects.toThrow(
      "'every' applies to intervals, this job is a cron job",
    )
    await expect(
      boot({ metadata: STATIC, schedule: { jobs: { 'digest.daily': { cron: '0 25 * * *' } } } }),
    ).rejects.toThrow("Job 'digest.daily': invalid cron expression '0 25 * * *': hour 25 is out of range (0-23)")
    await expect(boot({ metadata: STATIC, schedule: { jobs: { warm: { overlap: 'queue' } } } })).rejects.toThrow(
      'a timeout has no overlap policy',
    )
    await expect(boot({ metadata: STATIC, schedule: { jobs: { warm: { enabeld: true } as never } } })).rejects.toThrow(
      "unknown key 'enabeld' (did you mean 'enabled'?)",
    )
  })

  it('validates hand-written metadata (ZNIGHT040, ZNIGHT041, ZNIGHT001)', async () => {
    const base = metadataWith()
    const withSection = (schedule: unknown): typeof base => ({ ...base, extensions: { schedule: schedule as never } })
    const job = {
      name: 'job',
      token: 'src/host.ts#Host',
      method: 'run',
      kind: 'cron',
      cron: '@daily',
      invoke: () => undefined,
    }
    await expect(boot({ metadata: withSection({ jobs: 'nope' }) })).rejects.toThrow('"jobs" must be an array')
    await expect(boot({ metadata: withSection({ jobs: [job, job] }) })).rejects.toMatchObject({ code: 'ZNIGHT041' })
    await expect(boot({ metadata: withSection({ jobs: [{ ...job, name: 'bad name' }] }) })).rejects.toMatchObject({
      code: 'ZNIGHT040',
    })
    await expect(boot({ metadata: withSection({ jobs: [{ ...job, token: 'src/x.ts#Missing' }] }) })).rejects.toThrow(
      "ZNIGHT001: Job 'job': no provider is registered for its host src/x.ts#Missing",
    )
    await expect(boot({ metadata: withSection({ jobs: [{ ...job, invoke: undefined }] }) })).rejects.toThrow(
      'no invoker',
    )
    await expect(boot({ metadata: withSection({ jobs: [{ ...job, kind: 'weekly' }] }) })).rejects.toThrow(
      'kind "weekly"',
    )
    await expect(boot({ metadata: withSection({ jobs: [{ ...job, timeZone: 'Mars/Base' }] }) })).rejects.toThrow(
      "unknown time zone 'Mars/Base'",
    )
    await expect(
      boot({ metadata: withSection({ jobs: [{ ...job, kind: 'interval', cron: undefined, every: 0 }] }) }),
    ).rejects.toThrow("Job 'job': the interval must be at least 1 ms")
    await expect(
      boot({
        metadata: withSection({ jobs: [{ ...job, kind: 'timeout', cron: undefined, delay: 5, runOnStart: true }] }),
      }),
    ).rejects.toThrow("invalid 'runOnStart'")
  })
})
