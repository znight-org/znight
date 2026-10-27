/**
 * Graceful shutdown (RFC 0004 §7.1, §7.7): abort at stop, drain, abandon after `drainTimeoutMs`,
 * `stop()` from inside a run, queued runs dropped, nothing armed when the plugin is disabled or the
 * application stopped during its start.
 */
import type { Plugin } from '@znight/core'

import { aborted, boot, deferred, metadataWith } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('onStop', () => {
  it("aborts running runs at once ('shutdown') and waits for them", async () => {
    let reason: unknown
    let finished = false
    const booted = await boot({
      metadata: metadataWith([
        {
          name: 'batch',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            reason = await aborted(ctx.signal)
            await new Promise(resolve => setTimeout(resolve, 5)) // checkpoint, then return early
            finished = true
          },
        },
      ]),
    })
    await booted.clock.advance('1m')
    expect(booted.registry.get('batch')?.running).toBe(1)
    await booted.app.stop()
    expect(reason).toMatchObject({ code: 'ZNIGHT044', reason: 'shutdown' })
    expect(finished).toBe(true)
    expect(booted.plugin.state).toBe('stopped')
    expect(booted.logs.messages('warn').filter(message => message.includes('abandoned'))).toEqual([])
  })

  it('abandons the runs still in flight after drainTimeoutMs, and logs them', async () => {
    const never = deferred()
    const booted = await boot({
      schedule: { drainTimeoutMs: 20 },
      metadata: metadataWith([{ name: 'stuck', kind: 'cron', cron: '* * * * *', run: () => never.promise }]),
    })
    await booted.clock.advance('1m')
    const started = performance.now()
    await booted.app.stop()
    expect(performance.now() - started).toBeLessThan(2000)
    const warning = booted.logs.entries.find(entry => entry.message.includes('abandoned'))
    expect(warning?.message).toMatch(
      /^Schedule: run [0-9a-f-]+ of job 'stuck' abandoned after 0 ms: it did not settle within drainTimeoutMs$/,
    )
    expect(warning?.context).toMatchObject({ job: 'stuck' })
    never.resolve()
  })

  it('does not wait for the run that called stop() (no deadlock)', async () => {
    let stopped: Promise<void> | undefined
    const booted = await boot({
      schedule: { drainTimeoutMs: Number.POSITIVE_INFINITY },
      metadata: metadataWith([
        {
          name: 'last',
          kind: 'timeout',
          delay: 1000,
          run: async ctx => {
            stopped = booted.app.stop()
            await stopped
            expect(ctx.signal.aborted).toBe(true)
          },
        },
      ]),
    })
    await booted.clock.advance('1s')
    await stopped
    expect(booted.app.state).toBe('stopped')
  })

  it('drops queued runs, and rejects new runs and jobs with ZNIGHT021', async () => {
    const release = deferred()
    const booted = await boot({
      metadata: metadataWith([
        { name: 'queued', kind: 'interval', every: 60_000, overlap: 'queue', run: () => release.promise },
      ]),
    })
    await booted.clock.advance('1m')
    const pending = booted.registry.trigger('queued')
    const stopping = booted.app.stop()
    expect((await pending).outcome).toBe('skipped')
    await expect(booted.registry.trigger('queued')).rejects.toMatchObject({ code: 'ZNIGHT021' })
    expect(() => booted.registry.addInterval('late', '1m', () => undefined)).toThrow(
      expect.objectContaining({ code: 'ZNIGHT021' }),
    )
    release.resolve()
    await stopping
    expect(() => booted.registry.jobs()).toThrow('SchedulerRegistry.jobs(): the scheduler is stopped')
  })

  it('never starts a job whose hook wrapper calls next() after stop() began', async () => {
    const gate = deferred()
    const executed: string[] = []
    const booted = await boot({
      metadata: metadataWith([{ name: 'job', kind: 'interval', every: 60_000, run: () => executed.push('ran') }]),
    })
    booted.app.hooks.wrap('schedule:run', async (_event, next) => {
      await gate.promise // a wrapper waiting for a feature flag service...
      await next()
    })
    await booted.clock.advance('1m')
    const stopping = booted.app.stop()
    gate.resolve()
    await stopping
    expect(executed).toEqual([])
    expect(booted.logs.messages('debug')).toContain(
      "Schedule: job 'job' did not run: its run was aborted (shutdown) before it started",
    )
  })

  it('arms nothing when the application stops during its start', async () => {
    let ran = false
    const stopper: Plugin = {
      name: 'stopper',
      onReady(ctx) {
        void ctx.app.stop()
      },
    }
    const booted = await boot({
      plugins: { before: [stopper] },
      metadata: metadataWith([
        {
          name: 'boot',
          kind: 'interval',
          every: 60_000,
          runOnStart: true,
          run: () => {
            ran = true
          },
        },
      ]),
    })
    await booted.clock.advance('5m')
    expect(ran).toBe(false)
    expect(booted.app.state).toBe('stopped')
    expect(booted.clock.pendingTimers).toBe(0)
  })
})

describe('enabled: false', () => {
  it('schedules nothing, but the registry lists, triggers and adds jobs', async () => {
    const runs: string[] = []
    await using booted = await boot({
      schedule: { enabled: false },
      metadata: metadataWith([
        { name: 'digest', kind: 'cron', cron: '* * * * *', runOnStart: true, run: ctx => runs.push(ctx.trigger) },
      ]),
    })
    await booted.clock.advance('10m')
    expect(runs).toEqual([])
    expect(booted.clock.pendingTimers).toBe(0)
    const digest = booted.registry.get('digest')
    expect(digest?.nextRun).toBeUndefined()
    expect(await digest?.trigger()).toMatchObject({ outcome: 'completed', trigger: 'manual' })
    booted.registry.addInterval('dynamic', '1m', ctx => runs.push(ctx.job))
    await booted.clock.advance('2m')
    expect(runs).toEqual(['manual'])
    expect(booted.logs.messages('info')).toContain('Schedule: disabled (1 job(s) declared, none scheduled)')
  })
})
