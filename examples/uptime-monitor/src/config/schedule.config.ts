import { Config, Env } from '@znight/config'

/**
 * Settings of the scheduler, read by `plugins.ts` when it configures `SchedulePlugin`. The schedules
 * written in the decorators are validated at **build time**; these values come from the environment,
 * so `SchedulePlugin` validates them at **boot** with the same rules (an invalid `SCHEDULE_TIME_ZONE`
 * or `DIGEST_CRON` stops the application with ZNIGHT040).
 */
@Config('schedule')
export class ScheduleConfig {
  /**
   * `SCHEDULE_ENABLED=false` on replicas that only serve HTTP: jobs are still listed, triggered by
   * hand and added by the API, but nothing is scheduled (and no timer keeps the process alive).
   */
  enabled = true

  /**
   * `SCHEDULE_TIME_ZONE`: default zone of the cron jobs that do not name one (`probes.purge`). An
   * IANA name (`Europe/Paris`), `UTC`, a fixed offset (`+05:30`) or `local`.
   */
  timeZone = 'UTC'

  /**
   * `DIGEST_CRON`: replaces the schedule of `digest.daily` for this deployment (a staging digest
   * every hour...). Unset: the decorator's `0 8 * * MON-FRI`.
   */
  @Env('DIGEST_CRON')
  digestCron?: string

  /**
   * `SCHEDULE_LOCK_TTL`: lease of a locked run in the lock store, renewed every third of it while
   * the run lasts. A crashed instance blocks its jobs for at most this long.
   */
  lockTtl = '30s'

  /**
   * `SCHEDULE_DRAIN_TIMEOUT_MS`: on shutdown, how long running jobs get to finish once their signal
   * was aborted. Keep it below `shutdown.hookTimeoutMs` (5 s in `main.ts`).
   */
  drainTimeoutMs = 4000
}
