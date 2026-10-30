import type { OutboxMailer, QueuedMail } from './outbox.mailer.js'

import { Controller, Get } from '@znight/http'

import { Roles } from '../auth/auth.decorators.js'

/** E-mails returned by `GET /admin/outbox`. */
const LIMIT = 20

/** The e-mails waiting for the relay: where the digests go (administrators only). */
@Controller('/admin/outbox')
@Roles(['admin'])
export class OutboxController {
  constructor(private readonly outbox: OutboxMailer) {}

  /** GET /admin/outbox: the latest e-mails, newest first. */
  @Get()
  list(): Promise<QueuedMail[]> {
    return this.outbox.queued(LIMIT)
  }
}
