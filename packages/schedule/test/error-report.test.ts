/**
 * The `error:report` hook: one report per failed run (the job threw, a wrapper failed before it,
 * the lock store failed), none for completed, skipped or refused occurrences, nor for a run that
 * honoured an abort the application asked for (shutdown, removal).
 */
import type { Application, ErrorReportEvent } from '@znight/core'
import type { JobContext } from '../src/index.ts'

import { setTimeout as sleep } from 'node:timers/promises'

import { JobAbortedError } from '../src/index.ts'
import { aborted, boot, metadataWith } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

function record(booted: { readonly app: Application }): ErrorReportEvent[] {
  const reports: ErrorReportEvent[] = []
  booted.app.hooks.on('error:report', report => {
    reports.push(report)
  })
  return reports
}

describe('error:report', () => {
  it('reports a failed run once, with the job context', async () => {
    const failure = new Error('database down')
    await using booted = await boot({
      metadata: metadataWith([
        {
          name: 'digest.daily',
          kind: 'cron',
          cron: '* * * * *',
          method: 'send',
          run: () => {
            throw failure
          },
        },
      ]),
    })
    const reports = record(booted)
    await booted.clock.advance('1m')
    expect(reports).toHaveLength(1)
    const report = reports[0] as ErrorReportEvent
    expect(report.error).toBe(failure)
    expect(report.source).toBe('schedule')
    expect(report.operation).toBe('digest.daily')
    expect(report.requestId).toBeUndefined()
    const runId = booted.registry.get('digest.daily')?.lastRun?.runId as string
    expect(report.tags).toEqual({
      job: 'digest.daily',
      kind: 'cron',
      host: 'Host',
      method: 'send',
      runId,
      trigger: 'schedule',
    })
    expect((report.context as JobContext).runId).toBe(runId)
  })

  it('reports a wrapper failing before the job, and a lock store failure', async () => {
    const wrapperFailure = new Error('wrapper failed')
    await using wrapped = await boot({ metadata: metadataWith([{ name: 'job', kind: 'cron', cron: '* * * * *' }]) })
    const wrappedReports = record(wrapped)
    wrapped.app.hooks.wrap('schedule:run', () => Promise.reject(wrapperFailure))
    await wrapped.clock.advance('1m')
    expect(wrappedReports.map(report => report.error)).toEqual([wrapperFailure])

    const storeFailure = new Error('redis down')
    await using locked = await boot({
      schedule: { lock: { name: 'broken', acquire: () => Promise.reject(storeFailure) } },
      metadata: metadataWith([{ name: 'job', kind: 'cron', cron: '* * * * *' }]),
    })
    const lockedReports = record(locked)
    await locked.clock.advance('1m')
    expect(lockedReports).toHaveLength(1)
    expect(lockedReports[0]?.error).toBe(storeFailure)
    expect(lockedReports[0]?.context).toBeUndefined()
    expect(lockedReports[0]?.tags['job']).toBe('job')
  })

  it('does not report completed or skipped runs', async () => {
    await using booted = await boot({
      metadata: metadataWith([
        { name: 'ok', kind: 'cron', cron: '* * * * *' },
        { name: 'vetoed', kind: 'cron', cron: '* * * * *' },
      ]),
    })
    const reports = record(booted)
    booted.app.hooks.wrap('schedule:run', async (event, next) => {
      if (event.job !== 'vetoed') await next()
    })
    await booted.clock.advance('2m')
    expect(booted.registry.get('ok')?.lastRun?.outcome).toBe('completed')
    expect(booted.registry.get('vetoed')?.lastRun?.outcome).toBe('skipped')
    expect(reports).toEqual([])
  })

  it('does not report a run that honours the abort of a shutdown or a removal', async () => {
    const booted = await boot({
      metadata: metadataWith([
        {
          name: 'poller',
          kind: 'cron',
          cron: '* * * * *',
          // rejects with an AbortError whose cause is the abort reason, like fetch() on Node.js
          run: ctx => sleep(60_000, undefined, { signal: ctx.signal }),
        },
        {
          name: 'monitor',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            await aborted(ctx.signal)
            ctx.signal.throwIfAborted()
          },
        },
      ]),
    })
    const reports = record(booted)
    const runs: string[] = []
    booted.app.hooks.on('schedule:run', event => {
      runs.push(`${event.job}: ${event.outcome} (${event.aborted})`)
    })
    await booted.clock.advance('1m')
    booted.registry.remove('monitor', { abort: true })
    await booted.app.stop()
    expect(runs.sort()).toEqual(['monitor: failed (removed)', 'poller: failed (shutdown)'])
    // still logged: only the report is left out
    expect(booted.logs.messages('error')).toContain("Schedule: job 'monitor' failed")
    expect(reports).toEqual([])
  })

  it('still reports a timeout abort, and another error after a shutdown abort', async () => {
    const failure = new Error('connection reset')
    const booted = await boot({
      metadata: metadataWith([
        {
          name: 'slow',
          kind: 'cron',
          cron: '* * * * *',
          maxDuration: 1000,
          run: async ctx => {
            await aborted(ctx.signal)
            ctx.signal.throwIfAborted()
          },
        },
        {
          name: 'flaky',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            await aborted(ctx.signal)
            throw failure
          },
        },
      ]),
    })
    const reports = record(booted)
    await booted.clock.advance('61s')
    await booted.app.stop()
    expect(reports.map(report => [report.operation, report.tags['aborted']])).toEqual([
      ['slow', 'timeout'],
      ['flaky', 'shutdown'],
    ])
    expect(reports[0]?.error).toBeInstanceOf(JobAbortedError)
    expect(reports[1]?.error).toBe(failure)
  })
})
