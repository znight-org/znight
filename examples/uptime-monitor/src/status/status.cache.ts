import type { JobContext } from '@znight/schedule'
import type { MonitorStatusRow, ProbeResultRepository } from '../monitors/probe-result.repository.js'

import { Interval, Timeout } from '@znight/schedule'

/** Window of the uptime percentage. */
const DAY = 86_400_000

/** A monitor on the status page. */
export interface MonitorStatus {
  readonly id: number
  readonly name: string
  /** The last probe: `unknown` when the monitor was never probed. */
  readonly state: 'up' | 'down' | 'unknown'
  readonly lastCheckedAt: Date | null
  readonly lastStatus: number | null
  readonly latencyMs: number | null
  /** Successful probes over the 24 hours before the refresh, in percent; `null` without probe. */
  readonly uptime24h: number | null
}

/** The status page, as computed by the last refresh. */
export interface StatusSnapshot {
  /** The occurrence of the refresh that computed it (scheduler clock). */
  readonly refreshedAt: Date
  readonly up: number
  readonly down: number
  readonly monitors: readonly MonitorStatus[]
}

function stateOf(row: MonitorStatusRow): MonitorStatus['state'] {
  if (row.last === undefined) return 'unknown'
  return row.last.up ? 'up' : 'down'
}

function toStatus(row: MonitorStatusRow): MonitorStatus {
  return {
    id: row.id,
    name: row.name,
    state: stateOf(row),
    lastCheckedAt: row.last?.checkedAt ?? null,
    lastStatus: row.last?.status ?? null,
    latencyMs: row.last?.latencyMs ?? null,
    uptime24h: row.checks === 0 ? null : Math.round((row.upChecks / row.checks) * 10_000) / 100,
  }
}

/**
 * The public status page, served from memory: `GET /status` never touches the database, however
 * often it is called. The class has no `@Injectable()`: having jobs makes it a singleton provider,
 * created at boot like any other, and injectable (`StatusController`).
 *
 * Both jobs are **per instance** (`lock: false`): every instance keeps its own copy of the cache, so
 * each one must refresh it, even when a lock store makes the other jobs single-runner.
 */
export class StatusCache {
  #snapshot: StatusSnapshot | undefined

  constructor(private readonly results: ProbeResultRepository) {}

  /**
   * Every minute, and once when the scheduler starts (`runOnStart`). Intervals are aligned on the Unix
   * epoch: every instance refreshes at hh:mm:00, whenever it was started.
   */
  @Interval('1m', { name: 'status-cache.refresh', lock: false, runOnStart: true })
  async refresh(ctx: JobContext): Promise<void> {
    // the occurrence, not the current time: the 24-hour window is deterministic under a test clock
    const rows = await this.results.statuses(new Date(ctx.scheduledAt.getTime() - DAY))
    const monitors = rows.map(toStatus)
    this.#snapshot = {
      refreshedAt: ctx.scheduledAt,
      up: monitors.filter(monitor => monitor.state === 'up').length,
      down: monitors.filter(monitor => monitor.state === 'down').length,
      monitors,
    }
  }

  /**
   * Once, 2 s after the scheduler started: the first probes of the monitors have run by then, so the
   * page shows them without waiting for the next minute.
   */
  @Timeout('2s', { name: 'status-cache.warm', lock: false })
  warm(ctx: JobContext): Promise<void> {
    return this.refresh(ctx)
  }

  /** The last snapshot; `undefined` until the first refresh. */
  get snapshot(): StatusSnapshot | undefined {
    return this.#snapshot
  }
}
