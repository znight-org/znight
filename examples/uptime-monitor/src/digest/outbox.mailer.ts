import type { Database } from '../db/database.js'
import type { Mail, Mailer } from './mailer.js'

import { Injectable } from '@znight/core'

/** An e-mail of the outbox. */
export interface QueuedMail extends Mail {
  readonly id: number
  readonly createdAt: Date
}

interface OutboxRow {
  readonly id: number
  readonly key: string
  readonly recipients: string[]
  readonly subject: string
  readonly body: string
  readonly created_at: Date
  readonly [column: string]: unknown
}

/**
 * {@link Mailer} through a transactional outbox: `send()` writes the e-mail to the `outbox` table, a
 * relay (an SMTP worker, out of this example) sends what is there. Writing is idempotent by key
 * (`ON CONFLICT DO NOTHING`), so a job that runs again for the same occurrence never queues the same
 * e-mail twice.
 */
@Injectable()
export class OutboxMailer implements Mailer {
  constructor(private readonly db: Database) {}

  async send(mail: Mail): Promise<void> {
    await this.db.query(
      `INSERT INTO outbox (key, recipients, subject, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [mail.key, [...mail.to], mail.subject, mail.text],
    )
  }

  /** The latest queued e-mails, newest first (`GET /admin/outbox`). */
  async queued(limit: number): Promise<QueuedMail[]> {
    const rows = await this.db.query<OutboxRow>('SELECT * FROM outbox ORDER BY id DESC LIMIT $1', [limit])
    return rows.map(row => ({
      id: row.id,
      key: row.key,
      to: row.recipients,
      subject: row.subject,
      text: row.body,
      createdAt: row.created_at,
    }))
  }
}
