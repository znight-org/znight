import type { Application, Hooks, OnStart, OnStop } from '@znight/core'
import type { ScheduledJob, SchedulePluginInstance, SchedulerRegistry } from '@znight/schedule'

import { Injectable } from '@znight/core'
import { SCHEDULE_PLUGIN_NAME } from '@znight/schedule'

/** A job that missed two occurrences in a row on this instance. */
export interface OverdueJob {
  readonly job: string
  readonly schedule: string
  /** The occurrence of its last success here; `null` when it never succeeded since the start. */
  readonly lastSuccess: Date | null
  /** Its last run here, whatever the outcome (`failed`, `skipped`...). */
  readonly lastOutcome: string | null
}

/**
 * Freshness of the jobs, for `GET /health`: which jobs have not succeeded for two of their
 * occurrences on this instance (failing, or skipped because a run hangs).
 *
 * It listens to the `schedule:run` hook of `@znight/core`, which `@znight/schedule` emits once per
 * occurrence with its outcome; `@znight/observability` builds its logs and metrics on the same
 * events. Times come from the **scheduler clock** (the plugin's), so tests with a virtual clock are
 * deterministic.
 *
 * Per instance: with a lock store, an occurrence that another instance claimed (`not-acquired`)
 * counts as handled here, since this instance cannot tell how it went. For the whole fleet, alert on
 * `max(schedule_last_success_timestamp_seconds)` of `@znight/observability` instead.
 */
@Injectable()
export class JobHealth implements OnStart, OnStop {
  /** Epoch ms of the last handled occurrence of each job. */
  readonly #lastSuccess = new Map<string, number>()
  /** When this instance started watching: the reference of jobs that never succeeded. */
  #since = 0
  #unsubscribe: (() => void) | undefined

  constructor(
    private readonly app: Application,
    private readonly hooks: Hooks,
    private readonly registry: SchedulerRegistry,
  ) {}

  /** Providers start before the scheduler arms anything: no occurrence is missed. */
  onStart(): void {
    this.#since = this.#now()
    this.#unsubscribe = this.hooks.on('schedule:run', event => {
      if (event.outcome === 'completed' || event.outcome === 'not-acquired') {
        this.#lastSuccess.set(event.job, Math.max(event.scheduledAt, this.#lastSuccess.get(event.job) ?? 0))
      }
    })
  }

  onStop(): void {
    this.#unsubscribe?.()
  }

  /**
   * Jobs whose second occurrence after their last success (or after the start) has passed: they
   * missed two periods in a row. Jobs that are not armed (paused, done, a disabled scheduler) are
   * not expected to run, and timeouts have no period: none of them is ever overdue.
   */
  overdue(): OverdueJob[] {
    const now = this.#now()
    return this.registry
      .jobs()
      .filter(job => job.kind !== 'timeout' && job.nextRun !== undefined && this.#missedTwice(job, now))
      .map(job => {
        const last = this.#lastSuccess.get(job.name)
        return {
          job: job.name,
          schedule: job.schedule,
          lastSuccess: last === undefined ? null : new Date(last),
          lastOutcome: job.lastRun?.outcome ?? null,
        }
      })
  }

  #missedTwice(job: ScheduledJob, now: number): boolean {
    const reference = this.#lastSuccess.get(job.name) ?? this.#since
    const [, second] = job.nextRuns(2, new Date(reference))
    return second !== undefined && second.getTime() < now
  }

  /** The scheduler clock: the system clock in production, a virtual one in tests. */
  #now(): number {
    return this.app.getPlugin<SchedulePluginInstance>(SCHEDULE_PLUGIN_NAME)?.clock?.now() ?? Date.now()
  }
}
