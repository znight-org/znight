/**
 * Overlap policies and `maxDuration` (RFC 0004 §7.5, §7.7).
 */
import type { ScheduledRunEvent } from '@znight/core'
import type { JobContext } from '../src/context.ts'

import { JobAbortedError } from '../src/index.ts'
import { aborted, boot, deferred, metadataWith } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('overlap', () => {
  it("skip (default): an occurrence firing during a run is dropped, emitted and logged at 'warn'", async () => {
    const release = deferred()
    const runs: string[] = []
    const events: ScheduledRunEvent[] = []
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'slow',
          kind: 'interval',
          every: 60_000,
          run: async ctx => {
            runs.push(ctx.scheduledAt.toISOString())
            await release.promise
          },
        },
      ]),
    })
    booted.app.hooks.on('schedule:run', event => {
      events.push(event)
    })
    await booted.clock.advance('2m')
    expect(runs).toEqual(['2026-01-01T00:01:00.000Z'])
    expect(events.map(event => [event.outcome, event.context === undefined])).toEqual([['skipped', true]])
    const warning = booted.logs.entries.find(entry => entry.level === 'warn')
    expect(warning?.message).toBe("Schedule: job 'slow' skipped: its previous run has been running for 60000 ms")
    expect(booted.registry.get('slow')?.lastRun).toMatchObject({ outcome: 'skipped', startedAt: undefined })
    // a manual trigger follows the policy: skipped at once
    expect((await booted.registry.trigger('slow')).outcome).toBe('skipped')
    release.resolve()
    await booted.registry.idle()
    expect(events.map(event => event.outcome)).toEqual(['skipped', 'skipped', 'completed'])
  })

  it('queue: one pending run (the latest occurrence), started when the current run settles', async () => {
    let release = deferred()
    const runs: string[] = []
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'queued',
          kind: 'interval',
          every: 60_000,
          overlap: 'queue',
          run: async ctx => {
            runs.push(`${ctx.trigger}@${ctx.scheduledAt.toISOString().slice(11, 16)}`)
            await release.promise
          },
        },
      ]),
    })
    await booted.clock.advance('3m') // 00:01 runs, 00:02 then 00:03 are queued: one pending run
    expect(runs).toEqual(['schedule@00:01'])
    const manual = booted.registry.trigger('queued') // joins the pending run
    const first = release
    release = deferred()
    first.resolve()
    await booted.clock.settle()
    expect(runs).toEqual(['schedule@00:01', 'queued@00:03'])
    release.resolve()
    const result = await manual
    expect(result).toMatchObject({ trigger: 'queued', outcome: 'completed' })
    expect(result.scheduledAt.toISOString()).toBe('2026-01-01T00:03:00.000Z')
    await booted.registry.idle()
  })

  it('allow: runs concurrently and implies lock: false', async () => {
    const release = deferred()
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'parallel', kind: 'interval', every: 60_000, overlap: 'allow', run: () => release.promise },
      ]),
    })
    await booted.clock.advance('2m')
    const job = booted.registry.get('parallel')
    expect(job?.running).toBe(2)
    expect(job?.overlap).toBe('allow')
    release.resolve()
    await booted.registry.idle()
  })
})

describe('maxDuration', () => {
  it("aborts ctx.signal with JobAbortedError('timeout'), keeps the overlap slot until the run settles", async () => {
    const release = deferred()
    let reason: unknown
    const runs: JobContext[] = []
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'stubborn',
          kind: 'interval',
          every: 60_000,
          maxDuration: 10_000,
          run: async ctx => {
            runs.push(ctx)
            reason = await aborted(ctx.signal)
            await release.promise // ignores its signal for a while
          },
        },
      ]),
    })
    await booted.clock.advance('70s')
    expect(reason).toBeInstanceOf(JobAbortedError)
    expect(reason).toMatchObject({ code: 'ZNIGHT044', reason: 'timeout', job: 'stubborn' })
    expect(booted.logs.messages('warn')[0]).toMatch(/exceeded its maxDuration \(10000 ms\): aborting it/)
    await booted.clock.advance('60s') // 00:02 is skipped: the aborted run still holds the slot
    expect(runs).toHaveLength(1)
    expect(booted.registry.get('stubborn')?.lastRun?.outcome).toBe('skipped')
    release.resolve()
    await booted.registry.idle()
    expect(booted.registry.get('stubborn')?.lastRun).toMatchObject({ outcome: 'completed', aborted: 'timeout' })
  })

  it('a job that honours its signal ends early (failed with the abort reason)', async () => {
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'cooperative',
          kind: 'cron',
          cron: '* * * * *',
          maxDuration: 1000,
          run: async ctx => {
            await aborted(ctx.signal)
            ctx.signal.throwIfAborted()
          },
        },
      ]),
    })
    await booted.clock.advance('61s')
    const last = booted.registry.get('cooperative')?.lastRun
    expect(last).toMatchObject({ outcome: 'failed', aborted: 'timeout' })
    expect(last?.error).toBeInstanceOf(JobAbortedError)
    expect(last?.finishedAt?.toISOString()).toBe('2026-01-01T00:01:01.000Z')
  })
})
