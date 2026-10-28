import type { ScheduledJob } from '@znight/schedule'
import type { Mailer } from '../src/digest/mailer.js'
import type { DigestReport } from '../src/digest/report.service.js'

import { parseCron, SchedulerRegistry } from '@znight/schedule'
import { createJobContext } from '@znight/schedule/testing'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { DigestJobs, digestMail, previousRun } from '../src/digest/digest.jobs.js'
import { ReportService } from '../src/digest/report.service.js'
import { describe, expect, test as it } from 'bun:test'

const MONDAY = new Date('2027-03-29T06:00:00Z') // 08:00 in Paris (CEST)
const FRIDAY = new Date('2027-03-26T07:00:00Z') // 08:00 in Paris (CET)

function aReport(fields: Partial<DigestReport> = {}): DigestReport {
  return {
    since: FRIDAY,
    until: MONDAY,
    checks: 3,
    failures: 1,
    monitors: [{ id: 1, name: 'API', checks: 3, failures: 1, uptime: 66.67, averageLatencyMs: 40 }],
    ...fields,
  }
}

/** The schedule of `digest.daily`, as the registry would expose it (only `nextRuns` is read). */
function digestJob(expression = '0 8 * * MON-FRI'): ScheduledJob {
  const schedule = parseCron(expression, { timeZone: 'Europe/Paris' })
  return { nextRuns: (count: number, from?: Date) => schedule.nextRuns(count, from) } as ScheduledJob
}

/**
 * Unit tests: a job is a method. TestBed builds `DigestJobs` with auto-mocked dependencies, the test
 * calls the method with a `JobContext` of its choosing: no scheduler, no clock, no database.
 */
describe('DigestJobs', () => {
  async function setup() {
    const { instance, mocks } = await TestBed.create(DigestJobs, {
      metadata,
      config: { digest: { recipients: ['ops@example.com', 'cto@example.com'] } },
    })
    // `Mailer` is an interface: its mock is found by name
    return { jobs: instance, mocks, mailer: mocks.get<Mailer>('Mailer'), reports: mocks.get(ReportService) }
  }

  it("reports on the period ending at the run's occurrence, never on the current time", async () => {
    const { jobs, mocks, mailer, reports } = await setup()
    mocks.get(SchedulerRegistry).get.mockReturnValue(digestJob())
    reports.build.mockResolvedValue(aReport())
    // a late run (a stalled process): it still stands for Monday 08:00
    const ctx = createJobContext({
      job: 'digest.daily',
      scheduledAt: MONDAY,
      startedAt: new Date('2027-03-29T06:42:00Z'),
    })

    await jobs.sendDaily(ctx)

    // since the previous occurrence of its own schedule: Monday's digest covers the weekend
    expect(reports.build).toHaveBeenCalledWith({ since: FRIDAY, until: MONDAY, signal: ctx.signal })
    expect(mailer.send).toHaveBeenCalledWith({
      key: 'digest.daily:2027-03-29T06:00:00.000Z', // one e-mail per occurrence, whoever runs it
      to: ['ops@example.com', 'cto@example.com'],
      subject: 'Uptime digest: 1 failed check',
      text: expect.stringContaining('- API: 66.67% up (2/3 checks), 40 ms on average'),
    })
  })

  it('falls back to the last 24 hours when the job has no schedule to look back on', async () => {
    const { jobs, mocks, reports } = await setup()
    mocks.get(SchedulerRegistry).get.mockReturnValue(undefined) // triggered by name, the job removed meanwhile
    reports.build.mockResolvedValue(aReport())

    await jobs.sendDaily(createJobContext({ job: 'digest.daily', scheduledAt: MONDAY }))

    expect(reports.build).toHaveBeenCalledWith(expect.objectContaining({ since: new Date('2027-03-28T06:00:00Z') }))
  })

  it('stops when its signal is aborted (maxDuration, shutdown, lost lock)', async () => {
    const { jobs, mailer, reports } = await setup()
    const ctx = createJobContext({ job: 'digest.daily', scheduledAt: MONDAY })
    reports.build.mockImplementation(({ signal }) => {
      ctx.abort('timeout') // the report took longer than maxDuration
      signal.throwIfAborted()
      return Promise.resolve(aReport())
    })

    await expect(jobs.sendDaily(ctx)).rejects.toMatchObject({ name: 'JobAbortedError', reason: 'timeout' })
    expect(mailer.send).not.toHaveBeenCalled()
  })
})

describe('previousRun', () => {
  it('finds the previous occurrence of the schedule, across a weekend and a DST switch', () => {
    // Monday 29 March 2027 08:00 CEST; the previous one is Friday 08:00 CET (the clocks moved on Sunday)
    expect(previousRun(digestJob(), MONDAY)).toEqual(FRIDAY)
    expect(previousRun(digestJob(), new Date('2027-03-30T06:00:00Z'))).toEqual(MONDAY)
  })

  it('follows an overridden schedule (DIGEST_CRON)', () => {
    expect(previousRun(digestJob('*/30 * * * *'), new Date('2027-03-29T06:00:00Z'))).toEqual(
      new Date('2027-03-29T05:30:00Z'),
    )
  })
})

describe('digestMail', () => {
  it('says when every check passed', () => {
    const mail = digestMail(aReport({ failures: 0 }), ['ops@example.com'], 'key')

    expect(mail.subject).toBe('Uptime digest: all 3 checks passed')
    expect(digestMail(aReport({ checks: 0, failures: 0 }), [], 'key').subject).toBe('Uptime digest: no check')
    expect(mail.text.split('\n')[0]).toBe('Uptime from 2027-03-26T07:00:00.000Z to 2027-03-29T06:00:00.000Z')
  })
})
