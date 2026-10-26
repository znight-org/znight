/**
 * Enqueues jobs for the worker.
 *
 *   bun scripts/publish.ts demo                       # one job per delivery path (see below)
 *   bun scripts/publish.ts email ada@example.com      # a welcome email
 *   bun scripts/publish.ts report q1 2026-01-01 2026-03-31 ada@example.com
 *
 * With RABBITMQ_URL (environment or .env files), the jobs are published to RabbitMQ: start the worker
 * first, it declares the queues. Without it, they are printed as JSON lines, the format of the
 * worker's stdin inbox:
 *
 *   bun scripts/publish.ts demo | WORKER_STDIN_INBOX=true bun run start
 *
 * Runs as is on Bun and Node.js 24 (`node scripts/publish.ts`): the job definitions are imported with
 * their `.ts` extension and only depend on zod.
 */
import { randomUUID } from 'node:crypto'
import { dotenv, env, loadConfigSource } from '@znight/config'
import { Application } from '@znight/core'
import { MessageBroker, MessagingPlugin } from '@znight/messaging'
import { rabbitmq } from '@znight/messaging/rabbitmq'

import { EMAILS_QUEUE, type EmailTemplate, SEND_EMAIL, type SendEmailInput } from '../src/emails/email.jobs.ts'
import { GENERATE_REPORT, type GenerateReportInput, REPORTS_QUEUE } from '../src/reports/report.jobs.ts'

/** A job: what to publish, and where. Also the JSON line format of the stdin inbox. */
interface Job {
  readonly queue: string
  readonly type: string
  readonly payload: unknown
  readonly headers?: Readonly<Record<string, string>>
}

function email(to: string, template: EmailTemplate = 'welcome'): Job {
  const data: Record<string, string> =
    template === 'password-reset'
      ? { resetUrl: 'https://example.com/reset?token=demo' }
      : { name: to.split('@')[0] ?? to }
  const payload: SendEmailInput = { to, template, data }
  return { queue: EMAILS_QUEUE, type: SEND_EMAIL, payload }
}

function report(reportId: string, from: string, to: string, notify?: string): Job {
  const payload: GenerateReportInput = {
    reportId,
    kind: 'sales',
    from,
    to,
    ...(notify === undefined ? {} : { notify }),
  }
  // the correlation id ties the report job and its notification email together in the logs
  return { queue: REPORTS_QUEUE, type: GENERATE_REPORT, payload, headers: { 'x-correlation-id': `report-${reportId}` } }
}

/** One job per delivery path of the worker. */
function demo(): Job[] {
  const run = randomUUID().slice(0, 8)
  return [
    email('ada@example.com'), // sent
    email('grace@flaky.test'), // temporary failure, retried, sent
    email('ghost@bounce.test'), // hard bounce: acknowledged by @OnError, address suppressed
    email('ops@down.test'), // SMTP down: retried 4 times, then dead-lettered (emails.send.dlq)
    { queue: EMAILS_QUEUE, type: SEND_EMAIL, payload: { to: 'not an email', template: 'welcome' } }, // invalid: dead-lettered at once
    report(`demo-${run}`, '2026-01-01', '2026-03-31', 'ada@example.com'), // a report, then its notification email
  ]
}

function jobsFromArguments(args: readonly string[]): Job[] {
  const [command, ...rest] = args
  if (command === 'demo') return demo()
  if (command === 'email' && rest[0] !== undefined) return [email(rest[0], rest[1] as EmailTemplate | undefined)]
  if (command === 'report' && rest.length >= 3) {
    const [id, from, to, notify] = rest as [string, string, string, string | undefined]
    return [report(id, from, to, notify)]
  }
  console.error(`Usage:
  publish.ts demo
  publish.ts email <to> [welcome|password-reset]
  publish.ts report <reportId> <from YYYY-MM-DD> <to YYYY-MM-DD> [notify]`)
  process.exit(2)
}

const jobs = jobsFromArguments(process.argv.slice(2))

// the same sources as the worker's ConfigPlugin: .env files, then the environment
const source = await loadConfigSource([dotenv(), env()])
const url = source.get('RABBITMQ_URL')

if (typeof url !== 'string' || url === '') {
  for (const job of jobs) console.log(JSON.stringify(job))
} else {
  // A publish-only Znight application: no providers (hand-written empty metadata), MessagingPlugin
  // with `consume: false`. publish() resolves once RabbitMQ confirmed the message.
  const app = await Application.create({
    metadata: { version: 1, providers: {}, resolutionOrder: [] },
    plugins: [
      MessagingPlugin.configure({ driver: rabbitmq({ url, connectionName: 'znight-publisher' }), consume: false }),
    ],
    shutdown: { signals: false },
  })
  await app.start()
  try {
    const broker = app.get(MessageBroker)
    for (const job of jobs) {
      const { id } = await broker.publish(job.queue, job.payload, { type: job.type, headers: job.headers })
      console.log(`published ${job.type} to ${job.queue} (${id})`)
    }
  } finally {
    await app.stop()
  }
}
