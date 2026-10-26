/**
 * Messaging section of the generated metadata (`__ZNIGHT_METADATA__.extensions.messaging`), produced
 * by the `@znight/messaging/compiler` extension and consumed by `MessagingPlugin`.
 * See docs/internals/architecture.md §9.2.
 */
import type { Token } from '@znight/core'
import type { InboundMessage } from './message.ts'
import type { RetryPolicy } from './retry.ts'

/** Messaging metadata of the application. */
export interface MessagingMetadata {
  readonly consumers: readonly ConsumerDefinition[]
}

/**
 * Options of a consumer: `concurrency` and `deadLetter` are read by the runtime, every other key is a
 * driver option (e.g. Kafka `groupId`) forwarded to `MessagingDriver.subscribe`.
 */
export interface ConsumerRuntimeOptions {
  /** Maximum number of messages handled concurrently by this consumer. Default: plugin `defaults.concurrency`. */
  readonly concurrency?: number
  /** Dead-letter destination, or `false` to disable dead-lettering. Default: the plugin/driver naming. */
  readonly deadLetter?: string | false
  readonly [driverOption: string]: unknown
}

/** One `@Consumer` class. */
export interface ConsumerDefinition {
  /** Provider token of the consumer class. */
  readonly token: Token
  /** Queue (RabbitMQ, SQS) or topic (Kafka) consumed. */
  readonly queue: string
  /** `@Consumer({ queue, ...options })` without `queue` and `scope`. */
  readonly options?: ConsumerRuntimeOptions
  /** `@OnMessage` methods, in declaration order. */
  readonly handlers: readonly MessageHandlerDefinition[]
  /** Name of the `@OnError` method, if any: `(error, message) => void | 'ack'`. */
  readonly errorHandler?: string
}

/** One `@OnMessage` method. */
export interface MessageHandlerDefinition {
  /** Method name (logs, hook events). */
  readonly method: string
  /**
   * `@OnMessage(type)`: the message type handled (exact match, or a pattern where `*` matches any
   * sequence of characters). Without type, the handler is the consumer's default handler.
   */
  readonly type?: string
  /** `@Retry` policy, normalized. Default: the plugin's `defaults.retry`. */
  readonly retry?: RetryPolicy
  /**
   * Calls the handler: extracts and validates the parameters from the message
   * (`@Message(schema)` → `validateMessage(schema, m.payload)`, `@Headers(name)` →
   * `messageHeader(m, name)`, `@Ctx()` → `m`).
   */
  // biome-ignore lint/suspicious/noExplicitAny: generated invokers receive the concrete consumer class
  readonly invoke: (consumer: any, message: InboundMessage) => unknown
}

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly messaging?: MessagingMetadata
  }
}
