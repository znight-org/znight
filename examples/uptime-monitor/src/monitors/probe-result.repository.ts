import type { Database } from '../db/database.js'
import type { ProbeResult } from './monitor.js'

import { Injectable } from '@znight/core'

import { isPostgresError } from '../db/database.js'

interface ResultRow {
  readonly id: number
  readonly monitor_id: number
  readonly scheduled_at: Date
  readonly checked_at: Date
  readonly up: boolean
  readonly status: number | null
  readonly latency_ms: number
  readonly error: string | null
  readonly [column: string]: unknown
}

function toResult(row: ResultRow): ProbeResult {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    scheduledAt: row.scheduled_at,
    checkedAt: row.checked_at,
    up: row.up,
    status: row.status,
    latencyMs: row.latency_ms,
    error: row.error,
  }
}

/** The current state of a monitor, for the status page. */
export interface MonitorStatusRow {
  readonly id: number
  readonly name: string
  /** The last result, `undefined` when the monitor was never probed. */
  readonly last: Pick<ProbeResult, 'up' | 'status' | 'latencyMs' | 'checkedAt'> | undefined
  /** Probes and successful probes since the start of the window. */
  readonly checks: number
  readonly upChecks: number
}

/** What a monitor did during a period, for the digest. */
export interface MonitorSummaryRow {
  readonly id: number
  readonly name: string
  readonly checks: number
  readonly failures: number
  readonly averageLatencyMs: number | null
}

/** Foreign key violation: the monitor was deleted meanwhile. */
const FOREIGN_KEY_VIOLATION = '23503'

/** The results of the probes, in PostgreSQL. */
@Injectable()
export class ProbeResultRepository {
  constructor(private readonly db: Database) {}

  /**
   * Records the result of an occurrence. `scheduledAt` is the occurrence of the job: the store
   * already guarantees that one instance probes it, and `UNIQUE (monitor_id, scheduled_at)` makes the
   * write idempotent anyway (`ctx.scheduledAt` is the fencing token of the run). `undefined` when the
   * occurrence was already recorded, or when the monitor was deleted meanwhile.
   */
  async record(result: Omit<ProbeResult, 'id'>): Promise<ProbeResult | undefined> {
    try {
      const [row] = await this.db.query<ResultRow>(
        `INSERT INTO probe_results (monitor_id, scheduled_at, checked_at, up, status, latency_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (monitor_id, scheduled_at) DO NOTHING
         RETURNING *`,
        [
          result.monitorId,
          result.scheduledAt,
          result.checkedAt,
          result.up,
          result.status,
          result.latencyMs,
          result.error,
        ],
      )
      return row === undefined ? undefined : toResult(row)
    } catch (error) {
      if (isPostgresError(error, FOREIGN_KEY_VIOLATION)) return undefined
      throw error
    }
  }

  /** The latest results of a monitor, newest first. */
  async recent(monitorId: number, limit: number): Promise<ProbeResult[]> {
    const rows = await this.db.query<ResultRow>(
      'SELECT * FROM probe_results WHERE monitor_id = $1 ORDER BY scheduled_at DESC LIMIT $2',
      [monitorId, limit],
    )
    return rows.map(toResult)
  }

  /** Results recorded after the result `afterId`, oldest first (an event stream catching up). */
  async after(afterId: number, limit: number): Promise<ProbeResult[]> {
    const rows = await this.db.query<ResultRow>('SELECT * FROM probe_results WHERE id > $1 ORDER BY id LIMIT $2', [
      afterId,
      limit,
    ])
    return rows.map(toResult)
  }

  /** Deletes up to `limit` results checked before `before`; returns how many were deleted. */
  async purgeBatch(before: Date, limit: number): Promise<number> {
    const rows = await this.db.query(
      `DELETE FROM probe_results WHERE id IN (
         SELECT id FROM probe_results WHERE checked_at < $1 ORDER BY id LIMIT $2
       ) RETURNING id`,
      [before, limit],
    )
    return rows.length
  }

  /** Every monitor with its last result and its checks since `since`. */
  async statuses(since: Date): Promise<MonitorStatusRow[]> {
    const rows = await this.db.query<{
      id: number
      name: string
      up: boolean | null
      status: number | null
      latency_ms: number | null
      checked_at: Date | null
      checks: number
      up_checks: number
    }>(
      `SELECT m.id, m.name, last.up, last.status, last.latency_ms, last.checked_at,
              stats.checks, stats.up_checks
         FROM monitors m
         LEFT JOIN LATERAL (
           SELECT up, status, latency_ms, checked_at FROM probe_results r
            WHERE r.monitor_id = m.id ORDER BY r.scheduled_at DESC LIMIT 1
         ) last ON true
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS checks, (count(*) FILTER (WHERE r.up))::int AS up_checks
             FROM probe_results r WHERE r.monitor_id = m.id AND r.checked_at >= $1
         ) stats
        ORDER BY m.name, m.id`,
      [since],
    )
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      last:
        row.up === null || row.checked_at === null || row.latency_ms === null
          ? undefined
          : { up: row.up, status: row.status, latencyMs: row.latency_ms, checkedAt: row.checked_at },
      checks: row.checks,
      upChecks: row.up_checks,
    }))
  }

  /** What each monitor did between `since` (included) and `until` (excluded), by occurrence. */
  async summary(since: Date, until: Date): Promise<MonitorSummaryRow[]> {
    const rows = await this.db.query<{
      id: number
      name: string
      checks: number
      failures: number
      average_latency_ms: number | null
    }>(
      `SELECT m.id, m.name, count(r.id)::int AS checks, (count(r.id) FILTER (WHERE NOT r.up))::int AS failures,
              round(avg(r.latency_ms))::int AS average_latency_ms
         FROM monitors m
         LEFT JOIN probe_results r ON r.monitor_id = m.id AND r.scheduled_at >= $1 AND r.scheduled_at < $2
        GROUP BY m.id, m.name
        ORDER BY m.name, m.id`,
      [since, until],
    )
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      checks: row.checks,
      failures: row.failures,
      averageLatencyMs: row.average_latency_ms,
    }))
  }
}
