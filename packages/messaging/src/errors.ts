import { ErrorCode, ZnightError } from '@znight/core'

const NON_RETRYABLE = Symbol.for('znight.messaging.nonRetryable')

/**
 * Thrown by a handler to dead-letter the message immediately, without further attempts (invalid
 * business data, permanent failure...). Subclass it for domain errors.
 *
 * ```ts
 * if (order.total < 0) throw new NonRetryableError('Negative order total')
 * ```
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NonRetryableError'
  }
}
Object.defineProperty(NonRetryableError.prototype, NON_RETRYABLE, { value: true })

/**
 * Whether retrying `error` is pointless: a {@link NonRetryableError} (also recognised across copies of
 * this package, through a global symbol brand).
 */
export function isNonRetryable(error: unknown): boolean {
  return (
    error instanceof NonRetryableError ||
    (error !== null && typeof error === 'object' && (error as Record<symbol, unknown>)[NON_RETRYABLE] === true)
  )
}

/** One failed check of a `@Message(schema)` validation. */
export interface MessageValidationIssue {
  /** Dotted path of the invalid value (`items.0.quantity`), empty for the root. */
  readonly path: string
  readonly message: string
}

/** The payload does not match the `@Message(schema)` of the handler. Never retried. */
export class MessageValidationError extends NonRetryableError {
  readonly issues: readonly MessageValidationIssue[]

  constructor(label: string, issues: readonly MessageValidationIssue[]) {
    super(`Invalid ${label}: ${formatIssues(issues)}`)
    this.name = 'MessageValidationError'
    this.issues = issues
  }
}

/** The body cannot be decoded (malformed JSON...). Never retried. */
export class MessageDecodeError extends NonRetryableError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MessageDecodeError'
  }
}

/** No `@OnMessage` handler of the consumer matches the message type. Never retried. */
export class NoHandlerError extends NonRetryableError {
  readonly messageType: string | undefined

  constructor(consumer: string, type: string | undefined) {
    super(
      type === undefined
        ? `${consumer} has no default @OnMessage() handler for a message without type`
        : `${consumer} has no @OnMessage handler for message type "${type}"`,
    )
    this.name = 'NoHandlerError'
    this.messageType = type
  }
}

/** A delivery arrived after its last allowed attempt (e.g. redelivered after a dead-letter failure). */
export class AttemptsExhaustedError extends NonRetryableError {
  constructor(attempt: number, maxAttempts: number) {
    super(`Delivery attempt ${attempt} exceeds the ${maxAttempts} attempt(s) allowed by the retry policy`)
    this.name = 'AttemptsExhaustedError'
  }
}

function formatIssues(issues: readonly MessageValidationIssue[]): string {
  const shown = issues.slice(0, 5).map(issue => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : ''
  return `${shown.join('; ')}${more}`
}

/** A messaging configuration error (ZNIGHT011): invalid consumer, retry policy, driver options... */
export function consumerError(message: string, hints?: readonly string[]): ZnightError {
  return new ZnightError(ErrorCode.InvalidConsumer, message, hints === undefined ? {} : { hints })
}

/** An operation on the broker or a driver that is not available (not connected, closed...). */
export function brokerUnavailableError(message: string, cause?: unknown): ZnightError {
  return new ZnightError(ErrorCode.LifecycleFailed, message, cause === undefined ? {} : { cause })
}
