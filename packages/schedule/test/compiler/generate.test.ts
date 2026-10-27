/**
 * The generated section (RFC 0004 §6): jobs sorted by name, defaults omitted, expressions and zones
 * as written, `JobContext` imported only when a job takes it, byte-identical across modes.
 */

import { cleanupApps, compileApp, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const JOBS = `import { Injectable } from '@znight/core'
import { Cron, Interval, Timeout, type JobContext } from '@znight/schedule'

@Injectable()
export class ReportService {}

export class DigestJobs {
  constructor(private readonly reports: ReportService) {}

  @Cron('0   8 * * MON-FRI', { name: 'digest.daily', timeZone: 'US/Eastern', maxDuration: '10m' })
  async sendDaily(ctx: JobContext): Promise<void> {
    void ctx
    void this.reports
  }

  @Cron('@daily', { enabled: false, overlap: 'skip', lock: true })
  nightly(): void {}
}

export class StatusCache {
  @Interval('1m', { name: 'status-cache.refresh', lock: false, runOnStart: true, overlap: 'queue' })
  refresh(): void {}

  @Timeout('2s', { name: 'status-cache.warm' })
  warm(): void {}
}
`

/** The schedule section of a generated module. */
function section(code: string): string {
  const start = code.indexOf("    ['schedule']: {")
  const end = code.indexOf('\n    },\n', start)
  return code.slice(start, end + 7)
}

describe('generated metadata', () => {
  it('emits the section of RFC 0004 §6.2', async () => {
    const app = tempApp({ 'src/jobs.ts': JOBS })
    const result = await compileApp(app.root, { mode: 'build' })
    expect(result.diagnostics).toEqual([])
    expect(section(result.code)).toBe(`    ['schedule']: {
      ['jobs']: [
        {
          ['name']: 'DigestJobs.nightly',
          ['token']: 'src/jobs.ts#DigestJobs',
          ['method']: 'nightly',
          ['kind']: 'cron',
          ['cron']: '@daily',
          ['lock']: true,
          ['enabled']: false,
          ['invoke']: (c: DigestJobs) => c.nightly(),
        },
        {
          ['name']: 'digest.daily',
          ['token']: 'src/jobs.ts#DigestJobs',
          ['method']: 'sendDaily',
          ['kind']: 'cron',
          ['cron']: '0 8 * * MON-FRI',
          ['timeZone']: 'US/Eastern',
          ['maxDuration']: 600000,
          ['invoke']: (c: DigestJobs, j: JobContext) => c.sendDaily(j),
        },
        {
          ['name']: 'status-cache.refresh',
          ['token']: 'src/jobs.ts#StatusCache',
          ['method']: 'refresh',
          ['kind']: 'interval',
          ['every']: 60000,
          ['overlap']: 'queue',
          ['lock']: false,
          ['runOnStart']: true,
          ['invoke']: (c: StatusCache) => c.refresh(),
        },
        {
          ['name']: 'status-cache.warm',
          ['token']: 'src/jobs.ts#StatusCache',
          ['method']: 'warm',
          ['kind']: 'timeout',
          ['delay']: 2000,
          ['invoke']: (c: StatusCache) => c.warm(),
        },
      ],
    },`)
    expect(result.code).toContain("import type { JobContext } from '@znight/schedule'")
    expect(result.code).toContain("import { DigestJobs, ReportService, StatusCache } from '../jobs.js'")
    // hosts are providers: DigestJobs and StatusCache are auto-registered singletons
    expect(result.code).toContain("['src/jobs.ts#StatusCache']: {")
  })

  it('imports JobContext only when a job takes it, and omits the section without job', async () => {
    const without = tempApp({
      'src/jobs.ts': `import { Interval } from '@znight/schedule'
export class Jobs {
  @Interval('1m')
  run(): void {}
}
`,
    })
    const result = await compileApp(without.root)
    expect(result.code).not.toContain('JobContext')
    expect(result.code).toContain("['invoke']: (c: Jobs) => c.run()")

    const empty = tempApp({ 'src/main.ts': "export { SchedulePlugin } from '@znight/schedule'\n" })
    expect((await compileApp(empty.root)).code).not.toContain("['schedule']")
  })

  it('is deterministic: the same section in serve and build modes, whatever the scan order', async () => {
    const app = tempApp({
      'src/jobs.ts': JOBS,
      'src/other.ts': JOBS.replaceAll('digest.daily', 'other.daily')
        .replaceAll('status-cache', 'other-cache')
        .replaceAll('DigestJobs', 'OtherDigest')
        .replaceAll('StatusCache', 'OtherCache')
        .replaceAll('ReportService', 'OtherReports'),
    })
    const serve = await compileApp(app.root, { mode: 'serve' })
    const build = await compileApp(app.root, { mode: 'build' })
    expect(serve.diagnostics).toEqual([])
    expect(section(serve.code)).toBe(section(build.code))
    const again = await compileApp(app.root, { mode: 'serve' })
    expect(again.code).toBe(serve.code)
  })
})
