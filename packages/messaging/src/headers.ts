/**
 * Header names used by Znight on the wire. They are plain message headers (AMQP headers, SQS message
 * attributes, Kafka record headers), so non-Znight producers and consumers can read and write them.
 */
export const MessagingHeaders: {
  /** Znight message id (Kafka and SQS; AMQP uses the `message-id` property). */
  readonly Id: 'x-znight-id'
  /** Message type used to select the handler (Kafka and SQS; AMQP uses the `type` property). */
  readonly Type: 'x-znight-type'
  /** Content type of the body (Kafka and SQS; AMQP uses the `content-type` property). */
  readonly ContentType: 'content-type'
  /** 1-based attempt number carried by republished retries (RabbitMQ, Kafka). */
  readonly Attempt: 'x-znight-attempt'
  /** Epoch milliseconds before which a Kafka retry record must not be processed. */
  readonly NotBefore: 'x-znight-not-before'
  /** Body encoding when the transport only carries text (SQS: `base64` for binary payloads). */
  readonly Encoding: 'x-znight-encoding'
  /** Why the message was dead-lettered (`DeadLetterReason`). */
  readonly DeadLetterReason: 'x-znight-dead-letter-reason'
  /** Message of the error that dead-lettered the message (truncated). */
  readonly Error: 'x-znight-error'
  /** Queue the dead-lettered message was consumed from. */
  readonly OriginalQueue: 'x-znight-original-queue'
  /** Number of attempts made before the message was dead-lettered. */
  readonly Attempts: 'x-znight-attempts'
  /** Kafka consumer group that dead-lettered the record. */
  readonly ConsumerGroup: 'x-znight-consumer-group'
} = Object.freeze({
  Id: 'x-znight-id',
  Type: 'x-znight-type',
  ContentType: 'content-type',
  Attempt: 'x-znight-attempt',
  NotBefore: 'x-znight-not-before',
  Encoding: 'x-znight-encoding',
  DeadLetterReason: 'x-znight-dead-letter-reason',
  Error: 'x-znight-error',
  OriginalQueue: 'x-znight-original-queue',
  Attempts: 'x-znight-attempts',
  ConsumerGroup: 'x-znight-consumer-group',
})

/** A record safe to fill with untrusted keys (`__proto__` is stored as a regular key). */
export function headerRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

/**
 * Reads a header: exact name first, then a case-insensitive match. Used by the code generated for
 * `@Headers('name')` parameters.
 */
export function messageHeader(
  message: { readonly headers: Readonly<Record<string, string>> },
  name: string,
): string | undefined {
  const headers = message.headers
  if (Object.hasOwn(headers, name)) return headers[name]
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/** Parses the {@link MessagingHeaders.Attempt} header: a positive integer, `1` when absent or invalid. */
export function attemptFromHeaders(headers: Readonly<Record<string, string>>): number {
  const value = Object.hasOwn(headers, MessagingHeaders.Attempt) ? headers[MessagingHeaders.Attempt] : undefined
  if (value === undefined) return 1
  const attempt = Number(value)
  return Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1
}
