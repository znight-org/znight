import type { SendEmailInput } from '../emails/email.jobs.js'
import type { ReportGenerator } from './report.generator.js'
import type { ReportStore } from './report.store.js'

import { Consumer, Message, type MessageBroker, OnMessage, Retry } from '@znight/messaging'

import { EMAILS_QUEUE, SEND_EMAIL } from '../emails/email.jobs.js'
import { CORRELATION_HEADER, type JobContext } from '../messaging/job-context.js'
import { GENERATE_REPORT, GenerateReportJob, REPORTS_DEAD_LETTER_QUEUE, REPORTS_QUEUE } from './report.jobs.js'

/**
 * Consumes the "reports.generate" queue.
 *
 * - `scope: 'request'`: a new ReportConsumer per message, created in the message's scope, so it can
 *   inject the request-scoped JobContext directly (a singleton consumer would need `Lazy<JobContext>`).
 * - `concurrency: 2`: reports are expensive, at most two at a time per worker process.
 * - `deadLetter`: failed reports go to "reports.failed" instead of the default "reports.generate.dlq".
 */
@Consumer({ queue: REPORTS_QUEUE, scope: 'request', concurrency: 2, deadLetter: REPORTS_DEAD_LETTER_QUEUE })
export class ReportConsumer {
  constructor(
    private readonly job: JobContext,
    private readonly generator: ReportGenerator,
    private readonly store: ReportStore,
    private readonly broker: MessageBroker,
  ) {}

  /**
   * Generates the report, then asks the "emails.send" queue to notify the requester.
   *
   * At-least-once delivery makes every step idempotent: an existing report is not generated again,
   * and the notification has a deterministic message id (`report-ready-<reportId>`), so the email
   * consumer sends it once even if this job runs twice.
   *
   * `@Retry`: 3 attempts, 2 s apart. With the memory driver (1 s in-process budget) the delay is
   * scheduled natively; with RabbitMQ (5 s budget) the message is held in-process meanwhile.
   */
  @OnMessage(GENERATE_REPORT)
  @Retry({ attempts: 3, backoff: 'fixed', delay: 2_000 })
  async generate(@Message(GenerateReportJob) request: GenerateReportJob): Promise<void> {
    const { logger } = this.job
    if (await this.store.exists(request)) {
      logger.info('Report already generated, skipped', { reportId: request.reportId })
    } else {
      logger.info('Generating report', {
        reportId: request.reportId,
        kind: request.kind,
        from: request.from,
        to: request.to,
      })
      const onShutdown = (): void =>
        logger.info('Shutdown requested: finishing the report first', { reportId: request.reportId })
      this.job.shutdownSignal.addEventListener('abort', onShutdown, { once: true })
      try {
        const report = await this.generator.generate(request, logger)
        const location = await this.store.save(request, report.content)
        logger.info('Report generated', { reportId: request.reportId, rows: report.rows, location })
      } finally {
        this.job.shutdownSignal.removeEventListener('abort', onShutdown)
      }
    }
    if (request.notify !== undefined) await this.notify(request, request.notify)
  }

  private async notify(request: GenerateReportJob, to: string): Promise<void> {
    const email: SendEmailInput = {
      to,
      template: 'report-ready',
      data: { reportId: request.reportId, location: this.store.pathOf(request) },
    }
    await this.broker.publish(EMAILS_QUEUE, email, {
      type: SEND_EMAIL,
      id: `report-ready-${request.reportId}`,
      // the email job belongs to the same operation: its logs carry the same correlation id
      headers: { [CORRELATION_HEADER]: this.job.correlationId },
    })
  }
}
