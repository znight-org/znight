import type { CoreLogger } from '@znight/core'
import type { DeadLetterReason, OutboundMessage } from './message.ts'

/**
 * What a driver can do. `MessagingPlugin` validates every `@Retry` policy against it at boot: a
 * delay is either waited in-process (`<= maxInProcessDelayMs`) or delegated to the broker
 * (`nativeDelay`, `<= maxNativeDelayMs`); otherwise the application fails to start (ZNIGHT011).
 */
export interface DriverCapabilities {
  /** The broker can redeliver a message after a delay (SQS visibility, RabbitMQ TTL queue, Kafka retry topic). */
  readonly nativeDelay: boolean
  /** Longest native redelivery delay, in milliseconds (`0` without native delay). */
  readonly maxNativeDelayMs: number
  /**
   * Longest delay the runtime may wait in-process while holding a delivery before asking the
   * broker to redeliver it (the message stays locked: prefetch slot, SQS lease...).
   */
  readonly maxInProcessDelayMs: number
  /**
   * How attempts are counted: `native` (broker delivery count: SQS `ApproximateReceiveCount`,
   * RabbitMQ quorum `x-delivery-count`) or `header` (`x-znight-attempt` on republished retries).
   */
  readonly deliveryCount: 'native' | 'header'
  /** Longest `publish(..., { delay })`, in milliseconds (`0`: delayed publishing unsupported). */
  readonly maxPublishDelayMs: number
}

/** Services a driver receives when it connects. */
export interface DriverContext {
  /** Logger for background failures (polling errors, connection loss...). */
  readonly logger: CoreLogger
}

/** Redelivery request of a failed delivery. */
export interface RetryRequest {
  /** Attempt number of the redelivery (failed attempt + 1). */
  readonly attempt: number
  /** Delay before the redelivery, in milliseconds (`0`: as soon as possible). */
  readonly delayMs: number
  /** Error of the failed attempt. */
  readonly error: unknown
}

/** Dead-letter request of a delivery. */
export interface DeadLetterRequest {
  /**
   * Destination queue/topic, `undefined` when dead-lettering is disabled for the consumer: the driver
   * then rejects the message natively (RabbitMQ `nack` without requeue, so a queue DLX applies) or
   * discards it.
   */
  readonly queue: string | undefined
  readonly reason: DeadLetterReason
  readonly error: unknown
  /** Attempts made. */
  readonly attempt: number
}

/**
 * A message received by a driver, with the operations settling it. The runtime calls exactly one
 * settlement operation (`ack`, `retry`, `deadLetter` or `release`), possibly followed by `release`
 * when the first one failed. Each operation resolves once the broker acknowledged it.
 */
export interface DriverDelivery {
  readonly id: string
  readonly body: Uint8Array | string
  readonly contentType: string | undefined
  /** Headers as strings (non-string values converted). */
  readonly headers: Readonly<Record<string, string>>
  readonly type: string | undefined
  readonly key: string | undefined
  /** 1-based attempt of this delivery. */
  readonly attempt: number
  readonly redelivered: boolean
  /** Production time (epoch ms), when known. */
  readonly timestamp: number | undefined
  /** Driver-native message. */
  readonly raw: unknown
  /** The message was handled: remove it from the queue / commit it. */
  ack(): Promise<void>
  /**
   * Redeliver the message as attempt `request.attempt` after `request.delayMs`. The redelivery must be
   * durable (confirmed) before the original is acknowledged.
   */
  retry(request: RetryRequest): Promise<void>
  /** Move the message to the dead-letter destination (publish with confirmation, then acknowledge). */
  deadLetter(request: DeadLetterRequest): Promise<void>
  /**
   * Give the message back to the broker for a later redelivery without settling it (shutdown,
   * failed dead-lettering). Must never lose the message.
   */
  release(): Promise<void>
}

/**
 * Handles one delivery. The returned promise settles once the delivery was settled: drivers use it
 * for back-pressure (never more than `concurrency` pending promises per subscription).
 */
export type DeliveryHandler = (delivery: DriverDelivery) => Promise<void>

/** Options of {@link MessagingDriver.subscribe}. */
export interface SubscribeOptions {
  /** Display name of the consumer class (logs, errors). */
  readonly consumer: string
  /** Maximum number of deliveries handled concurrently (prefetch, receive batch size...). */
  readonly concurrency: number
  /** Dead-letter destination, `undefined` when disabled. Drivers verify it exists at subscribe time. */
  readonly deadLetterQueue: string | undefined
  /** Largest number of attempts among the consumer's handlers (e.g. checked against SQS `maxReceiveCount`). */
  readonly maxAttempts: number
  /** Native retry delays (ms) the runtime may request: lets drivers prepare delay queues. Sorted, unique. */
  readonly retryDelays: readonly number[]
  /** Driver-specific options of `@Consumer({ queue, ...options })`. */
  readonly options: Readonly<Record<string, unknown>>
}

/** An active subscription. */
export interface Subscription {
  /** Stops receiving new deliveries. Deliveries already handed to the runtime can still be settled. */
  cancel(): Promise<void>
  /** Releases the subscription's resources, once in-flight deliveries settled. Idempotent. */
  close(): Promise<void>
}

/**
 * A broker integration. Drivers live in subpath exports (`@znight/messaging/rabbitmq`, `/sqs`,
 * `/kafka`, `/memory`) so their client libraries stay optional peers.
 */
export interface MessagingDriver {
  /** Short name (`rabbitmq`, `sqs`, `kafka`, `memory`), exposed as `InboundMessage.driver`. */
  readonly name: string
  readonly capabilities: DriverCapabilities
  /** Connects to the broker (called in `onBootstrap`). */
  connect(context: DriverContext): Promise<void>
  /** Starts consuming `queue`. Verifies the destination and its dead-letter configuration. */
  subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription>
  /** Publishes a message; resolves once the broker confirmed it. */
  publish(queue: string, message: OutboundMessage): Promise<void>
  /** Closes every subscription and the connection. Idempotent. */
  close(): Promise<void>
  /** Default dead-letter destination of `queue` (`orders.dlq`, `orders-dlq`...). */
  deadLetterName(queue: string): string
}
