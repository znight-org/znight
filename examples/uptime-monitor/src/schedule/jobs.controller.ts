import type { JobRunResult, ScheduledJob, SchedulerRegistry } from '@znight/schedule'

import { ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@znight/http'

import { Roles } from '../auth/auth.decorators.js'

/** Occurrences listed by `GET /admin/jobs/:name`. */
const UPCOMING = 5

/** The last run of a job, as sent to clients. */
export interface RunView {
  readonly runId: string
  readonly trigger: JobRunResult['trigger']
  readonly outcome: JobRunResult['outcome']
  readonly scheduledAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  /** Why the run's signal was aborted: `timeout`, `lock-lost`, `removed`, `shutdown`. */
  readonly aborted: JobRunResult['aborted'] | null
  /** The message of the error of a failed run (the stack is in the logs). */
  readonly error: string | null
}

/** A job of the registry, as sent to clients. */
export interface JobView {
  readonly name: string
  readonly kind: ScheduledJob['kind']
  /** `decorator` (`@Cron`, `@Interval`, `@Timeout`) or `dynamic` (`registry.addInterval()`: the monitors). */
  readonly origin: ScheduledJob['origin']
  /** `'0 8 * * MON-FRI (Europe/Paris)'`, `'every 1m'`, `'once after 2s'`. */
  readonly schedule: string
  readonly state: ScheduledJob['state']
  /** Runs on one instance at a time (the lock store). */
  readonly locked: boolean
  /** Runs in flight in this process. */
  readonly running: number
  /** The armed occurrence; `null` while the scheduler does not run or the job is not scheduled. */
  readonly nextRun: Date | null
  readonly lastRun: RunView | null
}

function toRunView(run: JobRunResult): RunView {
  return {
    runId: run.runId,
    trigger: run.trigger,
    outcome: run.outcome,
    scheduledAt: run.scheduledAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    aborted: run.aborted ?? null,
    error: messageOf(run.error),
  }
}

/** The message of an error, `null` without error. */
function messageOf(error: unknown): string | null {
  if (error === undefined) return null
  return error instanceof Error ? error.message : String(error)
}

export function toJobView(job: ScheduledJob): JobView {
  return {
    name: job.name,
    kind: job.kind,
    origin: job.origin,
    schedule: job.schedule,
    state: job.state,
    locked: job.locked,
    running: job.running,
    nextRun: job.nextRun ?? null,
    lastRun: job.lastRun === undefined ? null : toRunView(job.lastRun),
  }
}

/**
 * The admin endpoints of the scheduler: plain application code on the injectable
 * `SchedulerRegistry` (`@znight/schedule` does not depend on `@znight/http`). Administrators only:
 * the global `AuthGuard` enforces `@Roles(['admin'])` like on any other route (401 without a valid
 * key, 403 with the read-only key).
 *
 * The registry is **per instance**: with several replicas, each one answers for its own scheduler.
 * A pause is neither persisted nor shared (pause on every instance, or set `enabled: false` through
 * the plugin's `jobs` option and redeploy). A manual run goes through the lock like any other run.
 */
@Controller('/admin/jobs')
@Roles(['admin'])
export class JobsController {
  constructor(private readonly registry: SchedulerRegistry) {}

  /** GET /admin/jobs: every job, static and dynamic, sorted by name. */
  @Get()
  list(): JobView[] {
    return this.registry.jobs().map(toJobView)
  }

  /** GET /admin/jobs/digest.daily: a job and its next occurrences (computed even while paused). */
  @Get('/:name')
  get(@Param('name') name: string): JobView & { readonly upcoming: Date[] } {
    const job = this.#find(name)
    return { ...toJobView(job), upcoming: job.kind === 'timeout' ? [] : job.nextRuns(UPCOMING) }
  }

  /**
   * POST /admin/jobs/digest.daily/run: 202 at once, the run goes on in the background. It goes
   * through the whole pipeline: overlap policy (a running job answers `skipped`), lock, its own
   * container scope (never this request's: it may outlive it), hooks (its log line and span, a child
   * of this request's span). Poll `GET /admin/jobs/:name` for `lastRun`.
   */
  @Post('/:name/run')
  @HttpCode(202)
  run(@Param('name') name: string): { readonly job: string; readonly accepted: true } {
    const job = this.#find(name)
    // never rejects because the job failed (the result says so); the response does not wait for it
    void job.trigger()
    return { job: job.name, accepted: true }
  }

  /** POST /admin/jobs/digest.daily/pause: no more occurrences on this instance until resumed. */
  @Post('/:name/pause')
  pause(@Param('name') name: string): JobView {
    const job = this.#scheduled(name)
    job.pause() // a run in flight goes on; a queued occurrence is dropped
    return toJobView(job)
  }

  /** POST /admin/jobs/digest.daily/resume: scheduled again, from now (missed occurrences do not run). */
  @Post('/:name/resume')
  resume(@Param('name') name: string): JobView {
    const job = this.#scheduled(name)
    job.resume()
    return toJobView(job)
  }

  #find(name: string): ScheduledJob {
    const job = this.registry.get(name)
    if (job === undefined) throw new NotFoundException(`Unknown job "${name}"`)
    return job
  }

  /** A job that can be paused or resumed: a `done` timeout or a `disabled` job cannot (409). */
  #scheduled(name: string): ScheduledJob {
    const job = this.#find(name)
    if (job.state !== 'scheduled' && job.state !== 'paused') {
      throw new ConflictException(`Job "${name}" is ${job.state}: only scheduled jobs can be paused or resumed`)
    }
    return job
  }
}
