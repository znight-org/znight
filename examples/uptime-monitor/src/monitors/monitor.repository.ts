import type { Database } from '../db/database.js'
import type { Monitor, MonitorSchedule, NewMonitor } from './monitor.js'

import { Injectable } from '@znight/core'

interface MonitorRow {
  readonly id: number
  readonly name: string
  readonly url: string
  readonly expected_status: number
  readonly every_ms: number | null
  readonly cron: string | null
  readonly time_zone: string | null
  readonly timeout_ms: number
  readonly created_at: Date
  readonly [column: string]: unknown
}

function toMonitor(row: MonitorRow): Monitor {
  const schedule: MonitorSchedule =
    row.every_ms === null ? { cron: row.cron ?? '', timeZone: row.time_zone ?? 'UTC' } : { every: row.every_ms }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    expectedStatus: row.expected_status,
    schedule,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
  }
}

/** The monitors, in PostgreSQL. */
@Injectable()
export class MonitorRepository {
  constructor(private readonly db: Database) {}

  async all(): Promise<Monitor[]> {
    const rows = await this.db.query<MonitorRow>('SELECT * FROM monitors ORDER BY id')
    return rows.map(toMonitor)
  }

  async find(id: number): Promise<Monitor | undefined> {
    const [row] = await this.db.query<MonitorRow>('SELECT * FROM monitors WHERE id = $1', [id])
    return row === undefined ? undefined : toMonitor(row)
  }

  async create(monitor: NewMonitor): Promise<Monitor> {
    const { schedule } = monitor
    const [row] = await this.db.query<MonitorRow>(
      `INSERT INTO monitors (name, url, expected_status, every_ms, cron, time_zone, timeout_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        monitor.name,
        monitor.url,
        monitor.expectedStatus,
        'every' in schedule ? schedule.every : null,
        'cron' in schedule ? schedule.cron : null,
        'cron' in schedule ? schedule.timeZone : null,
        monitor.timeoutMs,
      ],
    )
    if (row === undefined) throw new Error('INSERT ... RETURNING returned no row')
    return toMonitor(row)
  }

  /** Deletes a monitor and its results; `false` when there was none. */
  async delete(id: number): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM monitors WHERE id = $1 RETURNING id', [id])
    return rows.length === 1
  }
}
