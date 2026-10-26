import type { GenerateReportJob } from './report.jobs.js'
import type { ReportsConfig } from './reports.config.js'

import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Injectable } from '@znight/core'

/** Where generated reports are written: `<REPORTS_OUTPUT_DIR>/<reportId>.<format>`. */
@Injectable()
export class ReportStore {
  constructor(private readonly config: ReportsConfig) {}

  /** Path of the report file of `job`. */
  pathOf(job: Pick<GenerateReportJob, 'reportId' | 'format'>): string {
    return join(this.config.outputDir, `${job.reportId}.${job.format}`)
  }

  /** Whether the report was already generated (the job is a redelivery): deduplication on `reportId`. */
  async exists(job: Pick<GenerateReportJob, 'reportId' | 'format'>): Promise<boolean> {
    try {
      return (await stat(this.pathOf(job))).isFile()
    } catch {
      return false
    }
  }

  /** Writes the report atomically (temporary file + rename): a crash never leaves a partial report. */
  async save(job: Pick<GenerateReportJob, 'reportId' | 'format'>, content: string): Promise<string> {
    const path = this.pathOf(job)
    await mkdir(this.config.outputDir, { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, content)
    await rename(temporary, path)
    return path
  }
}
