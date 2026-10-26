/**
 * Preparation and validation of the consumers declared in the metadata (boot time, ZNIGHT011).
 */
import type { Container, Token } from '@znight/core'
import type { MessagingDriver } from './driver.ts'
import type { ConsumerDefinition, MessageHandlerDefinition, MessagingMetadata } from './metadata.ts'
import type { RetryOptions, RetryPolicy } from './retry.ts'

import { displayName } from '@znight/core'

import { consumerError } from './errors.ts'
import { isPositiveInteger } from './internal/async.ts'
import {
  assertRetrySupported,
  DEFAULT_RETRY_POLICY,
  isInProcessDelay,
  NO_RETRY_POLICY,
  normalizeRetry,
  retryDelays,
} from './retry.ts'

/** A handler ready to be dispatched to. */
export interface PreparedHandler {
  readonly definition: MessageHandlerDefinition
  readonly method: string
  readonly policy: RetryPolicy
}

/** A validated consumer. */
export interface PreparedConsumer {
  readonly definition: ConsumerDefinition
  readonly token: Token
  /** Display name of the consumer class. */
  readonly name: string
  readonly queue: string
  readonly concurrency: number
  readonly deadLetterQueue: string | undefined
  readonly errorHandler: string | undefined
  readonly maxAttempts: number
  /** Native delays the runtime may request (sorted, unique). */
  readonly retryDelays: readonly number[]
  readonly driverOptions: Readonly<Record<string, unknown>>
  /** Selects the handler of a message type (exact, then patterns, then the default handler). */
  select(type: string | undefined): PreparedHandler | undefined
}

/** Plugin-level defaults applied to every consumer. */
export interface ConsumerDefaults {
  readonly retry: RetryPolicy
  readonly concurrency: number
  readonly deadLetter: ((queue: string) => string) | false | undefined
}

/** Normalizes `defaults.retry` of the plugin. */
export function defaultRetryPolicy(retry: RetryOptions | false | undefined): RetryPolicy {
  if (retry === undefined) return DEFAULT_RETRY_POLICY
  if (retry === false) return NO_RETRY_POLICY
  return normalizeRetry(retry, 'MessagingPlugin defaults.retry')
}

/**
 * Validates `metadata.extensions.messaging` against the container and the driver capabilities.
 *
 * @throws ZnightError ZNIGHT011 describing the first invalid consumer.
 */
export function prepareConsumers(
  metadata: MessagingMetadata | undefined,
  container: Container,
  driver: MessagingDriver,
  defaults: ConsumerDefaults,
): PreparedConsumer[] {
  if (metadata === undefined) return []
  if (metadata === null || typeof metadata !== 'object' || !Array.isArray(metadata.consumers)) {
    throw consumerError('Invalid messaging metadata: "consumers" must be an array', [
      'Regenerate the metadata with the @znight/messaging compiler extension',
    ])
  }
  const byQueue = new Map<string, string>()
  const prepared: PreparedConsumer[] = []
  for (const definition of metadata.consumers) {
    const consumer = prepareConsumer(definition, container, driver, defaults)
    const previous = byQueue.get(consumer.queue)
    if (previous !== undefined) {
      throw consumerError(`${previous} and ${consumer.name} both consume "${consumer.queue}"`, [
        'A queue is consumed by a single @Consumer class: merge the handlers, or route by type with @OnMessage(type)',
      ])
    }
    byQueue.set(consumer.queue, consumer.name)
    prepared.push(consumer)
  }
  return prepared
}

function prepareConsumer(
  definition: ConsumerDefinition,
  container: Container,
  driver: MessagingDriver,
  defaults: ConsumerDefaults,
): PreparedConsumer {
  if (
    definition === null ||
    typeof definition !== 'object' ||
    typeof definition.token !== 'string' ||
    definition.token === ''
  ) {
    throw consumerError('Invalid consumer definition: missing provider token')
  }
  const token = definition.token
  const name = displayName(token)
  if (typeof definition.queue !== 'string' || definition.queue === '') {
    throw consumerError(`@Consumer ${name}: the queue must be a non-empty string`)
  }
  if (!container.has(token)) {
    throw consumerError(`@Consumer ${name}: no provider is registered for ${token}`, [
      'Regenerate the metadata: the consumer class must be a compiled provider',
    ])
  }
  const options = definition.options ?? {}
  const { concurrency: rawConcurrency, deadLetter, ...driverOptions } = options
  const concurrency = rawConcurrency ?? defaults.concurrency
  if (!isPositiveInteger(concurrency)) {
    throw consumerError(`@Consumer ${name}: "concurrency" must be a positive integer, got ${String(concurrency)}`)
  }
  if (deadLetter !== undefined && deadLetter !== false && (typeof deadLetter !== 'string' || deadLetter === '')) {
    throw consumerError(`@Consumer ${name}: "deadLetter" must be a queue name or false, got ${String(deadLetter)}`)
  }
  if (deadLetter === definition.queue) {
    throw consumerError(`@Consumer ${name}: the dead-letter queue cannot be the consumed queue "${definition.queue}"`)
  }

  const handlers = definition.handlers
  if (!Array.isArray(handlers) || handlers.length === 0) {
    throw consumerError(`@Consumer ${name} has no @OnMessage handler`, [
      'Decorate at least one method with @OnMessage()',
    ])
  }
  const exact = new Map<string, PreparedHandler>()
  const patterns: { readonly regex: RegExp; readonly handler: PreparedHandler }[] = []
  let fallback: PreparedHandler | undefined
  let maxAttempts = 1
  const nativeDelays = new Set<number>()
  for (const handlerDefinition of handlers) {
    const handler = prepareHandler(handlerDefinition, name, driver, defaults.retry)
    maxAttempts = Math.max(maxAttempts, handler.policy.attempts)
    for (const delay of retryDelays(handler.policy)) {
      if (!isInProcessDelay(delay, driver.capabilities)) nativeDelays.add(delay)
    }
    const type = handlerDefinition.type
    if (type === undefined) {
      if (fallback !== undefined) {
        throw consumerError(
          `@Consumer ${name}: ${fallback.method}() and ${handler.method}() are both default @OnMessage() handlers`,
          ['Give one of them a message type: @OnMessage("order.created")'],
        )
      }
      fallback = handler
    } else if (type.includes('*')) {
      if (patterns.some(entry => entry.handler.definition.type === type)) {
        throw duplicateType(name, type)
      }
      patterns.push({ regex: patternToRegExp(type), handler })
    } else {
      if (exact.has(type)) throw duplicateType(name, type)
      exact.set(type, handler)
    }
  }

  const errorHandler = definition.errorHandler
  if (errorHandler !== undefined) {
    if (typeof errorHandler !== 'string' || errorHandler === '') {
      throw consumerError(`@Consumer ${name}: invalid @OnError method name ${String(errorHandler)}`)
    }
    const providers = container.metadata.providers
    const provider = Object.hasOwn(providers, token) ? providers[token] : undefined
    const prototype = provider?.class?.prototype as Record<string, unknown> | undefined
    if (prototype !== undefined && typeof prototype[errorHandler] !== 'function') {
      throw consumerError(`@Consumer ${name}: the @OnError method ${errorHandler}() does not exist`)
    }
  }

  return {
    definition,
    token,
    name,
    queue: definition.queue,
    concurrency,
    deadLetterQueue: resolveDeadLetter(definition.queue, deadLetter, defaults.deadLetter, driver),
    errorHandler,
    maxAttempts,
    retryDelays: [...nativeDelays].sort((a, b) => a - b),
    driverOptions,
    select(type: string | undefined): PreparedHandler | undefined {
      if (type === undefined) return fallback
      const handler = exact.get(type)
      if (handler !== undefined) return handler
      for (const entry of patterns) if (entry.regex.test(type)) return entry.handler
      return fallback
    },
  }
}

function prepareHandler(
  definition: MessageHandlerDefinition,
  consumer: string,
  driver: MessagingDriver,
  defaultPolicy: RetryPolicy,
): PreparedHandler {
  if (
    definition === null ||
    typeof definition !== 'object' ||
    typeof definition.method !== 'string' ||
    definition.method === ''
  ) {
    throw consumerError(`@Consumer ${consumer}: invalid @OnMessage handler definition`)
  }
  const where = `${consumer}.${definition.method}()`
  if (typeof definition.invoke !== 'function') {
    throw consumerError(`${where}: the handler has no invoker`, ['Regenerate the metadata'])
  }
  if (definition.type !== undefined && (typeof definition.type !== 'string' || definition.type === '')) {
    throw consumerError(`${where}: the @OnMessage type must be a non-empty string`)
  }
  const policy = definition.retry === undefined ? defaultPolicy : normalizeRetry(definition.retry, `@Retry on ${where}`)
  assertRetrySupported(
    policy,
    driver.capabilities,
    driver.name,
    definition.retry === undefined ? `${where} (default retry policy)` : `@Retry on ${where}`,
  )
  return { definition, method: definition.method, policy }
}

function duplicateType(consumer: string, type: string): Error {
  return consumerError(`@Consumer ${consumer}: several @OnMessage handlers for type "${type}"`)
}

/** `order.*` → `/^order\..*$/`: `*` matches any sequence of characters. */
function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 's')
}

function resolveDeadLetter(
  queue: string,
  option: string | false | undefined,
  defaults: ((queue: string) => string) | false | undefined,
  driver: MessagingDriver,
): string | undefined {
  if (option === false) return undefined
  if (typeof option === 'string') return option
  if (defaults === false) return undefined
  const name = defaults === undefined ? driver.deadLetterName(queue) : defaults(queue)
  if (typeof name !== 'string' || name === '' || name === queue) {
    throw consumerError(`Invalid dead-letter queue name for "${queue}": ${String(name)}`)
  }
  return name
}
