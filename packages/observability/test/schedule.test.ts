/**
 * Instrumentation of `schedule:run` (RFC 0004 §7.9): log entries per outcome, metric names and labels
 * (the `_OTHER` cap included), spans (root of a new trace vs child of the caller for manual runs), and
 * the `job` / `runId` fields of the logger inside a run. The producer is emulated exactly as
 * `@znight/schedule` runs it: executed runs go through `hooks.run()` in a scope seeded with the
 * `JobContext`, then every occurrence is emitted.
 */
import type { Application, ScheduledRunEvent } from '@znight/core'
import type { Entry } from './helpers.ts'

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { Application as App } from '@znight/core'

import { JOB_CONTEXT_TOKEN, type Logger, ObservabilityPlugin, type ObservabilityPluginInstance } from '../src/index.ts'
import { capture, memoryTracing, meta, TRACE_ID, TRACEPARENT } from './helpers.ts'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'

const { provider, exporter } = memoryTracing()

afterEach(() => exporter.reset())

beforeAll(() => {
  expect(TRACEPARENT).toContain(TRACE_ID)
})

interface Run {
  readonly event: ScheduledRunEvent
  readonly context: {
    readonly job: string
    readonly runId: string
    readonly scheduledAt: Date
    readonly startedAt: Date
  }
}

let sequence = 0

/** An executed run: `hooks.run()` in a scope seeded with the context, then `emit`. */
async function execute(
  app: Application,
  job: string,
  body: (run: Run) => unknown = () => undefined,
  overrides: Partial<ScheduledRunEvent> = {},
  lateMs = 0,
): Promise<Run> {
  const scheduledAt = Date.parse('2026-01-01T00:01:00Z')
  const runId = `run-${++sequence}`
  const context = {
    job,
    runId,
    scheduledAt: new Date(scheduledAt),
    startedAt: new Date(scheduledAt + lateMs),
    trigger: overrides.trigger ?? 'schedule',
  }
  const event: ScheduledRunEvent = {
    job,
    kind: 'cron',
    host: 'DigestJobs',
    method: 'send',
    runId,
    trigger: 'schedule',
    scheduledAt,
    context,
    startTime: performance.now(),
    ...overrides,
  }
  const run: Run = { event, context }
  try {
    await app.container.runInScope(
      () =>
        app.hooks.run('schedule:run', event, async () => {
          try {
            await body(run)
          } catch (error) {
            event.outcome = 'failed'
            event.error = error
            throw error
          }
          event.outcome = 'completed'
        }),
      [[JOB_CONTEXT_TOKEN, context]],
    )
  } catch {
    // reported through the event
  }
  if (event.outcome === undefined) event.outcome = 'skipped'
  app.hooks.emit('schedule:run', event)
  return run
}

/** An occurrence that did not execute (overlap, lock refused, lock store failure): only emitted. */
function drop(app: Application, job: string, outcome: 'skipped' | 'not-acquired' | 'failed', error?: unknown): void {
  const event: ScheduledRunEvent = {
    job,
    kind: 'interval',
    host: undefined,
    method: undefined,
    runId: `run-${++sequence}`,
    trigger: 'schedule',
    scheduledAt: Date.parse('2026-01-01T00:02:00Z'),
    context: undefined,
    startTime: performance.now(),
    outcome,
    ...(error === undefined ? {} : { error }),
  }
  app.hooks.emit('schedule:run', event)
}

async function create(
  options: Parameters<typeof ObservabilityPlugin.configure>[0],
): Promise<{ app: Application; plugin: ObservabilityPluginInstance }> {
  const plugin = ObservabilityPlugin.configure(options)
  const app = await App.create({ metadata: meta({}), plugins: [plugin], shutdown: { signals: false } })
  return { app, plugin }
}

function jobEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter(
    entry => typeof entry['job'] === 'string' && typeof entry.msg === 'string' && entry.msg.startsWith('job '),
  )
}

describe('logging.jobs', () => {
  it('writes one entry per settled run, at the level of its outcome', async () => {
    const { stream, entries } = capture()
    const { app } = await create({
      logging: { destination: stream, level: 'debug', replaceCoreLogger: false },
      tracing: false,
      metrics: false,
    })
    await execute(app, 'digest.daily', () => undefined, {}, 1500)
    await execute(app, 'digest.daily', () => {
      throw new Error('smtp down')
    })
    drop(app, 'status.refresh', 'skipped')
    drop(app, 'status.refresh', 'not-acquired')
    drop(app, 'status.refresh', 'failed', new Error('store down'))
    expect(jobEntries(entries).map(entry => [entry.level, entry.msg, entry['job']])).toEqual([
      [30, 'job completed', 'digest.daily'],
      [50, 'job failed', 'digest.daily'],
      [40, 'job skipped', 'status.refresh'],
      [20, 'job not acquired', 'status.refresh'],
      [50, 'job failed', 'status.refresh'],
    ])
    const [completed, failed, skipped, , storeFailure] = jobEntries(entries)
    expect(completed).toMatchObject({ trigger: 'schedule', scheduledAt: '2026-01-01T00:01:00.000Z', lateMs: 1500 })
    expect(typeof completed?.['durationMs']).toBe('number')
    expect(completed?.['runId']).toMatch(/^run-\d+$/)
    expect(failed?.['err']).toMatchObject({ message: 'smtp down' })
    expect(skipped).not.toHaveProperty('durationMs')
    expect(storeFailure?.['err']).toMatchObject({ message: 'store down' })
    await app.stop()
  })

  it('adds job and runId to every entry written inside a run', async () => {
    const { stream, entries } = capture()
    const { app, plugin } = await create({
      logging: { destination: stream, jobs: false },
      tracing: false,
      metrics: false,
    })
    const logger = plugin.logger as Logger
    const run = await execute(app, 'digest.daily', () => {
      logger.info('sending the digest')
    })
    logger.info('outside')
    expect(entries.find(entry => entry.msg === 'sending the digest')).toMatchObject({
      job: 'digest.daily',
      runId: run.context.runId,
    })
    expect(entries.find(entry => entry.msg === 'outside')).not.toHaveProperty('job')
    expect(jobEntries(entries)).toEqual([])
    await app.stop()
  })

  it('honours the level and ignore options, and jobContext: false', async () => {
    const { stream, entries } = capture()
    const { app, plugin } = await create({
      logging: {
        destination: stream,
        jobContext: false,
        jobs: { level: 'debug', ignore: event => event.job === 'noisy' },
        level: 'debug',
      },
      tracing: false,
      metrics: false,
    })
    await execute(app, 'quiet', () => {
      ;(plugin.logger as Logger).info('inside')
    })
    await execute(app, 'noisy')
    drop(app, 'noisy', 'skipped')
    expect(jobEntries(entries).map(entry => [entry.level, entry['job']])).toEqual([[20, 'quiet']])
    expect(entries.find(entry => entry.msg === 'inside')).not.toHaveProperty('runId')
    await expect(create({ logging: { jobs: { level: 'loud' as never } } })).rejects.toThrow('logging.jobs.level')
    await app.stop()
  })
})

describe('metrics.schedule', () => {
  it('counts every outcome, times executed runs, tracks lateness, active runs and the last success', async () => {
    const { app, plugin } = await create({
      logging: { destination: capture().stream },
      tracing: false,
      metrics: { defaultMetrics: false, server: false },
    })
    await execute(
      app,
      'digest.daily',
      async () => {
        const body = await plugin.metrics?.metrics()
        expect(body).toContain('schedule_active_runs{job="digest.daily"} 1')
      },
      {},
      250,
    )
    await execute(app, 'digest.daily', () => {
      throw new Error('x')
    })
    drop(app, 'digest.daily', 'not-acquired')
    drop(app, 'digest.daily', 'skipped')
    const body = (await plugin.metrics?.metrics()) ?? ''
    expect(body).toContain('schedule_runs_total{job="digest.daily",outcome="completed"} 1')
    expect(body).toContain('schedule_runs_total{job="digest.daily",outcome="failed"} 1')
    expect(body).toContain('schedule_runs_total{job="digest.daily",outcome="not-acquired"} 1')
    expect(body).toContain('schedule_runs_total{job="digest.daily",outcome="skipped"} 1')
    expect(body).toContain('schedule_run_duration_seconds_count{job="digest.daily",outcome="completed"} 1')
    expect(body).toContain('schedule_run_duration_seconds_count{job="digest.daily",outcome="failed"} 1')
    expect(body).not.toContain('outcome="not-acquired"} 1\nschedule_run_duration')
    expect(body).toContain('schedule_run_lateness_seconds_bucket{le="0.5",job="digest.daily"} 2')
    expect(body).toContain('schedule_run_lateness_seconds_bucket{le="0.1",job="digest.daily"} 1')
    expect(body).toContain('schedule_active_runs{job="digest.daily"} 0')
    const lastSuccess = /schedule_last_success_timestamp_seconds\{job="digest.daily"\} ([\d.e+]+)/.exec(body)
    expect(Number(lastSuccess?.[1])).toBeGreaterThanOrEqual(Date.parse('2026-01-01T00:01:00.250Z') / 1000)
    expect(Number(lastSuccess?.[1])).toBeLessThan(Date.parse('2026-01-01T00:02:00Z') / 1000)
    await app.stop()
  })

  it('caps the job label at maxJobs distinct names (_OTHER)', async () => {
    const { app, plugin } = await create({
      logging: { destination: capture().stream },
      tracing: false,
      metrics: { defaultMetrics: false, server: false, schedule: { maxJobs: 2 } },
    })
    for (const job of ['monitor.1', 'monitor.2', 'monitor.3', 'monitor.4', 'monitor.1']) await execute(app, job)
    const body = (await plugin.metrics?.metrics()) ?? ''
    expect(body).toContain('schedule_runs_total{job="monitor.1",outcome="completed"} 2')
    expect(body).toContain('schedule_runs_total{job="monitor.2",outcome="completed"} 1')
    expect(body).toContain('schedule_runs_total{job="_OTHER",outcome="completed"} 2')
    expect(body).not.toContain('monitor.3')
    await expect(create({ metrics: { server: false, schedule: { maxJobs: 0 } } })).rejects.toThrow(
      'metrics.schedule.maxJobs',
    )
    await app.stop()
  })
})

describe('tracing.schedule', () => {
  it('starts a root INTERNAL span per scheduled run, a child of the caller for manual runs', async () => {
    const { app, plugin } = await create({
      logging: { destination: capture().stream },
      tracing: { tracerProvider: provider },
      metrics: false,
    })
    const tracer = plugin.tracer
    // a scheduled run fired while a request span happens to be active: still a new trace
    await tracer?.withSpan('incoming request', async () => {
      await execute(app, 'digest.daily', () => {
        expect(trace.getActiveSpan()?.spanContext().traceId).toBeDefined()
      })
      await execute(app, 'digest.daily', () => undefined, { trigger: 'manual' })
    })
    await execute(app, 'digest.daily', () => {
      throw new Error('smtp down')
    })
    drop(app, 'digest.daily', 'not-acquired')
    const spans = exporter.getFinishedSpans()
    const request = spans.find(span => span.name === 'incoming request')
    const jobs = spans.filter(span => span.name === 'schedule digest.daily')
    expect(jobs).toHaveLength(3)
    const [scheduled, manual, failed] = jobs
    expect(scheduled?.kind).toBe(SpanKind.INTERNAL)
    expect(scheduled?.parentSpanContext).toBeUndefined()
    expect(scheduled?.spanContext().traceId).not.toBe(request?.spanContext().traceId)
    expect(manual?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId)
    expect(scheduled?.attributes).toMatchObject({
      'znight.schedule.job': 'digest.daily',
      'znight.schedule.kind': 'cron',
      'znight.schedule.trigger': 'schedule',
      'znight.schedule.scheduled_at': '2026-01-01T00:01:00.000Z',
      'znight.schedule.outcome': 'completed',
      'code.function.name': 'DigestJobs.send',
    })
    expect(scheduled?.attributes['znight.schedule.run_id']).toMatch(/^run-\d+$/)
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR)
    expect(failed?.events.map(event => event.name)).toContain('exception')
    await app.stop()
  })

  it('logs inside the span: run entries carry the trace context', async () => {
    const { stream, entries } = capture()
    const { app } = await create({
      logging: { destination: stream },
      tracing: { tracerProvider: provider },
      metrics: false,
    })
    await execute(app, 'digest.daily')
    const span = exporter.getFinishedSpans().find(candidate => candidate.name === 'schedule digest.daily')
    expect(jobEntries(entries)[0]).toMatchObject({ traceId: span?.spanContext().traceId })
    await app.stop()
  })
})

it('honours disabled features', async () => {
  const { stream, entries } = capture()
  const { app, plugin } = await create({
    logging: { destination: stream, jobs: false, replaceCoreLogger: false },
    tracing: { tracerProvider: provider, schedule: false },
    metrics: { defaultMetrics: false, server: false, schedule: false },
  })
  await execute(app, 'digest.daily')
  drop(app, 'digest.daily', 'skipped')
  expect(jobEntries(entries)).toEqual([])
  expect(exporter.getFinishedSpans()).toEqual([])
  expect(await plugin.metrics?.metrics()).not.toContain('schedule_')
  await app.stop()
  // hooks are removed on dispose
  await execute(app, 'after')
})
