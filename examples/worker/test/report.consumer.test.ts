import { MessageBroker } from '@znight/messaging'
import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { JobContext } from '../src/messaging/job-context.js'
import { ReportConsumer } from '../src/reports/report.consumer.js'
import { ReportGenerator } from '../src/reports/report.generator.js'
import { GenerateReportJob } from '../src/reports/report.jobs.js'
import { ReportStore } from '../src/reports/report.store.js'
import { inboundMessage } from './support.js'
import { describe, expect, test as it } from 'bun:test'

// ReportConsumer is request-scoped (one instance per message): TestBed builds it like any provider.
// Its JobContext is a real one, built from a fake message; the other dependencies are auto-mocks.
async function createConsumer() {
  const context = new JobContext(
    inboundMessage({ id: 'job-1', headers: { 'x-correlation-id': 'monthly-close' } }),
    new Logger({ level: 'silent' }),
  )
  const built = await TestBed.create(ReportConsumer, { metadata, provide: [[JobContext, context]] })
  built.mocks.get(ReportStore).pathOf.mockReturnValue('/reports/r-1.csv')
  built.mocks.get(ReportGenerator).generate.mockResolvedValue({ rows: 31, content: 'date,orders,revenue\n' })
  return built
}

const request = GenerateReportJob.parse({
  reportId: 'r-1',
  kind: 'sales',
  from: '2026-01-01',
  to: '2026-01-31',
  notify: 'ada@example.com',
})

describe('ReportConsumer', () => {
  it('generates and stores the report, then asks for the notification email', async () => {
    const { instance, mocks } = await createConsumer()
    mocks.get(ReportStore).exists.mockResolvedValue(false)

    await instance.generate(request)

    expect(mocks.get(ReportStore).save).toHaveBeenCalledWith(request, 'date,orders,revenue\n')
    expect(mocks.get(MessageBroker).publish).toHaveBeenCalledWith(
      'emails.send',
      { to: 'ada@example.com', template: 'report-ready', data: { reportId: 'r-1', location: '/reports/r-1.csv' } },
      // deterministic id: a redelivered job does not email twice; same correlation id as the job
      { type: 'email.send', id: 'report-ready-r-1', headers: { 'x-correlation-id': 'monthly-close' } },
    )
  })

  it('a redelivered job does not generate the report again, but still notifies', async () => {
    const { instance, mocks } = await createConsumer()
    mocks.get(ReportStore).exists.mockResolvedValue(true)

    await instance.generate(request)

    expect(mocks.get(ReportGenerator).generate).not.toHaveBeenCalled()
    expect(mocks.get(ReportStore).save).not.toHaveBeenCalled()
    expect(mocks.get(MessageBroker).publish).toHaveBeenCalledTimes(1)
  })

  it('publishes nothing without a recipient', async () => {
    const { instance, mocks } = await createConsumer()
    mocks.get(ReportStore).exists.mockResolvedValue(false)

    await instance.generate({ ...request, notify: undefined })

    expect(mocks.get(ReportStore).save).toHaveBeenCalled()
    expect(mocks.get(MessageBroker).publish).not.toHaveBeenCalled()
  })
})
