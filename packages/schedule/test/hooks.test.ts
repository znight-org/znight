/**
 * The `schedule:run` hook (RFC 0004 §7.4, §7.9): wrappers see executed runs, listeners every
 * occurrence; a wrapper that does not call `next()` vetoes the run; failures are logged once.
 */
import type { ScheduledRunEvent } from '@znight/core'

import { memoryLockStore } from '../src/index.ts'
import { boot, deferred, HOST, metadataWith, testClock } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('schedule:run', () => {
  it('wraps executed runs, then emits them; occurrences that did not run are only emitted', async () => {
    const clock = testClock('2026-01-01T00:00:00Z')
    const lock = memoryLockStore({ clock })
    const release = deferred()
    const metadata = metadataWith([
      { name: 'job', kind: 'interval', every: 60_000, run: () => release.promise, token: HOST, method: 'sync' },
    ])
    await using other = await boot({ clock, metadata, schedule: { lock } })
    await using booted = await boot({ clock, metadata, schedule: { lock } })
    const wrapped: string[] = []
    const emitted: string[] = []
    booted.app.hooks.wrap('schedule:run', async (event, next) => {
      wrapped.push(`${event.trigger}:${event.context === undefined ? 'no-context' : 'context'}`)
      await next()
      wrapped.push(`after:${event.outcome}`)
    })
    booted.app.hooks.on('schedule:run', event => {
      emitted.push(String(event.outcome))
    })
    await clock.advance('2m') // 00:01 runs on one instance; 00:02 is skipped there and refused elsewhere
    release.resolve()
    await booted.registry.idle()
    await other.registry.idle()
    // whatever instance won 00:01, this one saw either the run or a refusal, then a skip or a refusal
    expect(emitted.length).toBe(2)
    expect(wrapped.filter(entry => entry.startsWith('after:')).every(entry => entry === 'after:completed')).toBe(true)
    expect(wrapped.length).toBe(2 * emitted.filter(outcome => outcome === 'completed').length)
  })

  it('fills the event (job, kind, host, method, run id, trigger, occurrence, context, outcome)', async () => {
    const events: ScheduledRunEvent[] = []
    const failure = new Error('boom')
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'report',
          kind: 'cron',
          cron: '* * * * *',
          method: 'build',
          run: () => {
            throw failure
          },
        },
      ]),
    })
    booted.app.hooks.on('schedule:run', event => {
      events.push(event)
    })
    await booted.clock.advance('1m')
    const event = events[0]
    expect(event).toMatchObject({
      job: 'report',
      kind: 'cron',
      host: 'Host',
      method: 'build',
      trigger: 'schedule',
      scheduledAt: Date.parse('2026-01-01T00:01:00Z'),
      outcome: 'failed',
      error: failure,
    })
    expect(event?.context).toMatchObject({ job: 'report', runId: event?.runId })
    expect(typeof event?.startTime).toBe('number')
    // dynamic jobs have no host
    booted.registry.addTimeout('dynamic', 0, () => undefined)
    await booted.clock.advance(0) // due now: the timer fires on the next turn
    expect(events[1]).toMatchObject({
      job: 'dynamic',
      kind: 'timeout',
      host: undefined,
      method: undefined,
      outcome: 'completed',
    })
  })

  it("a wrapper that does not call next() vetoes the run: 'skipped'", async () => {
    let ran = false
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'maintenance',
          kind: 'cron',
          cron: '* * * * *',
          run: () => {
            ran = true
          },
        },
      ]),
    })
    booted.app.hooks.wrap('schedule:run', async () => undefined)
    await booted.clock.advance('1m')
    expect(ran).toBe(false)
    expect(booted.registry.get('maintenance')?.lastRun).toMatchObject({ outcome: 'skipped' })
    expect(booted.registry.get('maintenance')?.lastRun?.startedAt).toBeDefined()
  })

  it('a failing wrapper fails the run', async () => {
    const failure = new Error('wrapper failed')
    await using booted = await boot({ metadata: metadataWith([{ name: 'job', kind: 'cron', cron: '* * * * *' }]) })
    booted.app.hooks.wrap('schedule:run', () => Promise.reject(failure))
    await booted.clock.advance('1m')
    expect(booted.registry.get('job')?.lastRun).toMatchObject({ outcome: 'failed', error: failure })
  })
})

describe('failure logs', () => {
  it('logs the error with its stack without wrapper, its message only with a wrapper (the observer logs it)', async () => {
    const failure = new Error('database down')
    await using plain = await boot({
      metadata: metadataWith([
        {
          name: 'job',
          kind: 'cron',
          cron: '* * * * *',
          run: () => {
            throw failure
          },
        },
      ]),
    })
    await plain.clock.advance('1m')
    expect(plain.logs.entries.find(entry => entry.level === 'error')).toMatchObject({
      message: "Schedule: job 'job' failed",
      context: { job: 'job', trigger: 'schedule', err: failure },
    })

    await using wrapped = await boot({
      metadata: metadataWith([
        {
          name: 'job',
          kind: 'cron',
          cron: '* * * * *',
          run: () => {
            throw failure
          },
        },
      ]),
    })
    wrapped.app.hooks.wrap('schedule:run', (_event, next) => next())
    await wrapped.clock.advance('1m')
    const entry = wrapped.logs.entries.find(candidate => candidate.level === 'error')
    expect(entry?.context).toMatchObject({ error: 'database down' })
    expect(entry?.context).not.toHaveProperty('err')
  })
})
