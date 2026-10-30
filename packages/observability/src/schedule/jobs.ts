/**
 * Instrumentation of the `schedule:run` hook of `@znight/schedule` (RFC 0004 §7.9): logs, metrics and
 * spans of scheduled runs. `@znight/schedule` wraps executed runs with `hooks.run()` (spans,
 * durations, logs of executed runs), then emits every occurrence (counters, last success, logs of
 * occurrences that did not run). A wrapper that does not call `next()` vetoes the run (RFC 0004
 * §7.4): the outer wrappers see `next()` resolve with no outcome, which they report as `skipped`.
 * Read structurally: no dependency on `@znight/schedule`.
 */
import type { Attributes } from '@opentelemetry/api'
import type { HookListener, HookWrapper, ScheduledRunEvent, ScheduledRunOutcome } from '@znight/core'
import type { LogEntryLevel } from '../logging/levels.ts'
import type { Logger } from '../logging/logger.ts'
import type { MetricsRegistry } from '../metrics/registry.ts'
import type { Tracer } from '../tracing/tracer.ts'

import { context as otelContext, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

import { invalidOption } from '../internal/errors.ts'
import { guard } from '../internal/safe.ts'
import { elapsedMs, now, startOf } from '../internal/time.ts'
import { parseEntryLevel } from '../logging/levels.ts'
import { ensureContextManager } from '../tracing/context.ts'
import { SemanticAttributes as Attr } from '../tracing/semconv.ts'
import { recordSpanError } from '../tracing/tracer.ts'

/** Observers of the `schedule:run` hook: a wrapper (executed runs) and a listener (every occurrence). */
export interface ScheduleObserver {
  readonly wrap: HookWrapper<'schedule:run'> | undefined
  readonly listen: HookListener<'schedule:run'> | undefined
}

/** Options of {@link logJobs}. */
export interface JobLogOptions {
  /** Level of completed runs (failed: `error`, skipped: `warn`, not acquired: `debug`). Default: `info`. */
  readonly level?: LogEntryLevel
  /** Runs that are not logged. */
  readonly ignore?: (event: ScheduledRunEvent) => boolean
}

/** Options of {@link measureJobs}. */
export interface ScheduleMetricsOptions {
  /** Buckets of `schedule_run_duration_seconds`. Default: {@link DEFAULT_JOB_DURATION_BUCKETS}. */
  readonly buckets?: readonly number[]
  /** Buckets of `schedule_run_lateness_seconds`. Default: {@link DEFAULT_JOB_LATENESS_BUCKETS}. */
  readonly latenessBuckets?: readonly number[]
  /** Distinct `job` label values (dynamic job names can be unbounded); later jobs are `_OTHER`. Default: 100. */
  readonly maxJobs?: number
  /** Runs that are not measured. */
  readonly ignore?: (event: ScheduledRunEvent) => boolean
}

/** Options of {@link traceJobs}. */
export interface ScheduleTracingOptions {
  /** Runs that are not traced. */
  readonly ignore?: (event: ScheduledRunEvent) => boolean
}

/** Default buckets of run durations, in seconds (jobs last from milliseconds to an hour). */
export const DEFAULT_JOB_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3600,
])

/** Default buckets of run lateness (start minus occurrence), in seconds. */
export const DEFAULT_JOB_LATENESS_BUCKETS: readonly number[] = Object.freeze([
  0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 60,
])

/** Default of {@link ScheduleMetricsOptions.maxJobs}. */
export const DEFAULT_MAX_JOBS = 100

/** `job` label of the jobs beyond {@link ScheduleMetricsOptions.maxJobs}. */
export const OTHER_JOB = '_OTHER'

const LOG_MESSAGES: Readonly<Record<string, string>> = {
  completed: 'job completed',
  failed: 'job failed',
  skipped: 'job skipped',
  'not-acquired': 'job not acquired',
}

/**
 * One log entry per settled run: `info` (completed), `error` (failed, with `err`), `warn` (skipped,
 * vetoed by a wrapper included), `debug` (not acquired: another instance holds the lock). Fields:
 * `job`, `runId`, `trigger`, `scheduledAt`, `durationMs` (runs that went through the wrappers and
 * were not vetoed), `lateMs` (dispatched runs), `aborted`. Runs that reach the wrapper are logged by
 * it (inside their span, so the entry carries `traceId`), the others by the listener: occurrences
 * that did not run, and runs an outer wrapper vetoed or failed before this one.
 */
export function logJobs(logger: Logger, options: JobLogOptions = {}): ScheduleObserver {
  const level = options.level === undefined ? 'info' : parseEntryLevel(options.level, 'logging.jobs.level')
  const ignore = options.ignore
  const record = guard('Logging a scheduled run')
  // runs whose entry the wrapper writes: the listener logs every other occurrence
  const wrapped = new WeakSet<ScheduledRunEvent>()
  const write = (
    event: ScheduledRunEvent,
    outcome: ScheduledRunOutcome,
    started: number | undefined,
    thrown: unknown,
  ): void => {
    const severity = jobSeverity(outcome, level)
    if (!logger.isLevelEnabled(severity)) return
    const entry: Record<string, unknown> = {
      job: event.job,
      runId: event.runId,
      trigger: event.trigger,
      scheduledAt: isoOf(event.scheduledAt),
    }
    if (started !== undefined) entry['durationMs'] = elapsedMs(startOf(event.startTime, started))
    const late = lateness(event)
    if (late !== undefined) entry['lateMs'] = late
    if (event.aborted !== undefined) entry['aborted'] = event.aborted
    const error = event.error ?? thrown
    if (outcome === 'failed' && error !== undefined) entry['err'] = error
    logger.log(severity, LOG_MESSAGES[outcome] ?? 'job failed', entry)
  }
  return {
    wrap: async (event, next) => {
      if (ignore?.(event) === true) return next()
      wrapped.add(event)
      const started = now()
      let failed = false
      let thrown: unknown
      try {
        return await next()
      } catch (error) {
        failed = true
        thrown = error
        throw error
      } finally {
        record(() => {
          const outcome = settledOutcome(event, failed)
          write(event, outcome, outcome === 'skipped' ? undefined : started, thrown)
        })
      }
    },
    listen: event => {
      if (wrapped.has(event) || ignore?.(event) === true) return
      record(() => write(event, event.outcome ?? 'failed', undefined, undefined))
    },
  }
}

/**
 * Metrics of scheduled runs (prefixed with the registry prefix):
 *
 * | Metric | Type | Labels |
 * | --- | --- | --- |
 * | `schedule_runs_total` | counter | `job`, `outcome` (every occurrence) |
 * | `schedule_run_duration_seconds` | histogram | `job`, `outcome` (executed runs, not the vetoed ones) |
 * | `schedule_run_lateness_seconds` | histogram | `job` (dispatched runs reaching the wrapper) |
 * | `schedule_active_runs` | gauge | `job` |
 * | `schedule_last_success_timestamp_seconds` | gauge | `job` ("has not succeeded since" alerts) |
 *
 * At most `maxJobs` distinct job names are labelled (then `_OTHER`): dynamic job names can be unbounded.
 */
export function measureJobs(registry: MetricsRegistry, options: ScheduleMetricsOptions = {}): ScheduleObserver {
  const total = registry.counter('schedule_runs_total', {
    help: 'Number of scheduled job occurrences, by outcome',
    labelNames: ['job', 'outcome'],
  })
  const duration = registry.histogram('schedule_run_duration_seconds', {
    help: 'Duration of scheduled job runs, in seconds',
    labelNames: ['job', 'outcome'],
    buckets: options.buckets ?? DEFAULT_JOB_DURATION_BUCKETS,
  })
  const late = registry.histogram('schedule_run_lateness_seconds', {
    help: 'Delay between the occurrence of a scheduled job and the start of its run, in seconds',
    labelNames: ['job'],
    buckets: options.latenessBuckets ?? DEFAULT_JOB_LATENESS_BUCKETS,
  })
  const active = registry.gauge('schedule_active_runs', {
    help: 'Number of scheduled job runs in flight',
    labelNames: ['job'],
  })
  const lastSuccess = registry.gauge('schedule_last_success_timestamp_seconds', {
    help: 'Time of the last successful run of a scheduled job, in seconds since the epoch',
    labelNames: ['job'],
  })
  const ignore = options.ignore
  const label = boundedJobLabel(options.maxJobs)
  const record = guard('Recording schedule metrics')
  return {
    wrap: async (event, next) => {
      if (ignore?.(event) === true) return next()
      const started = now()
      const job = label(event.job)
      record(() => {
        active.inc({ job })
        const delay = lateness(event)
        if (delay !== undefined) late.observe({ job }, delay / 1000)
      })
      let failed = false
      try {
        return await next()
      } catch (error) {
        failed = true
        throw error
      } finally {
        record(() => {
          active.dec({ job })
          const outcome = settledOutcome(event, failed)
          if (outcome === 'skipped') return // vetoed by an inner wrapper: the job did not run
          duration.observe({ job, outcome }, (now() - startOf(event.startTime, started)) / 1000)
          if (outcome === 'completed') {
            const startedAt = startedAtOf(event)
            const finished = startedAt === undefined ? Date.now() : startedAt + (now() - started)
            lastSuccess.set({ job }, finished / 1000)
          }
        })
      }
    },
    listen: event => {
      if (ignore?.(event) === true) return
      record(() => total.inc({ job: label(event.job), outcome: event.outcome ?? 'failed' }))
    },
  }
}

/**
 * One `INTERNAL` span `schedule <job>` per executed run: the root of a new trace, except for manual
 * runs (`registry.trigger()`), children of the caller (an admin request). Attributes:
 * `znight.schedule.job`, `.kind`, `.trigger`, `.run_id`, `.scheduled_at`, `.outcome`, `.aborted`; the
 * status is `ERROR` when the run failed. A run an inner wrapper vetoed keeps its span, `skipped`.
 */
export function traceJobs(tracer: Tracer, options: ScheduleTracingOptions = {}): HookWrapper<'schedule:run'> {
  const ignore = options.ignore
  const record = guard('Recording a schedule span')
  return (event, next) => {
    if (ignore?.(event) === true) return next()
    const parent = event.trigger === 'manual' ? otelContext.active() : ROOT_CONTEXT
    const attributes: Attributes = {
      [Attr.ZNIGHT_SCHEDULE_JOB]: event.job,
      [Attr.ZNIGHT_SCHEDULE_KIND]: event.kind,
      [Attr.ZNIGHT_SCHEDULE_TRIGGER]: event.trigger,
      [Attr.ZNIGHT_SCHEDULE_RUN_ID]: event.runId,
      [Attr.ZNIGHT_SCHEDULE_SCHEDULED_AT]: isoOf(event.scheduledAt),
    }
    if (event.host !== undefined && event.method !== undefined) {
      attributes[Attr.CODE_FUNCTION_NAME] = `${event.host}.${event.method}`
    }
    const span = tracer.otel.startSpan(
      `schedule ${event.job}`,
      { kind: SpanKind.INTERNAL, attributes, ...startTimeOf(event.startTime) },
      parent,
    )
    ensureContextManager()
    return otelContext.with(trace.setSpan(parent, span), async () => {
      let thrown: unknown
      let failed = false
      try {
        return await next()
      } catch (error) {
        failed = true
        thrown = error
        throw error
      } finally {
        record(() => {
          const outcome = settledOutcome(event, failed)
          span.setAttribute(Attr.ZNIGHT_SCHEDULE_OUTCOME, outcome)
          if (event.aborted !== undefined) span.setAttribute(Attr.ZNIGHT_SCHEDULE_ABORTED, event.aborted)
          if (outcome === 'failed') {
            const error = event.error ?? thrown
            if (error === undefined) span.setStatus({ code: SpanStatusCode.ERROR, message: 'job failed' })
            else recordSpanError(span, error)
          }
          span.end()
        })
      }
    })
  }
}

/** The `job` label: the job name, limited to `max` distinct values (`_OTHER` beyond). */
function boundedJobLabel(max: number = DEFAULT_MAX_JOBS): (job: string) => string {
  if (!Number.isInteger(max) || max < 1) {
    throw invalidOption('metrics.schedule.maxJobs', `expected a positive integer, got ${String(max)}`)
  }
  const seen = new Set<string>()
  return job => {
    if (seen.has(job)) return job
    if (seen.size >= max) return OTHER_JOB
    seen.add(job)
    return job
  }
}

/**
 * Outcome of a run seen by a wrapper once `next()` settled. The producer sets `event.outcome` in its
 * innermost callback (the job ran); when it is still unset, an inner wrapper either threw before the
 * job (`failed`) or returned without calling `next()`, vetoing the run (`skipped`, RFC 0004 §7.4):
 * the producer only fills these in after `hooks.run()` settles, so the wrappers derive them alike.
 */
function settledOutcome(event: ScheduledRunEvent, failed: boolean): ScheduledRunOutcome {
  return event.outcome ?? (failed ? 'failed' : 'skipped')
}

function jobSeverity(outcome: string, success: LogEntryLevel): LogEntryLevel {
  switch (outcome) {
    case 'completed':
      return success
    case 'skipped':
      return 'warn'
    case 'not-acquired':
      return 'debug'
    default:
      return 'error'
  }
}

/** `startedAt` of the run context (`JobContext` of `@znight/schedule`), read structurally. */
function startedAtOf(event: ScheduledRunEvent): number | undefined {
  const context = event.context as { readonly startedAt?: unknown } | undefined
  const startedAt = context?.startedAt
  return startedAt instanceof Date && Number.isFinite(startedAt.getTime()) ? startedAt.getTime() : undefined
}

/** Milliseconds between the occurrence and the start of the run, for executed runs. */
function lateness(event: ScheduledRunEvent): number | undefined {
  const startedAt = startedAtOf(event)
  if (startedAt === undefined || !Number.isFinite(event.scheduledAt)) return undefined
  return Math.max(0, startedAt - event.scheduledAt)
}

function isoOf(epochMs: number): string | number {
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : epochMs
}

function startTimeOf(startTime: unknown): { startTime?: number } {
  return typeof startTime === 'number' && Number.isFinite(startTime) && startTime >= 0 && startTime <= performance.now()
    ? { startTime }
    : {}
}
