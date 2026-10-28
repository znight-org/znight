import { formatDuration } from '@znight/schedule'

/** When a monitor is probed: an interval (aligned on the Unix epoch) or a cron expression in a time zone. */
export type MonitorSchedule = { readonly every: number } | { readonly cron: string; readonly timeZone: string }

/** A URL probed on its own schedule. */
export interface Monitor {
  readonly id: number
  readonly name: string
  readonly url: string
  /** The status a healthy target answers (200 by default). */
  readonly expectedStatus: number
  readonly schedule: MonitorSchedule
  /** A probe still waiting for the answer after this long is aborted and recorded as down. */
  readonly timeoutMs: number
  readonly createdAt: Date
}

/** What `POST /monitors` creates (the validated body). */
export type NewMonitor = Omit<Monitor, 'id' | 'createdAt'>

/** The result of one probe: one per occurrence of the monitor's job. */
export interface ProbeResult {
  readonly id: number
  readonly monitorId: number
  /** The occurrence the probe stands for (`ctx.scheduledAt`). */
  readonly scheduledAt: Date
  /** When the probe started (`ctx.startedAt`). */
  readonly checkedAt: Date
  readonly up: boolean
  /** The status answered, `null` when nothing was (timeout, connection refused...). */
  readonly status: number | null
  readonly latencyMs: number
  readonly error: string | null
}

/** Prefix of the names of the monitor jobs. */
const JOB_PREFIX = 'monitor.'

/** The name of the job probing a monitor: `monitor.42` (also its lock key, its log and metric label). */
export function monitorJobName(id: number): string {
  return `${JOB_PREFIX}${id}`
}

/** The monitor id of a job name, `undefined` for the other jobs. */
export function monitorIdOf(job: string): number | undefined {
  if (!job.startsWith(JOB_PREFIX)) return undefined
  const id = Number(job.slice(JOB_PREFIX.length))
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** `'every 30s'` or `'*\/5 * * * * (Europe/Paris)'`: the format of `ScheduledJob.schedule`. */
export function describeSchedule(schedule: MonitorSchedule): string {
  return 'every' in schedule ? `every ${formatDuration(schedule.every)}` : `${schedule.cron} (${schedule.timeZone})`
}
