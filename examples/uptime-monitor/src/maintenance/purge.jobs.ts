import type { Logger } from '@znight/observability'
import type { JobContext } from '@znight/schedule'
import type { ProbesConfig } from '../config/probes.config.js'
import type { ProbeResultRepository } from '../monitors/probe-result.repository.js'

import { Cron, JobAbortedError } from '@znight/schedule'

const DAY = 86_400_000

/**
 * Nightly maintenance: deletes the probe results older than `PROBES_RETENTION_DAYS`.
 *
 * `'0 30 3 * * *'` has **6 fields**: the first one is the second (03:30:00). Without `timeZone`, the
 * job uses the plugin's (`SCHEDULE_TIME_ZONE`: UTC by default, Europe/Paris in `.env.development`).
 */
export class PurgeJobs {
  constructor(
    private readonly results: ProbeResultRepository,
    private readonly config: ProbesConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Deletes in batches, so that the table is never locked for long, and checks `ctx.signal` between
   * them: a run is never killed (JavaScript cannot stop a promise), it **cooperates**.
   *
   * - The application stops (`shutdown`): the run returns at the next batch boundary, so the drain
   *   completes in milliseconds instead of waiting for the whole purge; the next night resumes it.
   * - `maxDuration` is exceeded (`timeout`) or the lock lease is lost (`lock-lost`):
   *   `ctx.signal.throwIfAborted()` fails the run, which shows in the logs and metrics.
   */
  @Cron('0 30 3 * * *', { name: 'probes.purge', maxDuration: '10m' })
  async purge(ctx: JobContext): Promise<void> {
    const before = new Date(ctx.scheduledAt.getTime() - this.config.retentionDays * DAY)
    let deleted = 0
    for (;;) {
      if (isShutdown(ctx.signal)) {
        this.logger.info('Probe results purge interrupted by the shutdown', { deleted })
        return
      }
      ctx.signal.throwIfAborted()
      const batch = await this.results.purgeBatch(before, this.config.purgeBatchSize)
      deleted += batch
      if (batch < this.config.purgeBatchSize) break
    }
    this.logger.info('Probe results purged', { deleted, before: before.toISOString() })
  }
}

function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof JobAbortedError && signal.reason.reason === 'shutdown'
}
