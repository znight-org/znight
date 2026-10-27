/**
 * `SchedulerRegistry` (RFC 0004 §4.6): the injectable view of every job, static (decorated) and
 * dynamic. Usable from the end of the plugin's `onBootstrap` (providers' `onStart` / `onReady`,
 * requests, runs) until the application stops.
 */
import type { JobHandler, RunOutcome, RunTrigger } from './context.ts'
import type { Duration } from './duration.ts'
import type { JobAbortReason } from './errors.ts'
import type { CronOptions, IntervalOptions, OverlapPolicy, TimeoutOptions } from './options.ts'

/** Life of a job in the registry. */
export type JobState = 'scheduled' | 'paused' | 'disabled' | 'done' | 'removed'

/** The result of one run (or of an occurrence that did not run). */
export interface JobRunResult {
  readonly job: string
  readonly runId: string
  readonly trigger: RunTrigger
  readonly scheduledAt: Date
  /** `undefined` when the run did not execute (`skipped` by overlap, `not-acquired`, lock store failure). */
  readonly startedAt: Date | undefined
  readonly finishedAt: Date | undefined
  readonly outcome: RunOutcome
  /** What the job threw (`failed`), or the lock store failure. */
  readonly error?: unknown
  readonly aborted?: JobAbortReason
}

/** A job of the registry. */
export interface ScheduledJob {
  readonly name: string
  readonly kind: 'cron' | 'interval' | 'timeout'
  readonly origin: 'decorator' | 'dynamic'
  /** Human-readable: `'0 8 * * MON-FRI (Europe/Paris)'`, `'every 1m'`, `'once after 5s'`. */
  readonly schedule: string
  readonly cron: string | undefined
  /** As written; the effective zone for cron jobs (`undefined` for intervals and timeouts). */
  readonly timeZone: string | undefined
  /** Milliseconds (intervals). */
  readonly every: number | undefined
  /** Milliseconds (timeouts). */
  readonly delay: number | undefined
  readonly overlap: OverlapPolicy
  readonly locked: boolean
  readonly maxDuration: number | undefined
  readonly state: JobState
  /** Runs in flight in this process. */
  readonly running: number
  /** The armed occurrence; `undefined` while the scheduler is not running or the job is not scheduled. */
  readonly nextRun: Date | undefined
  readonly lastRun: JobRunResult | undefined
  /** The next `count` occurrences after `from` (default: now), whatever the state of the job. */
  nextRuns(count: number, from?: Date): Date[]
  /** Stops scheduling the job (a running run goes on). */
  pause(): void
  /** Schedules a paused job again, from now. */
  resume(): void
  /**
   * Same kind only: a cron expression for a cron job, a duration for an interval or a timeout
   * (ZNIGHT040). A timeout is armed again, `delay` from now. Not persisted.
   */
  reschedule(schedule: string | Duration, options?: { readonly timeZone?: string }): void
  /**
   * Runs the job now through the whole pipeline (overlap, lock, scope, hooks). Resolves with the
   * result and never rejects because the job failed; rejects with ZNIGHT021 when the scheduler is
   * stopping or not bootstrapped, ZNIGHT042 once the job was removed.
   */
  trigger(): Promise<JobRunResult>
}

/** Injectable. Static (decorated) and dynamic jobs share it. */
export abstract class SchedulerRegistry {
  /** Every job, sorted by name. */
  abstract jobs(): readonly ScheduledJob[]
  abstract get(name: string): ScheduledJob | undefined
  abstract has(name: string): boolean
  /** Validated at once (ZNIGHT040, ZNIGHT041); armed now when the scheduler runs, else when it starts. */
  abstract addCron(
    name: string,
    expression: string,
    handler: JobHandler,
    options?: Omit<CronOptions, 'name'>,
  ): ScheduledJob
  abstract addInterval(
    name: string,
    every: Duration,
    handler: JobHandler,
    options?: Omit<IntervalOptions, 'name'>,
  ): ScheduledJob
  abstract addTimeout(
    name: string,
    delay: Duration,
    handler: JobHandler,
    options?: Omit<TimeoutOptions, 'name'>,
  ): ScheduledJob
  /** Stops future runs; a running run goes on unless `abort`. Unknown name: ZNIGHT042. */
  abstract remove(name: string, options?: { readonly abort?: boolean }): void
  /** `get(name).trigger()`; unknown name: ZNIGHT042. */
  abstract trigger(name: string): Promise<JobRunResult>
  /** Resolves once no run is in flight (queued runs included). */
  abstract idle(): Promise<void>
}
