/**
 * Marker decorators of `@znight/messaging`. Like every Znight decorator they do nothing at runtime:
 * the compiler extension (`@znight/messaging/compiler`) reads them from the source code and generates
 * `metadata.extensions.messaging`. Arguments marked _static_ must be statically evaluable (literals,
 * `const` references); _value_ arguments (schemas) may also be references to exported bindings.
 */
import type { ClassMarker, MethodMarker, ParameterMarker, Scope } from '@znight/core'
import type { InboundMessage } from './message.ts'
import type { RetryOptions } from './retry.ts'
import type { StandardSchemaV1 } from './standard-schema.ts'

/** Options of {@link Consumer} (static). */
export interface ConsumerOptions {
  /** Queue (RabbitMQ, SQS) or topic (Kafka) to consume. */
  readonly queue: string
  /** Scope of the consumer provider. Default: `singleton`; `request` creates one instance per message. */
  readonly scope?: Scope
  /** Maximum number of messages handled concurrently. Default: plugin `defaults.concurrency` (1). */
  readonly concurrency?: number
  /** Dead-letter queue/topic, or `false` to disable dead-lettering. Default: driver naming (`<queue>.dlq`). */
  readonly deadLetter?: string | false
  /** Driver-specific options (e.g. Kafka `groupId`). */
  readonly [driverOption: string]: unknown
}

/** Result of an `@OnError` method: `'ack'` acknowledges (swallows) the message, anything else dead-letters it. */
// biome-ignore lint/suspicious/noConfusingVoidType: lets error handlers without return statement type-check
export type ErrorHandlerResult = 'ack' | undefined | void

/**
 * Signature of an `@OnError` method. Declared as a method signature so that parameters may be
 * narrowed (`onError(error: Error, message: InboundMessage<Order>)`).
 */
export type ErrorHandlerMethod = ErrorHandlerSignature['onError']

interface ErrorHandlerSignature {
  onError(error: unknown, message: InboundMessage): ErrorHandlerResult | Promise<ErrorHandlerResult>
}

/** Marker usable on an `@OnError` method: checks its signature. */
export type ErrorHandlerMarker = <F extends ErrorHandlerMethod>(
  target: object,
  propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext<unknown, F>,
  descriptor?: TypedPropertyDescriptor<F>,
) => void

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const classMarker: ClassMarker = marker
const methodMarker: MethodMarker = marker
const parameterMarker: ParameterMarker = marker
const errorHandlerMarker: ErrorHandlerMarker = marker

/**
 * Declares a message consumer: a provider (singleton by default) whose `@OnMessage` methods handle
 * the messages of `queue`. Arguments are static.
 *
 * ```ts
 * @Consumer('orders')
 * export class OrderConsumer {
 *   constructor(private readonly orders: OrderService) {}
 *
 *   @OnMessage('order.created')
 *   @Retry({ attempts: 5, backoff: 'exponential', delay: 500 })
 *   async created(@Message(OrderCreated) event: OrderCreated) {
 *     await this.orders.process(event)
 *   }
 * }
 * ```
 */
export function Consumer(queue: string): ClassMarker
export function Consumer(options: ConsumerOptions): ClassMarker
export function Consumer(_queueOrOptions: string | ConsumerOptions): ClassMarker {
  return classMarker
}

/**
 * Declares a message handler. With `type` (static), it handles the messages of that type (exact
 * match, or a pattern where `*` matches any sequence: `'order.*'`); without type it is the consumer's
 * default handler (messages without type, or whose type no other handler matches). A message no
 * handler matches is dead-lettered (reason `no-handler`).
 */
export function OnMessage(_type?: string): MethodMarker {
  return methodMarker
}

/**
 * Retry policy of a handler (static options). `attempts` counts the first delivery:
 * `{ attempts: 3 }` means one delivery plus two retries. Without `@Retry`, the plugin's
 * `defaults.retry` applies (3 attempts, exponential from 1 s).
 */
export function Retry(_options: RetryOptions): MethodMarker {
  return methodMarker
}

/**
 * Declares the consumer's error handler, called once a message will not be retried anymore (last
 * attempt failed, `NonRetryableError`, invalid payload, no matching handler). Returning `'ack'`
 * acknowledges the message; returning anything else (or throwing) dead-letters it.
 *
 * ```ts
 * @OnError()
 * onError(error: unknown, message: InboundMessage) {
 *   if (message.type?.startsWith('legacy.')) return 'ack'
 * }
 * ```
 */
export function OnError(): ErrorHandlerMarker {
  return errorHandlerMarker
}

/**
 * Injects the message payload. With a Standard Schema (Zod, Valibot...), the payload is validated and
 * the parameter receives the schema output; an invalid payload is dead-lettered without retry
 * (reason `validation`). The schema is a _value_ argument (inline, or an exported binding).
 */
export function Message(_schema?: StandardSchemaV1): ParameterMarker {
  return parameterMarker
}

/** Injects all the message headers, or the value of one header (`string | undefined`). `name` is static. */
export function Headers(_name?: string): ParameterMarker {
  return parameterMarker
}

/** Injects the {@link InboundMessage} (id, type, attempt, headers, raw message, abort signal...). */
export function Ctx(): ParameterMarker {
  return parameterMarker
}
