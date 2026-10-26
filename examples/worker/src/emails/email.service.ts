import type { Lazy } from '@znight/core'
import type { JobContext } from '../messaging/job-context.js'
import type { SendEmailJob } from './email.jobs.js'
import type { EmailRenderer } from './email.renderer.js'
import type { SmtpClient } from './smtp.client.js'
import type { SmtpConfig } from './smtp.config.js'
import type { SuppressionList } from './suppression.list.js'

import { Injectable } from '@znight/core'

/** Outcome of {@link EmailService.send}. */
export type SendOutcome = 'sent' | 'duplicate' | 'suppressed'

/**
 * Renders and sends emails. A singleton: dependencies are created once, at boot. The per-message
 * JobContext is request-scoped, so it is injected lazily and resolved in the scope of the message
 * being handled (`this.job.get()`).
 */
@Injectable()
export class EmailService {
  constructor(
    private readonly smtp: SmtpClient,
    private readonly renderer: EmailRenderer,
    private readonly suppressions: SuppressionList,
    private readonly config: SmtpConfig,
    private readonly job: Lazy<JobContext>,
  ) {}

  /**
   * Sends the email of `job`. `messageId` identifies the job: a redelivered message (at-least-once
   * delivery) is not sent twice.
   */
  async send(job: SendEmailJob, messageId: string): Promise<SendOutcome> {
    const { logger } = this.job.get()
    if (this.suppressions.has(job.to)) {
      logger.info('Recipient suppressed, email skipped', { to: job.to, template: job.template })
      return 'suppressed'
    }
    const { subject, text } = this.renderer.render(job)
    const receipt = await this.smtp.send({
      messageId: `<${messageId}@worker.znight>`,
      from: this.config.from,
      to: job.to,
      subject,
      text,
    })
    logger.info(receipt.accepted ? 'Email sent' : 'Email already sent, skipped', {
      to: job.to,
      template: job.template,
    })
    return receipt.accepted ? 'sent' : 'duplicate'
  }
}
