import type { Logger } from '@znight/observability'
import type { GenerateReportJob } from './report.jobs.js'
import type { ReportsConfig } from './reports.config.js'

import { setTimeout as sleep } from 'node:timers/promises'
import { Injectable } from '@znight/core'

/** A generated report. */
export interface GeneratedReport {
  readonly rows: number
  readonly content: string
}

const DAY_MS = 86_400_000
/** Days computed between two progress logs. */
const CHUNK_DAYS = 30

/**
 * Builds report files. The data is fake (deterministic numbers per day), the cost is simulated:
 * `REPORTS_MS_PER_DAY` per day of the period, so a yearly report is a slow job.
 */
@Injectable()
export class ReportGenerator {
  constructor(private readonly config: ReportsConfig) {}

  /**
   * Generates the report of `job`, logging its progress with `logger`. The job is not aborted when
   * the worker shuts down: in-flight messages are drained, so a report that started is finished.
   * (A job longer than the shutdown deadline should instead checkpoint and throw, to be retried.)
   */
  async generate(job: GenerateReportJob, logger: Logger): Promise<GeneratedReport> {
    const start = Date.parse(job.from)
    const days = Math.round((Date.parse(job.to) - start) / DAY_MS) + 1
    const records: Record<string, string | number>[] = []
    for (let offset = 0; offset < days; offset += CHUNK_DAYS) {
      const chunk = Math.min(CHUNK_DAYS, days - offset)
      await sleep(chunk * this.config.msPerDay) // the "expensive" part
      for (let day = offset; day < offset + chunk; day++) records.push(row(job.kind, start + day * DAY_MS))
      logger.debug('Report progress', { reportId: job.reportId, done: offset + chunk, days })
    }
    const content = job.format === 'json' ? `${JSON.stringify(records, null, 2)}\n` : toCsv(records)
    return { rows: records.length, content }
  }
}

function row(kind: GenerateReportJob['kind'], time: number): Record<string, string | number> {
  const date = new Date(time).toISOString().slice(0, 10)
  const seed = Math.abs(Math.sin(time / DAY_MS)) // deterministic "data"
  return kind === 'sales'
    ? { date, orders: Math.round(seed * 120), revenue: Math.round(seed * 9_000_00) / 100 }
    : { date, sku: `SKU-${Math.round(seed * 1_000)}`, stock: Math.round(seed * 5_000) }
}

function toCsv(records: readonly Record<string, string | number>[]): string {
  const [first] = records
  if (first === undefined) return ''
  const columns = Object.keys(first)
  const lines = records.map(record => columns.map(column => String(record[column])).join(','))
  return `${[columns.join(','), ...lines].join('\n')}\n`
}
