/**
 * A message being handled by a consumer. It is the value of the request-scoped external
 * `@znight/messaging#InboundMessage` during a delivery (inject it into request-scoped providers, or
 * receive it with `@Ctx()`).
 *
 * Delivery is **at-least-once**: the same message may be handled more than once (redelivery after a
 * crash, a lost ack, a retry...). Handlers must be idempotent; {@link id} is stable across
 * redeliveries when the producer set it (Znight producers always do).
 */
export interface InboundMessage<T = unknown> {
  /** Message id: set by the producer (`MessageBroker.publish` generates a UUID), stable across redeliveries. */
  readonly id: string
  /** Queue (RabbitMQ, SQS) or topic (Kafka) the consumer subscribed to. */
  readonly queue: string
  /** Message type used to select the `@OnMessage(type)` handler, `undefined` when the producer set none. */
  readonly type: string | undefined
  /** Decoded payload (the schema output when the handler declares `@Message(schema)`). */
  readonly payload: T
  /** Message headers. Names are case-sensitive; non-string values are converted to strings. */
  readonly headers: Readonly<Record<string, string>>
  /** Partition / ordering key (Kafka record key, SQS FIFO message group), when any. */
  readonly key: string | undefined
  /** 1-based delivery attempt (broker delivery count or `x-znight-attempt` header). */
  readonly attempt: number
  /** Attempts allowed by the retry policy of the selected handler (`1` without retries). */
  readonly maxAttempts: number
  /** Whether the broker flagged the delivery as a redelivery. */
  readonly redelivered: boolean
  /** When the message was produced (epoch milliseconds), when the broker reports it. */
  readonly timestamp: number | undefined
  /** When this delivery was received (epoch milliseconds). */
  readonly receivedAt: number
  /** Content type of the body. */
  readonly contentType: string | undefined
  /** Encoded body, as received. */
  readonly body: Uint8Array | string
  /** Name of the driver that received the message (`rabbitmq`, `sqs`, `kafka`, `memory`). */
  readonly driver: string
  /** Driver-native message (amqplib `ConsumeMessage`, SQS `Message`, Kafka `Message`...). */
  readonly raw: unknown
  /** Aborted when the consumer stops: long-running handlers can use it to stop early. */
  readonly signal: AbortSignal
}

/** Options of `MessageBroker.publish()`. */
export interface PublishOptions {
  /** Message type, used by consumers to select the `@OnMessage(type)` handler. */
  readonly type?: string
  /** Additional headers (string values). */
  readonly headers?: Readonly<Record<string, string>>
  /** Partition key (Kafka) or message group id (SQS FIFO queues). */
  readonly key?: string
  /** Delays the delivery by this many milliseconds (support and maximum depend on the driver). */
  readonly delay?: number
  /** Message id. Default: a random UUID. Set it to make publishing idempotent end-to-end. */
  readonly id?: string
  /** Content type, when the payload is already encoded (`Uint8Array` or `string`). */
  readonly contentType?: string
}

/** Result of `MessageBroker.publish()`. */
export interface PublishResult {
  /** Id of the published message. */
  readonly id: string
}

/**
 * A message handed to a driver for publication: the payload is already encoded by the codec. The
 * driver resolves `publish()` only once the broker confirmed the message (publisher confirms, SQS
 * response, Kafka acks).
 */
export interface OutboundMessage {
  readonly id: string
  readonly type: string | undefined
  readonly key: string | undefined
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array | string
  readonly contentType: string
  /** Production time, epoch milliseconds. */
  readonly timestamp: number
  /** Requested delivery delay in milliseconds (`0`: immediate). */
  readonly delayMs: number
}

/** Why a message was moved to the dead-letter queue (`x-znight-dead-letter-reason` header). */
export type DeadLetterReason =
  /** No `@OnMessage` handler matches the message type. */
  | 'no-handler'
  /** The body could not be decoded (malformed JSON...). */
  | 'decode'
  /** The `@Message(schema)` validation failed. */
  | 'validation'
  /** The handler threw a `NonRetryableError`. */
  | 'non-retryable'
  /** The last attempt allowed by the retry policy failed. */
  | 'max-attempts'
