import { Logger } from '@znight/observability'
import { createMock, TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { ReportGenerator } from '../src/reports/report.generator.js'
import { GenerateReportJob } from '../src/reports/report.jobs.js'
import { describe, expect, test as it } from 'bun:test'

// ReportsConfig is a @Config class: TestBed injects a real instance, with the `config` values.
async function createGenerator() {
  const { instance } = await TestBed.create(ReportGenerator, { metadata, config: { reports: { msPerDay: 0 } } })
  return instance
}

describe('ReportGenerator', () => {
  it('one CSV row per day of the period, both ends included', async () => {
    const generator = await createGenerator()
    const job = GenerateReportJob.parse({ reportId: 'r', kind: 'sales', from: '2026-02-27', to: '2026-03-02' })

    const report = await generator.generate(job, createMock(Logger))

    const lines = report.content.trimEnd().split('\n')
    expect(report.rows).toBe(4)
    expect(lines[0]).toBe('date,orders,revenue')
    expect(lines.slice(1).map(line => line.split(',')[0])).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ])
  })

  it('JSON reports, deterministic data', async () => {
    const generator = await createGenerator()
    const job = GenerateReportJob.parse({
      reportId: 'r',
      kind: 'inventory',
      from: '2026-01-01',
      to: '2026-01-01',
      format: 'json',
    })

    const first = await generator.generate(job, createMock(Logger))
    const second = await generator.generate(job, createMock(Logger))

    expect(JSON.parse(first.content)).toEqual([
      { date: '2026-01-01', sku: expect.any(String), stock: expect.any(Number) },
    ])
    expect(second.content).toBe(first.content)
  })
})
