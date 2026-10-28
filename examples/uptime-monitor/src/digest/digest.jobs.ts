import type { Logger } from '@znight/observability'
import type { JobContext, ScheduledJob, SchedulerRegistry } from '@znight/schedule'
import type { DigestConfig } from '../config/digest.config.js'
import type { Mail, Mailer } from './mailer.js'
import type { DigestReport, ReportService } from './report.service.js'

import { Cron } from '@znight/schedule'

const MINUTE = 60_000
const DAY = 86_400_000

/**
 * The weekday digest. No `@Injectable()`: a class with jobs becomes a singleton provider, its
 * constructor parameters injected like any other.
 *
 * `@Cron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris' })` runs at 08:00 **Paris time**, whatever the
 * zone of the server: 07:00Z in winter (CET), 06:00Z in summer (CEST), never twice nor skipped on a
 * daylight saving day. The expression, the zone and the duration are checked at build time
 * (`'0 25 * * MON-FRI'` fails `znight build` with ZNIGHT040, a caret under `25`).
 *
 * The schedule can be replaced per deployment without touching the code: `DIGEST_CRON` feeds the
 * plugin's `jobs` override (`plugins.ts`), validated at boot with the same engine.
 *
 * With several instances, the lock store makes it run once per occurrence across the fleet, and
 * `maxDuration` bounds a stuck run: `ctx.signal` is aborted after 10 minutes.
 */
export class DigestJobs {
  constructor(
    private readonly reports: ReportService,
    private readonly mailer: Mailer,
    private readonly config: DigestConfig,
    private readonly registry: SchedulerRegistry,
    private readonly logger: Logger,
  ) {}

  @Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
  async sendDaily(ctx: JobContext): Promise<void> {
    // the occurrence, never `new Date()`: a late run (a stalled process, a retry) reports on the
    // period it stands for, and tests pass any occurrence they want
    const until = ctx.scheduledAt
    const job = this.registry.get(ctx.job)
    const since = (job === undefined ? undefined : previousRun(job, until)) ?? new Date(until.getTime() - DAY)

    const report = await this.reports.build({ since, until, signal: ctx.signal })
    // the occurrence also makes the e-mail idempotent: one digest per occurrence, even if two
    // instances raced for it (the lock prevents it) or the job is triggered again by hand
    await this.mailer.send(digestMail(report, this.config.recipients, `${ctx.job}:${until.toISOString()}`))
    this.logger.info('Digest queued', {
      since: since.toISOString(),
      until: until.toISOString(),
      checks: report.checks,
      failures: report.failures,
    })
  }
}

/**
 * The occurrence of `job` before `before`, from the job's own schedule, so that Monday's digest
 * covers the weekend and a `DIGEST_CRON` override changes the period with the schedule.
 * `ScheduledJob.nextRuns()` only looks forward: the search goes back in growing windows. `undefined`
 * when there is none within about three weeks.
 */
export function previousRun(job: ScheduledJob, before: Date): Date | undefined {
  const end = before.getTime()
  for (let window = MINUTE; window <= 32 * DAY; window *= 8) {
    let previous: Date | undefined
    let from = new Date(end - window)
    for (;;) {
      const [next] = job.nextRuns(1, from)
      if (next === undefined || next.getTime() >= end) break
      previous = next
      from = next
    }
    if (previous !== undefined) return previous
  }
  return undefined
}

/** The e-mail of a report. */
export function digestMail(report: DigestReport, to: readonly string[], key: string): Mail {
  const failed = report.failures === 1 ? '1 failed check' : `${report.failures} failed checks`
  const subject = `Uptime digest: ${digestSummary(report, failed)}`
  const lines = report.monitors.map(monitor =>
    monitor.checks === 0
      ? `- ${monitor.name}: no check`
      : `- ${monitor.name}: ${monitor.uptime}% up (${monitor.checks - monitor.failures}/${monitor.checks} checks), ${monitor.averageLatencyMs} ms on average`,
  )
  const text = [
    `Uptime from ${report.since.toISOString()} to ${report.until.toISOString()}`,
    '',
    `${report.monitors.length} monitor(s), ${report.checks} check(s), ${failed}.`,
    '',
    ...lines,
  ].join('\n')
  return { key, to, subject, text }
}

function digestSummary(report: DigestReport, failed: string): string {
  if (report.checks === 0) return 'no check'
  return report.failures === 0 ? `all ${report.checks} checks passed` : failed
}
