import type { ErrorHandlerResult, InboundMessage } from '@znight/messaging'
import type { Logger } from '@znight/observability'
import type { EmailService } from './email.service.js'
import type { SuppressionList } from './suppression.list.js'

import { Consumer, Ctx, Message, OnError, OnMessage, Retry } from '@znight/messaging'

import { EMAILS_QUEUE, SEND_EMAIL, SendEmailJob } from './email.jobs.js'
import { RecipientRejectedError } from './smtp.client.js'

/**
 * Consumes the "emails.send" queue.
 *
 * - `concurrency: 4`: up to four emails in flight (sending is I/O bound). Static, like every
 *   decorator argument: read by the compiler (`EMAILS_QUEUE` is a `const` from another file).
 * - Delivery is at-least-once: EmailService passes the message id to the SMTP server, which ignores
 *   a Message-ID it already accepted.
 * - Dead letters go to `emails.send.dlq` (the driver's default naming).
 */
@Consumer({ queue: EMAILS_QUEUE, concurrency: 4 })
export class EmailConsumer {
  constructor(
    private readonly emails: EmailService,
    private readonly suppressions: SuppressionList,
    private readonly logger: Logger,
  ) {}

  /**
   * `@Message(SendEmailJob)`: the payload is validated by the Zod schema before the handler runs; an
   * invalid payload is dead-lettered at once (reason `validation`), never retried. `job` is the
   * schema output (`locale` and `data` defaulted).
   *
   * `@Retry`: 4 attempts in total, waiting 250 ms, 500 ms then 1 s between them. Errors are retried
   * unless they are `NonRetryableError`s (RecipientRejectedError, a template variable missing...).
   */
  @OnMessage(SEND_EMAIL)
  @Retry({ attempts: 4, backoff: 'exponential', delay: 250, maxDelay: 2_000 })
  async send(@Message(SendEmailJob) job: SendEmailJob, @Ctx() message: InboundMessage): Promise<void> {
    await this.emails.send(job, message.id)
  }

  /**
   * Called once a message will not be retried anymore (non-retryable error, invalid payload, last
   * attempt failed). Returning `'ack'` acknowledges it; anything else dead-letters it.
   *
   * A hard bounce is an expected outcome, not an incident: the address is suppressed and the message
   * acknowledged. Everything else goes to the dead-letter queue, to be inspected and replayed.
   */
  @OnError()
  onError(error: unknown, message: InboundMessage): ErrorHandlerResult {
    if (error instanceof RecipientRejectedError) {
      this.suppressions.add(error.recipient, `SMTP ${error.smtpCode}`)
      this.logger.warn('Hard bounce: recipient suppressed', { recipient: error.recipient, jobId: message.id })
      return 'ack'
    }
    return undefined
  }
}
