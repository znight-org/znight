/**
 * Constants shared by the compiler extension modules. This module must stay free of runtime imports:
 * the extension entry is loaded by the compiler, which must never load the messaging runtime (spec §2).
 */
import type { ErrorCode } from '@znight/core'

/** Name of the extension, also the key of `metadata.extensions.messaging`. */
export const EXTENSION_NAME = 'messaging'

/** Module the generated code imports its helpers and types from. */
export const RUNTIME_MODULE = '@znight/messaging'

/** Canonical identities of the decorators owned by the extension. */
export const MessagingDecorator: {
  readonly Consumer: '@znight/messaging#Consumer'
  readonly OnMessage: '@znight/messaging#OnMessage'
  readonly Retry: '@znight/messaging#Retry'
  readonly OnError: '@znight/messaging#OnError'
  readonly Message: '@znight/messaging#Message'
  readonly Headers: '@znight/messaging#Headers'
  readonly Ctx: '@znight/messaging#Ctx'
} = Object.freeze({
  Consumer: '@znight/messaging#Consumer',
  OnMessage: '@znight/messaging#OnMessage',
  Retry: '@znight/messaging#Retry',
  OnError: '@znight/messaging#OnError',
  Message: '@znight/messaging#Message',
  Headers: '@znight/messaging#Headers',
  Ctx: '@znight/messaging#Ctx',
})

/** Identity of the `InboundMessage` interface (`@Ctx()` parameters). */
export const INBOUND_MESSAGE_IDENTITY = '@znight/messaging#InboundMessage'

/** Decorators applied to methods. */
export const METHOD_DECORATORS: ReadonlySet<string> = new Set([
  MessagingDecorator.OnMessage,
  MessagingDecorator.Retry,
  MessagingDecorator.OnError,
])

/** Decorators applied to handler parameters. */
export const PARAMETER_DECORATORS: ReadonlySet<string> = new Set([
  MessagingDecorator.Message,
  MessagingDecorator.Headers,
  MessagingDecorator.Ctx,
])

/** ZNIGHT005: invalid decorator usage (target, arguments, several decorators...). */
export const INVALID_DECORATOR: ErrorCode = 'ZNIGHT005'
/** ZNIGHT011: invalid message consumer (no handler, overlapping types, retry options...). */
export const INVALID_CONSUMER: ErrorCode = 'ZNIGHT011'
/** ZNIGHT017: non-primitive `@Message()` payload without schema. */
export const UNVALIDATED_INPUT: ErrorCode = 'ZNIGHT017'

/**
 * Default backoff of `@Retry` (must equal the runtime `DEFAULT_BACKOFF`; checked by the tests, the
 * runtime module cannot be imported here).
 */
export const DEFAULT_BACKOFF = 'exponential'
/** Default base delay of `@Retry`, in milliseconds (the runtime `DEFAULT_RETRY_DELAY_MS`). */
export const DEFAULT_RETRY_DELAY_MS = 1000
/** Largest `attempts` accepted by the runtime (`normalizeRetry`). */
export const MAX_RETRY_ATTEMPTS = 10_000

/** Scopes a consumer provider may have. */
export const CONSUMER_SCOPES: readonly string[] = ['singleton', 'request', 'transient']

/** Deterministic string comparison (never `localeCompare`). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
