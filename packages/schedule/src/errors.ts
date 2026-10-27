/**
 * Errors of `@znight/schedule` (RFC 0004 §5.4): ZNIGHT040 to ZNIGHT044 (`ErrorCode` of
 * `@znight/core`), plus ZNIGHT021 for a registry used before the bootstrap or after the stop.
 */
import type { ScheduledRunAbortReason } from '@znight/core'
import type { CronField } from './cron/fields.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { closest } from './names.ts'

/** Where an invalid cron expression is wrong (offsets in the expression as written). */
export interface InvalidScheduleDetails {
  readonly field?: CronField | undefined
  readonly start?: number | undefined
  readonly end?: number | undefined
  readonly hints?: readonly string[]
  readonly cause?: unknown
}

/**
 * ZNIGHT040: an invalid schedule (cron expression, duration, time zone, options, job definition).
 * For cron expressions, `field`, `start` and `end` locate the problem in the expression.
 */
export class InvalidScheduleError extends ZnightError {
  /** The cron field in error (`'hour'`...), when the problem is a cron field. */
  readonly field: CronField | undefined
  /** Offset of the offending text in the cron expression, in UTF-16 units. */
  readonly start: number | undefined
  /** End offset (exclusive). */
  readonly end: number | undefined

  constructor(message: string, details: InvalidScheduleDetails = {}) {
    super(ErrorCode.InvalidSchedule, message, {
      hints: details.hints ?? [],
      ...(details.cause === undefined ? {} : { cause: details.cause }),
    })
    this.name = 'InvalidScheduleError'
    this.field = details.field
    this.start = details.start
    this.end = details.end
  }
}

/** Why a run was aborted: `maxDuration`, a lost lock lease, `remove(name, { abort: true })` or the stop. */
export type JobAbortReason = ScheduledRunAbortReason

/**
 * ZNIGHT044: the `reason` of `ctx.signal` once a run is aborted. Never thrown by the framework: jobs
 * see it through `ctx.signal.reason` (and `ctx.signal.throwIfAborted()`).
 */
export class JobAbortedError extends ZnightError {
  readonly job: string
  readonly runId: string
  readonly reason: JobAbortReason

  constructor(job: string, runId: string, reason: JobAbortReason) {
    super(ErrorCode.JobAborted, `Run ${runId} of job '${job}' was aborted: ${ABORT_MESSAGES[reason]}`)
    this.name = 'JobAbortedError'
    this.job = job
    this.runId = runId
    this.reason = reason
  }
}

const ABORT_MESSAGES: Readonly<Record<JobAbortReason, string>> = {
  timeout: 'it exceeded its maxDuration',
  'lock-lost': 'its lock lease was lost',
  removed: 'the job was removed',
  shutdown: 'the application is stopping',
}

/** ZNIGHT041: two jobs share a name. */
export function duplicateJobError(name: string, hints: readonly string[] = []): ZnightError {
  return new ZnightError(ErrorCode.DuplicateJob, `Job name '${name}' is used twice`, {
    hints: [...hints, 'Job names must be unique (logs, metrics, lock keys): rename one of them'],
  })
}

/** ZNIGHT042: no job has this name. */
export function unknownJobError(name: string, known: Iterable<string>, where = 'No job'): ZnightError {
  const suggestion = typeof name === 'string' ? closest(name, known) : undefined
  return new ZnightError(
    ErrorCode.UnknownJob,
    `${where} named '${String(name)}'${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`,
    { hints: ['registry.jobs() lists the jobs of the application'] },
  )
}

/** ZNIGHT043: a job requires a lock but the plugin has no lock store. */
export function missingLockStoreError(names: readonly string[]): ZnightError {
  return new ZnightError(
    ErrorCode.MissingLockStore,
    `${names.length === 1 ? `Job '${names[0]}' requires` : `Jobs ${names.map(name => `'${name}'`).join(', ')} require`} a lock (lock: true) but SchedulePlugin has no lock store`,
    {
      hints: [
        'Configure one: SchedulePlugin.configure({ lock: myLockStore }) (memoryLockStore() for a single process)',
        'Or remove lock: true to run the job on every instance',
      ],
    },
  )
}

/** ZNIGHT021: the registry is used before the bootstrap or once the scheduler is stopping. */
export function notAvailableError(action: string, state: string): ZnightError {
  const early = state === 'created'
  return new ZnightError(
    ErrorCode.LifecycleFailed,
    early
      ? `SchedulerRegistry.${action}: the scheduler is not bootstrapped yet`
      : `SchedulerRegistry.${action}: the scheduler is ${state}`,
    {
      hints: early
        ? ['Use the registry from onStart/onReady, a request or a run, not from a provider constructor']
        : ['Jobs cannot be added or triggered once the application is stopping'],
    },
  )
}
