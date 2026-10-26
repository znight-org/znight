/**
 * Data stored by the extension during analysis (`ctx.store()`), read back by `validate` and
 * `generate`. Plain data only (plus the `ValueRef`s of schemas), in source order.
 */
import type { Location, StaticValue, ValueRef } from '@znight/compiler'
import type { Token } from '@znight/core'

/** A normalized `@Retry` policy (`MessageHandlerDefinition.retry`). */
export interface RetryPolicyData {
  readonly attempts: number
  readonly backoff: 'fixed' | 'exponential'
  readonly delay: number
  readonly maxDelay?: number
}

/** How the invoker computes one argument of a handler. */
export type HandlerParamData =
  /** `@Message()`: `m.payload as never`. */
  | { readonly kind: 'payload' }
  /** `@Message(schema)`: `await validateMessage(schema, m.payload)`. */
  | { readonly kind: 'validated'; readonly schema: ValueRef }
  /** `@Headers()`: `m.headers`. */
  | { readonly kind: 'headers' }
  /** `@Headers(name)`: `messageHeader(m, name)`. */
  | { readonly kind: 'header'; readonly name: string }
  /** `@Ctx()`: `m` (`m as InboundMessage<never>` when the parameter narrows the payload type). */
  | { readonly kind: 'message'; readonly narrow: boolean }
  /** Optional parameter without messaging decorator, or invalid parameter (reported): `undefined`. */
  | { readonly kind: 'undefined' }

/** One `@OnMessage` decorator of a method. */
export interface HandlerData {
  readonly method: string
  /** `@OnMessage(type)`; `undefined` for the default handler. */
  readonly type: string | undefined
  readonly retry: RetryPolicyData | undefined
  readonly params: readonly HandlerParamData[]
  /** Display name of the class declaring the method (messages). */
  readonly declaredBy: string
  /** Location of the `@OnMessage` decorator. */
  readonly location: Location
}

/** A `@Consumer` class. */
export interface ConsumerData {
  readonly kind: 'consumer'
  /** Provider token of the consumer. */
  readonly token: Token
  readonly identity: string
  readonly displayName: string
  /** Empty when the queue is invalid (a diagnostic was reported). */
  readonly queue: string
  /** `@Consumer` options without `queue` and `scope` (`undefined` when empty). */
  readonly options: Readonly<Record<string, StaticValue>> | undefined
  /** Handlers of the class and its analysable base classes, in declaration order (bases first). */
  readonly handlers: readonly HandlerData[]
  readonly errorHandler: string | undefined
  /** Identities of the class and of its analysable base classes (nearest first). */
  readonly chain: readonly string[]
  /** Location of the `@Consumer` decorator. */
  readonly location: Location
}

/** A class carrying messaging member decorators without `@Consumer` (a base class, or a mistake). */
export interface MemberClassData {
  readonly kind: 'members'
  readonly identity: string
  readonly displayName: string
  readonly abstract: boolean
  /** Method decorators (`@OnMessage`, `@OnError`, `@Retry`), in source order. */
  readonly decorators: readonly { readonly name: string; readonly location: Location }[]
}

/** Everything the extension stores. */
export type MessagingData = ConsumerData | MemberClassData
