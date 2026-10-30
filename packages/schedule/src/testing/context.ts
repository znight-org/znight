import type { JobContext, RunOutcome, RunTrigger } from '../context.ts'
import type { JobAbortReason } from '../errors.ts'

import { randomUUID } from 'node:crypto'

import { JobAbortedError } from '../errors.ts'

/** What {@link createJobContext} accepts. */
export interface JobContextInit {
  /** Default `'test-job'`. */
  readonly job?: string
  /** Default: a random UUID. */
  readonly runId?: string
  /** Default `'manual'`. */
  readonly trigger?: RunTrigger
  /** Default: now. */
  readonly scheduledAt?: Date
  /** Default: `scheduledAt`. */
  readonly startedAt?: Date
  readonly previous?: { readonly scheduledAt: Date; readonly outcome: RunOutcome }
}

/** A {@link JobContext} whose signal the test controls. */
export interface TestJobContext extends JobContext {
  /** Aborts `signal` with a `JobAbortedError` (default reason `'shutdown'`). */
  abort(reason?: JobAbortReason): void
}

/**
 * Builds a {@link JobContext} for unit tests: call the job method directly.
 *
 * ```ts
 * const { instance } = await TestBed.create(DigestJobs, { metadata })
 * await instance.sendDaily(createJobContext({ scheduledAt: new Date('2027-03-26T07:00:00Z') }))
 * ```
 */
export function createJobContext(init: JobContextInit = {}): TestJobContext {
  const controller = new AbortController()
  const job = init.job ?? 'test-job'
  const runId = init.runId ?? randomUUID()
  const scheduledAt = init.scheduledAt ?? new Date()
  return Object.freeze({
    job,
    runId,
    trigger: init.trigger ?? 'manual',
    scheduledAt,
    startedAt: init.startedAt ?? scheduledAt,
    previous: init.previous,
    signal: controller.signal,
    abort(reason: JobAbortReason = 'shutdown'): void {
      if (!controller.signal.aborted) controller.abort(new JobAbortedError(job, runId, reason))
    },
  })
}
