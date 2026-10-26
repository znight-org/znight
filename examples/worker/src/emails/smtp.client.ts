import type { Logger } from '@znight/observability'
import type { SmtpConfig } from './smtp.config.js'

import { setTimeout as sleep } from 'node:timers/promises'
import { NonRetryableError } from '@znight/messaging'

/** An email ready to be sent. */
export interface Mail {
  /** Message-ID header: providers use it to deduplicate retried sends. */
  readonly messageId: string
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly text: string
}

/** What the server answered. */
export interface SendReceipt {
  readonly messageId: string
  /** `false` when the server already accepted a mail with this Message-ID (a redelivered job). */
  readonly accepted: boolean
}

/**
 * The SMTP port of the application. An abstract class rather than an interface so that it can be
 * used as a key at runtime (`container.get(SmtpClient)`, `mocks.get(SmtpClient)` in tests). The
 * implementation is chosen by SmtpFactory.
 */
export abstract class SmtpClient {
  abstract send(mail: Mail): Promise<SendReceipt>
  abstract close(): Promise<void>
}

/** Permanent rejection (SMTP 5xx): retrying cannot help, so the message is not retried. */
export class RecipientRejectedError extends NonRetryableError {
  override readonly name = 'RecipientRejectedError'

  constructor(
    readonly recipient: string,
    readonly smtpCode: number,
  ) {
    super(`${smtpCode} ${recipient}: recipient rejected`)
  }
}

/** Temporary failure (SMTP 4xx, network): a plain error, so the message is retried. */
export class SmtpUnavailableError extends Error {
  override readonly name = 'SmtpUnavailableError'
}

/**
 * A fake SMTP server for the example, deterministic so that every delivery path can be shown:
 *
 * | Recipient domain | Behaviour                                                          |
 * | ---------------- | ------------------------------------------------------------------ |
 * | `@bounce.test`   | 550 rejection (`RecipientRejectedError`, not retried)             |
 * | `@flaky.test`    | 421 on the first attempt for a recipient, accepted afterwards      |
 * | `@down.test`     | 421 every time (retried until the attempts run out: dead letter)  |
 * | anything else    | accepted                                                           |
 *
 * Accepted mails are kept in `outbox`. A Message-ID already accepted is not sent twice.
 */
export class FakeSmtpClient extends SmtpClient {
  /** Accepted mails, in order. */
  readonly outbox: Mail[] = []
  readonly #config: SmtpConfig
  readonly #logger: Logger
  readonly #flakyRecipients = new Set<string>()
  #connected = false

  constructor(config: SmtpConfig, logger: Logger) {
    super()
    this.#config = config
    this.#logger = logger
  }

  get connected(): boolean {
    return this.#connected
  }

  async connect(): Promise<void> {
    await sleep(this.#config.latencyMs)
    this.#connected = true
    // `config.password` is a secret: never log it (the config instance itself prints [REDACTED])
    this.#logger.info('SMTP connection opened', { host: this.#config.host, port: this.#config.port })
  }

  override async send(mail: Mail): Promise<SendReceipt> {
    if (!this.#connected) throw new SmtpUnavailableError('SMTP connection closed')
    await sleep(this.#config.latencyMs)
    const domain = mail.to.slice(mail.to.lastIndexOf('@') + 1)
    if (domain === 'bounce.test') throw new RecipientRejectedError(mail.to, 550)
    if (domain === 'down.test') throw new SmtpUnavailableError(`421 ${this.#config.host}: service not available`)
    if (domain === 'flaky.test' && !this.#flakyRecipients.has(mail.to)) {
      this.#flakyRecipients.add(mail.to)
      throw new SmtpUnavailableError(`421 ${this.#config.host}: too many connections, try again later`)
    }
    if (this.outbox.some(sent => sent.messageId === mail.messageId)) {
      return { messageId: mail.messageId, accepted: false }
    }
    this.outbox.push(mail)
    return { messageId: mail.messageId, accepted: true }
  }

  /** Called on shutdown by the container (`@Provides({ dispose: 'close' })`), after the consumers drained. */
  override async close(): Promise<void> {
    if (!this.#connected) return
    this.#connected = false
    await sleep(this.#config.latencyMs)
    this.#logger.info('SMTP connection closed', { sent: this.outbox.length })
  }
}
