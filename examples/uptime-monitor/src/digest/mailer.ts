/** An e-mail to send. */
export interface Mail {
  /**
   * Idempotency key: the same key is sent once, whatever the retries. Jobs derive it from their
   * occurrence (`digest.daily:2027-03-29T06:00:00.000Z`).
   */
  readonly key: string
  readonly to: readonly string[]
  readonly subject: string
  readonly text: string
}

/**
 * Sends e-mails: a port, so that jobs do not know how. `OutboxMailer` implements it here (the e-mail
 * is written to the database, a relay sends it); unit tests get an auto-mock.
 */
export interface Mailer {
  send(mail: Mail): Promise<void>
}
