import type { LogEntry } from './support.js'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigPlugin, inline } from '@znight/config'
import { MessageBroker, MessagingPlugin } from '@znight/messaging'
import { type MemoryDriver, memory } from '@znight/messaging/memory'
import { ObservabilityPlugin } from '@znight/observability'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { EMAILS_QUEUE, SEND_EMAIL, type SendEmailInput } from '../src/emails/email.jobs.js'
import { FakeSmtpClient, SmtpClient } from '../src/emails/smtp.client.js'
import { SuppressionList } from '../src/emails/suppression.list.js'
import {
  GENERATE_REPORT,
  type GenerateReportInput,
  REPORTS_DEAD_LETTER_QUEUE,
  REPORTS_QUEUE,
} from '../src/reports/report.jobs.js'
import { captureLogs } from './support.js'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

// The whole worker, in memory: the real container, consumers, retries and dead letters, with the
// memory driver as broker. TestApp starts the application without signal handlers.
let app: TestApp
let driver: MemoryDriver
let logs: LogEntry[]
let outputDir: string

beforeEach(async () => {
  driver = memory()
  outputDir = await mkdtemp(join(tmpdir(), 'znight-worker-test-'))
  const capture = captureLogs()
  logs = capture.entries
  app = await TestApp.create({
    metadata,
    plugins: [
      ObservabilityPlugin.configure({
        logging: { level: 'debug', destination: capture.destination },
        metrics: false,
      }),
      // only these values: neither .env files nor the environment
      ConfigPlugin.configure({
        loaders: [inline({ REPORTS_OUTPUT_DIR: outputDir, REPORTS_MS_PER_DAY: '1', SMTP_LATENCY_MS: '0' })],
      }),
      MessagingPlugin.configure({ driver }),
    ],
  })
})

afterEach(async () => {
  await app.close()
  await rm(outputDir, { recursive: true, force: true })
})

/** The fake SMTP server the factory created (SmtpClient resolves to the @Provides value). */
function smtp(): FakeSmtpClient {
  const client = app.get(SmtpClient)
  if (!(client instanceof FakeSmtpClient)) throw new Error('expected the fake SMTP client')
  return client
}

function sendEmail(job: SendEmailInput, id?: string): void {
  // as an external producer would: straight into the broker
  driver.send(EMAILS_QUEUE, { type: SEND_EMAIL, payload: job, ...(id === undefined ? {} : { id }) })
}

function logged(message: string): LogEntry[] {
  return logs.filter(entry => entry.msg === message)
}

describe('emails.send', () => {
  it('sends a templated email', async () => {
    sendEmail({ to: 'ada@example.com', template: 'welcome', data: { name: 'Ada' } })
    await driver.idle()

    expect(driver.settlements(EMAILS_QUEUE)).toMatchObject([{ action: 'ack', attempt: 1 }])
    expect(smtp().outbox).toMatchObject([{ to: 'ada@example.com', subject: 'Welcome, Ada!' }])
  })

  it('retries a temporary SMTP failure', async () => {
    sendEmail({ to: 'grace@flaky.test', template: 'welcome', data: { name: 'Grace' } })
    await driver.idle()

    // attempt 1 fails (421), redelivered after 250 ms, attempt 2 succeeds
    expect(driver.settlements(EMAILS_QUEUE)).toMatchObject([
      { action: 'retry', attempt: 1 },
      { action: 'ack', attempt: 2 },
    ])
    expect(smtp().outbox).toHaveLength(1)
  })

  it('dead-letters a job once its attempts run out', async () => {
    sendEmail({ to: 'ops@down.test', template: 'welcome', data: { name: 'Ops' } })
    await driver.idle()

    expect(driver.settlements(EMAILS_QUEUE).map(settlement => settlement.action)).toEqual([
      'retry',
      'retry',
      'retry',
      'dead-letter',
    ])
    expect(driver.deadLetters(EMAILS_QUEUE)).toMatchObject([
      { queue: 'emails.send.dlq', reason: 'max-attempts', attempt: 4 },
    ])
  })

  it('a hard bounce is acknowledged by @OnError and the address suppressed', async () => {
    sendEmail({ to: 'ghost@bounce.test', template: 'welcome', data: { name: 'Ghost' } })
    await driver.idle()
    sendEmail({ to: 'ghost@bounce.test', template: 'welcome', data: { name: 'Ghost' } })
    await driver.idle()

    expect(driver.settlements(EMAILS_QUEUE)).toMatchObject([{ action: 'ack' }, { action: 'ack' }])
    expect(driver.deadLetters(EMAILS_QUEUE)).toEqual([])
    expect(app.get(SuppressionList).get('ghost@bounce.test')).toMatchObject({ reason: 'SMTP 550' })
    expect(logged('Recipient suppressed, email skipped')).toHaveLength(1)
  })

  it('an invalid payload is dead-lettered without retry', async () => {
    sendEmail({ to: 'not an email', template: 'welcome' })
    await driver.idle()

    expect(driver.deadLetters(EMAILS_QUEUE)).toMatchObject([{ reason: 'validation', attempt: 1 }])
    expect(smtp().outbox).toEqual([])
  })

  it('a missing template variable is dead-lettered without retry', async () => {
    sendEmail({ to: 'ada@example.com', template: 'password-reset' })
    await driver.idle()

    expect(driver.deadLetters(EMAILS_QUEUE)).toMatchObject([{ reason: 'non-retryable', attempt: 1 }])
  })

  it('a message no handler matches is dead-lettered', async () => {
    driver.send(EMAILS_QUEUE, { type: 'email.fax', payload: {} })
    await driver.idle()

    expect(driver.deadLetters(EMAILS_QUEUE)).toMatchObject([{ reason: 'no-handler' }])
  })

  it('a redelivered job is not emailed twice', async () => {
    sendEmail({ to: 'ada@example.com', template: 'welcome', data: { name: 'Ada' } }, 'welcome-ada')
    sendEmail({ to: 'ada@example.com', template: 'welcome', data: { name: 'Ada' } }, 'welcome-ada')
    await driver.idle()

    expect(smtp().outbox).toHaveLength(1)
    expect(logged('Email already sent, skipped')).toHaveLength(1)
  })
})

describe('reports.generate', () => {
  const report: GenerateReportInput = {
    reportId: 'sales-2026-q1',
    kind: 'sales',
    from: '2026-01-01',
    to: '2026-03-31',
    notify: 'ada@example.com',
  }

  async function publishReport(job: GenerateReportInput, correlationId?: string): Promise<void> {
    // as a provider of the application would: through the injectable MessageBroker
    await app.get(MessageBroker).publish(REPORTS_QUEUE, job, {
      type: GENERATE_REPORT,
      ...(correlationId === undefined ? {} : { headers: { 'x-correlation-id': correlationId } }),
    })
  }

  it('generates the report file, then emails the requester', async () => {
    await publishReport(report)
    await driver.idle()

    const csv = await readFile(join(outputDir, 'sales-2026-q1.csv'), 'utf8')
    expect(csv.trimEnd().split('\n')).toHaveLength(1 + 90) // header + one row per day
    // the notification went through the "emails.send" queue
    expect(driver.published(EMAILS_QUEUE)).toMatchObject([{ id: 'report-ready-sales-2026-q1' }])
    expect(smtp().outbox).toMatchObject([{ to: 'ada@example.com', subject: 'Report sales-2026-q1 is ready' }])
  })

  it('every message has its own request-scoped JobContext', async () => {
    await publishReport({ ...report, reportId: 'a', notify: undefined }, 'close-january')
    await publishReport({ ...report, reportId: 'b', notify: undefined }, 'close-february')
    await driver.idle()

    // logged through JobContext.logger: each entry carries the fields of its own message
    const started = logged('Generating report')
    expect(started.map(entry => [entry.reportId, entry.correlationId])).toEqual([
      ['a', 'close-january'],
      ['b', 'close-february'],
    ])
    expect(new Set(started.map(entry => entry.jobId)).size).toBe(2)
  })

  it('a redelivered report is neither generated nor emailed twice', async () => {
    await publishReport(report)
    await driver.idle()
    await publishReport(report) // same reportId, delivered again once the first one was handled
    await driver.idle()

    expect(logged('Generating report')).toHaveLength(1)
    expect(logged('Report already generated, skipped')).toHaveLength(1)
    expect(smtp().outbox).toHaveLength(1)
  })

  it('an invalid period goes to the "reports.failed" dead-letter queue', async () => {
    await publishReport({ ...report, from: '2026-03-31', to: '2026-01-01' })
    await driver.idle()

    expect(driver.deadLetters(REPORTS_QUEUE)).toMatchObject([
      { queue: REPORTS_DEAD_LETTER_QUEUE, reason: 'validation' },
    ])
    expect(driver.pending(REPORTS_DEAD_LETTER_QUEUE)).toHaveLength(1)
  })

  it('stopping the worker lets an in-flight report finish (graceful drain)', async () => {
    await publishReport({ ...report, reportId: 'yearly', from: '2025-01-01', to: '2025-12-31', notify: undefined })
    await driver.waitFor(() => logged('Generating report').length === 1)

    await app.close() // what SIGTERM does: stop receiving, wait for the in-flight messages

    expect(logged('Shutdown requested: finishing the report first')).toHaveLength(1)
    expect(logged('Report generated')).toMatchObject([{ reportId: 'yearly', rows: 365 }])
    expect(driver.settlements(REPORTS_QUEUE)).toMatchObject([{ action: 'ack' }])
  })
})
