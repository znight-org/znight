/**
 * The current run of a job (RFC 0004 §4.6): passed to job methods and injectable as the
 * request-scoped external `@znight/schedule#JobContext`.
 */
import type { ScheduledRunOutcome, ScheduledRunTrigger } from '@znight/core'

/** How a run was triggered: its occurrence, `runOnStart`, `trigger()`, or `overlap: 'queue'`. */
export type RunTrigger = ScheduledRunTrigger

/** Outcome of a run. `skipped`: overlap or a hook wrapper vetoed it; `not-acquired`: another instance holds the lock. */
export type RunOutcome = ScheduledRunOutcome

/** The current run. Passed to job methods, and injectable as a request-scoped external. */
export interface JobContext {
  /** Job name. */
  readonly job: string
  /** UUID of the run, also in the logs and spans. */
  readonly runId: string
  /** `'schedule'` (its occurrence), `'start'` (`runOnStart`), `'manual'` (`trigger()`), `'queued'` (`overlap: 'queue'`). */
  readonly trigger: RunTrigger
  /** The occurrence the run stands for, on the scheduler clock; the call time for a manual run. */
  readonly scheduledAt: Date
  /** When the run started; `startedAt - scheduledAt` is the lateness. */
  readonly startedAt: Date
  /** The previous executed run of the job in this process. */
  readonly previous: { readonly scheduledAt: Date; readonly outcome: RunOutcome } | undefined
  /**
   * Aborted when `maxDuration` is exceeded, the lock lease is lost, the job is removed with
   * `{ abort: true }` or the application stops. `signal.reason` is a `JobAbortedError` (ZNIGHT044)
   * whose `reason` is `'timeout'`, `'lock-lost'`, `'removed'` or `'shutdown'`.
   */
  readonly signal: AbortSignal
}

/** A dynamic job (`registry.addCron()`...): called with the context of each run. */
export type JobHandler = (ctx: JobContext) => unknown
