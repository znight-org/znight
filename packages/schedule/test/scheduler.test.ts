/**
 * The scheduler (RFC 0004 §7.2, §7.3): deadlines in order, name tie-break, epoch-aligned intervals,
 * `runOnStart`, timeouts, the 60 s resync after a wall-clock jump, late wake-ups, backward jumps,
 * timers capped below 2^31 − 1 ms, and the keep-alive.
 */

import type { JobContext } from '../src/context.ts'
import type { ScheduleClock } from '../src/index.ts'

import { MAX_TIMER_DELAY, systemClock } from '../src/index.ts'
import { createTestClock } from '../src/testing/index.ts'
import { boot, deferred, iso, metadataWith } from './helpers.ts'
import { afterEach, describe, expect, test as it } from 'bun:test'

describe('occurrences', () => {
  it('fires due jobs in deadline order, ties broken by name', async () => {
    const order: string[] = []
    const record = (ctx: JobContext): void => {
      order.push(`${ctx.job}@${ctx.scheduledAt.toISOString().slice(11, 19)}`)
    }
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'b', kind: 'cron', cron: '* * * * *', run: record },
        { name: 'a', kind: 'cron', cron: '* * * * *', run: record },
        { name: 'c', kind: 'cron', cron: '30 * * * * *', run: record },
      ]),
    })
    await booted.clock.advance('2m')
    expect(order).toEqual(['c@00:00:30', 'a@00:01:00', 'b@00:01:00', 'c@00:01:30', 'a@00:02:00', 'b@00:02:00'])
  })

  it('aligns intervals on the Unix epoch (restarts never starve a long interval)', async () => {
    const clock = createTestClock('2026-01-01T00:00:10Z')
    const seen: number[] = []
    await using booted = await boot({
      clock,
      metadata: metadataWith([
        { name: 'seven', kind: 'interval', every: 7 * 60_000, run: ctx => seen.push(ctx.scheduledAt.getTime()) },
      ]),
    })
    const every = 7 * 60_000
    const first = Math.ceil(Date.parse('2026-01-01T00:00:10Z') / every) * every
    expect(booted.registry.get('seven')?.nextRun?.getTime()).toBe(first)
    await clock.advance('15m')
    expect(seen).toEqual([first, first + every])
    expect(seen.every(at => at % every === 0)).toBe(true)
  })

  it('runs runOnStart jobs at start, then on schedule', async () => {
    const runs: JobContext[] = []
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'refresh', kind: 'interval', every: 60_000, runOnStart: true, run: ctx => runs.push(ctx) },
      ]),
    })
    await booted.clock.settle()
    expect(runs.map(ctx => [ctx.trigger, ctx.scheduledAt.toISOString()])).toEqual([
      ['start', '2026-01-01T00:00:00.000Z'],
    ])
    await booted.clock.advance('1m')
    expect(runs.map(ctx => ctx.trigger)).toEqual(['start', 'schedule'])
    expect(runs[1]?.previous).toEqual({ scheduledAt: new Date('2026-01-01T00:00:00Z'), outcome: 'completed' })
  })

  it('runs a timeout once, delay after the start (0: right at start)', async () => {
    const runs: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'warm', kind: 'timeout', delay: 0, run: ctx => runs.push(`warm@${ctx.scheduledAt.toISOString()}`) },
        {
          name: 'later',
          kind: 'timeout',
          delay: 5000,
          run: ctx => runs.push(`later@${ctx.scheduledAt.toISOString()}`),
        },
      ]),
    })
    await booted.clock.settle()
    expect(runs).toEqual(['warm@2026-01-01T00:00:00.000Z'])
    expect(booted.registry.get('later')?.nextRun?.toISOString()).toBe('2026-01-01T00:00:05.000Z')
    await booted.clock.advance('1h')
    expect(runs).toEqual(['warm@2026-01-01T00:00:00.000Z', 'later@2026-01-01T00:00:05.000Z'])
    expect(booted.registry.get('later')?.state).toBe('done')
    expect(booted.registry.get('later')?.nextRun).toBeUndefined()
  })

  it('arms the next occurrence when one fires, not when its run settles', async () => {
    const release = deferred()
    const started: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'slow',
          kind: 'interval',
          every: 60_000,
          overlap: 'allow',
          run: async ctx => {
            started.push(ctx.scheduledAt.toISOString())
            await release.promise
          },
        },
      ]),
    })
    await booted.clock.advance('3m')
    expect(started).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'])
    expect(booted.registry.get('slow')?.running).toBe(3)
    release.resolve()
    await booted.registry.idle()
    expect(booted.registry.get('slow')?.running).toBe(0)
  })
})

describe('clock', () => {
  it('resyncs with the wall clock at least every 60 s and runs a late job once (latest occurrence)', async () => {
    const runs: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'minutely', kind: 'cron', cron: '* * * * *', run: ctx => runs.push(ctx.scheduledAt.toISOString()) },
      ]),
    })
    // the machine slept, or NTP stepped the clock: the timer still has its delay
    booted.clock.setWallClock('2026-01-01T00:10:30Z')
    await booted.clock.advance('1m')
    expect(runs).toEqual(['2026-01-01T00:11:00.000Z'])
    expect(booted.logs.messages('debug').some(message => message.includes('11 missed occurrence(s) skipped'))).toBe(
      false,
    )
    const late = booted.logs.entries.find(entry => entry.message.includes('woke up late'))
    expect(late?.context).toMatchObject({ job: 'minutely', missed: 10 })
  })

  it('never runs an occurrence twice after a backward jump', async () => {
    const runs: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'minutely', kind: 'cron', cron: '* * * * *', run: ctx => runs.push(ctx.scheduledAt.toISOString()) },
      ]),
    })
    await booted.clock.advance('1m')
    booted.clock.setWallClock('2026-01-01T00:00:30Z')
    await booted.clock.advance('3m')
    expect(runs).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'])
  })

  it('arms one timer, capped at 60 s, whatever the number of jobs', async () => {
    const delays: number[] = []
    const inner = createTestClock('2026-01-01T00:00:00Z')
    const spy: ScheduleClock = {
      now: () => inner.now(),
      setTimer: (fn, ms) => {
        delays.push(ms)
        return inner.setTimer(fn, ms)
      },
      clearTimer: handle => inner.clearTimer(handle),
      track: run => inner.track(run),
    }
    await using booted = await boot({
      clock: inner,
      schedule: { clock: spy },
      metadata: metadataWith([
        { name: 'yearly', kind: 'cron', cron: '@yearly' },
        { name: 'hourly', kind: 'cron', cron: '@hourly' },
        { name: 'interval', kind: 'interval', every: 30 * 86_400_000 },
      ]),
    })
    expect(inner.pendingTimers).toBe(1)
    await inner.advance('5m')
    expect(inner.pendingTimers).toBe(1)
    expect(Math.max(...delays)).toBe(60_000)
    expect(booted.registry.get('yearly')?.nextRun?.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('systemClock', () => {
  const real = globalThis.setTimeout
  afterEach(() => {
    globalThis.setTimeout = real
  })

  it('splits delays above 2^31 − 1 ms (Node would fire them after 1 ms)', () => {
    const calls: number[] = []
    const callbacks: (() => void)[] = []
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      calls.push(ms)
      callbacks.push(fn)
      return real(() => undefined, 0)
    }) as unknown as typeof setTimeout
    let fired = false
    const handle = systemClock.setTimer(() => {
      fired = true
    }, MAX_TIMER_DELAY + 5)
    expect(calls).toEqual([MAX_TIMER_DELAY])
    callbacks[0]?.()
    expect(calls).toEqual([MAX_TIMER_DELAY, 5])
    expect(fired).toBe(false)
    callbacks[1]?.()
    expect(fired).toBe(true)
    systemClock.clearTimer(handle)
    systemClock.clearTimer(undefined)
  })

  it('keeps the process alive only while the scheduler runs', async () => {
    let live = 0
    const counting: ScheduleClock = {
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        live++
        return systemClock.setTimer(() => {
          live--
          fn()
        }, ms)
      },
      clearTimer: handle => {
        if ((handle as { handle?: unknown }).handle !== undefined) live--
        systemClock.clearTimer(handle)
      },
    }
    const booted = await boot({ schedule: { clock: counting }, start: false })
    expect(live).toBe(0)
    await booted.app.start()
    expect(live).toBe(1) // no job: still one timer (60 s resync), the keep-alive
    await booted.app.stop()
    expect(live).toBe(0)
    const disabled = await boot({ schedule: { clock: counting, enabled: false } })
    expect(live).toBe(0)
    await disabled.app.stop()
  })
})

describe('JobContext', () => {
  it('carries the run, its occurrence and lateness, and the previous run', async () => {
    const runs: JobContext[] = []
    await using booted = await boot({
      metadata: metadataWith([{ name: 'job', kind: 'cron', cron: '0 * * * *', run: ctx => runs.push(ctx) }]),
    })
    await booted.clock.advance('2h')
    expect(runs.map(ctx => ctx.job)).toEqual(['job', 'job'])
    expect(iso(runs.map(ctx => ctx.scheduledAt))).toEqual(['2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z'])
    expect(iso(runs.map(ctx => ctx.startedAt))).toEqual(['2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z'])
    expect(runs[0]?.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(runs[0]?.runId).not.toBe(runs[1]?.runId)
    expect(runs[0]?.previous).toBeUndefined()
    expect(runs[1]?.previous?.outcome).toBe('completed')
    expect(runs[0]?.signal.aborted).toBe(false)
    expect(Object.isFrozen(runs[0])).toBe(true)
  })
})
