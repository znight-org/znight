import type { ProbeResultRepository } from '../monitors/probe-result.repository.js'

import { Injectable } from '@znight/core'

/** What one monitor did during the period of a report. */
export interface MonitorReport {
  readonly id: number
  readonly name: string
  readonly checks: number
  readonly failures: number
  /** Successful checks, in percent; `null` without check. */
  readonly uptime: number | null
  readonly averageLatencyMs: number | null
}

/** The report of a period: what the digest says. */
export interface DigestReport {
  readonly since: Date
  readonly until: Date
  readonly checks: number
  readonly failures: number
  readonly monitors: readonly MonitorReport[]
}

/** What {@link ReportService.build} needs. */
export interface ReportRequest {
  /** Start of the period (included). */
  readonly since: Date
  /** End of the period (excluded): the occurrence of the digest. */
  readonly until: Date
  /** The run's signal: checked between the steps of a report. */
  readonly signal: AbortSignal
}

/** Builds the reports of the digest from the probe results. */
@Injectable()
export class ReportService {
  constructor(private readonly results: ProbeResultRepository) {}

  async build({ since, until, signal }: ReportRequest): Promise<DigestReport> {
    signal.throwIfAborted()
    const rows = await this.results.summary(since, until)
    signal.throwIfAborted()
    const monitors = rows.map(row => ({
      ...row,
      uptime: row.checks === 0 ? null : Math.round(((row.checks - row.failures) / row.checks) * 10_000) / 100,
    }))
    return {
      since,
      until,
      checks: monitors.reduce((sum, monitor) => sum + monitor.checks, 0),
      failures: monitors.reduce((sum, monitor) => sum + monitor.failures, 0),
      monitors,
    }
  }
}
