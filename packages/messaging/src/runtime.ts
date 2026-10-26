/**
 * The delivery state machine (docs/internals/architecture.md §9.2), one {@link ConsumerRuntime} per
 * `@Consumer` class.
 *
 * For each delivery: concurrency slot → request scope seeded with the `InboundMessage` →
 * `hooks.run('messaging:message')` → decode → select the handler by type → invoke →
 * ack | retry (in-process wait or native redelivery) | `@OnError` → dead-letter (publish then ack;
 * on failure the message is released for a later redelivery). Nothing is ever dropped: every path
 * ends with the broker owning the message again.
 */
import type { Container, CoreLogger, Hooks, MessageDeliveryEvent } from '@znight/core'
import type { MessageCodec } from './codec.ts'
import type { PreparedConsumer, PreparedHandler } from './consumers.ts'
import type { DriverDelivery, MessagingDriver, Subscription } from './driver.ts'
import type { DeadLetterReason, InboundMessage } from './message.ts'

import {
  AttemptsExhaustedError,
  isNonRetryable,
  MessageDecodeError,
  MessageValidationError,
  NoHandlerError,
} from './errors.ts'
import { errorMessage, Semaphore, sleep } from './internal/async.ts'
import { computeRetryDelay, isInProcessDelay } from './retry.ts'
import { MessagingTokens } from './tokens.ts'

/** Services shared by every consumer runtime. */
export interface RuntimeServices {
  readonly container: Container
  readonly hooks: Hooks
  readonly logger: CoreLogger
  readonly codec: MessageCodec
  readonly driver: MessagingDriver
  /** Pause before releasing a message whose settlement failed (avoids hot redelivery loops). */
  readonly requeueDelayMs: number
}

/** State of a {@link ConsumerRuntime}. */
export type ConsumerState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped'

/** What remains to do once the scope of a delivery closed. */
type Followup =
  | { readonly kind: 'retry'; readonly delayMs: number; readonly error: unknown }
  | { readonly kind: 'requeue' }
  | undefined

/** Per-delivery working state. */
interface DeliveryContext {
  readonly delivery: DriverDelivery
  readonly message: InboundMessage
  readonly handler: PreparedHandler | undefined
  readonly event: MessageDeliveryEvent
  readonly decodeError: unknown
  executed: boolean
  followup: Followup
}

/** Runs the deliveries of one consumer. */
export class ConsumerRuntime {
  readonly consumer: PreparedConsumer
  readonly #services: RuntimeServices
  readonly #slots: Semaphore
  readonly #abort = new AbortController()
  readonly #inflight = new Set<Promise<void>>()
  #subscription: Subscription | undefined
  #state: ConsumerState = 'created'

  constructor(consumer: PreparedConsumer, services: RuntimeServices) {
    this.consumer = consumer
    this.#services = services
    this.#slots = new Semaphore(consumer.concurrency)
  }

  get state(): ConsumerState {
    return this.#state
  }

  /** Deliveries currently handled (including those waiting for a slot or an in-process retry delay). */
  get inFlight(): number {
    return this.#inflight.size
  }

  /** Subscribes to the queue. */
  async start(): Promise<void> {
    if (this.#state !== 'created') throw new Error(`[znight] Consumer ${this.consumer.name} was already started`)
    this.#state = 'starting'
    const { consumer } = this
    try {
      this.#subscription = await this.#services.driver.subscribe(consumer.queue, delivery => this.handle(delivery), {
        consumer: consumer.name,
        concurrency: consumer.concurrency,
        deadLetterQueue: consumer.deadLetterQueue,
        maxAttempts: consumer.maxAttempts,
        retryDelays: consumer.retryDelays,
        options: consumer.driverOptions,
      })
    } catch (error) {
      this.#state = 'stopped'
      throw error
    }
    this.#state = 'running'
  }

  /**
   * Graceful stop: stops receiving, aborts in-process retry delays (those messages are released to
   * the broker), awaits the in-flight handlers, then closes the subscription. Never throws.
   */
  async stop(): Promise<void> {
    if (this.#state === 'stopping' || this.#state === 'stopped') return
    this.#state = 'stopping'
    this.#abort.abort()
    const subscription = this.#subscription
    if (subscription !== undefined) {
      try {
        await subscription.cancel()
      } catch (error) {
        this.#services.logger.error(`Consumer ${this.consumer.name}: failed to cancel the subscription`, { err: error })
      }
    }
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight])
    if (subscription !== undefined) {
      try {
        await subscription.close()
      } catch (error) {
        this.#services.logger.error(`Consumer ${this.consumer.name}: failed to close the subscription`, { err: error })
      }
    }
    this.#state = 'stopped'
  }

  /** Handles one delivery (the driver's `DeliveryHandler`). Never rejects. */
  handle(delivery: DriverDelivery): Promise<void> {
    const promise = this.#handle(delivery)
    this.#inflight.add(promise)
    const done = (): void => {
      this.#inflight.delete(promise)
    }
    promise.then(done, done)
    return promise
  }

  async #handle(delivery: DriverDelivery): Promise<void> {
    const signal = this.#abort.signal
    if (signal.aborted) return this.#release(delivery)
    try {
      await this.#slots.acquire(signal)
    } catch {
      return this.#release(delivery)
    }
    try {
      await this.#process(delivery)
    } catch (error) {
      // defensive: #process handles its failures; never leave a message unsettled
      this.#services.logger.error(`Consumer ${this.consumer.name}: unexpected delivery failure`, { err: error })
      await this.#release(delivery)
    } finally {
      this.#slots.release()
    }
  }

  async #process(delivery: DriverDelivery): Promise<void> {
    const { container, hooks, codec, driver } = this.#services
    const { consumer } = this
    const handler = consumer.select(delivery.type)
    let payload: unknown
    let decodeError: unknown
    try {
      payload = codec.decode(delivery.body, delivery.contentType)
    } catch (error) {
      decodeError = isNonRetryable(error)
        ? error
        : new MessageDecodeError(`Cannot decode the message body: ${errorMessage(error)}`, { cause: error })
    }
    const message: InboundMessage = {
      id: delivery.id,
      queue: consumer.queue,
      type: delivery.type,
      payload,
      headers: delivery.headers,
      key: delivery.key,
      attempt: delivery.attempt,
      maxAttempts: handler?.policy.attempts ?? 1,
      redelivered: delivery.redelivered,
      timestamp: delivery.timestamp,
      receivedAt: Date.now(),
      contentType: delivery.contentType,
      body: delivery.body,
      driver: driver.name,
      raw: delivery.raw,
      signal: this.#abort.signal,
    }
    const event: MessageDeliveryEvent = {
      queue: consumer.queue,
      type: delivery.type,
      messageId: delivery.id,
      attempt: delivery.attempt,
      headers: delivery.headers,
      consumer: consumer.name,
      handler: handler?.method,
      message,
      startTime: performance.now(),
    }
    const context: DeliveryContext = {
      delivery,
      message,
      handler,
      event,
      decodeError,
      executed: false,
      followup: undefined,
    }

    let failure: unknown = new Error('A messaging:message hook wrapper did not call next()')
    try {
      await container.runInScope(
        () => hooks.run('messaging:message', event, () => this.#execute(context)),
        [[MessagingTokens.InboundMessage, message]],
      )
    } catch (error) {
      failure = error
      if (context.executed) {
        // the delivery was settled: a wrapper failed afterwards, or a request-scoped instance failed to dispose
        this.#services.logger.error(`Consumer ${consumer.name}: error after handling message ${delivery.id}`, {
          err: error,
          queue: consumer.queue,
        })
      }
    }
    // the handler never ran (a hooks wrapper threw or did not call next()): count it as a failed attempt
    if (!context.executed) await this.#failure(context, failure, false)
    if (hooks.hasListeners('messaging:message')) hooks.emit('messaging:message', event)
    await this.#followup(context)
  }

  /** Runs inside the request scope and the hooks: handler, then settlement. Never throws. */
  async #execute(context: DeliveryContext): Promise<void> {
    if (context.executed) return // a wrapper called next() twice
    context.executed = true
    const { handler, message } = context
    if (context.decodeError !== undefined) return this.#failure(context, context.decodeError, true)
    if (handler === undefined)
      return this.#terminal(context, new NoHandlerError(this.consumer.name, message.type), 'no-handler', true)
    if (message.attempt > message.maxAttempts) {
      return this.#terminal(
        context,
        new AttemptsExhaustedError(message.attempt, message.maxAttempts),
        'max-attempts',
        false,
      )
    }
    try {
      const instance = this.#services.container.get(this.consumer.token)
      await handler.definition.invoke(instance, message)
    } catch (error) {
      return this.#failure(context, error, true)
    }
    return this.#ack(context)
  }

  /** A failed attempt: retry while attempts remain, dead-letter otherwise. */
  #failure(context: DeliveryContext, error: unknown, withErrorHandler: boolean): Promise<void> {
    if (isNonRetryable(error)) return this.#terminal(context, error, reasonOf(error), withErrorHandler)
    if (context.message.attempt < context.message.maxAttempts) return this.#retry(context, error)
    return this.#terminal(context, error, 'max-attempts', withErrorHandler)
  }

  async #retry(context: DeliveryContext, error: unknown): Promise<void> {
    const { message, delivery, event } = context
    const policy = context.handler?.policy
    const delayMs = policy === undefined ? 0 : computeRetryDelay(policy, message.attempt)
    event.outcome = 'retry'
    event.error = error
    this.#services.logger.warn(
      `Consumer ${this.consumer.name}: attempt ${message.attempt}/${message.maxAttempts} of message ${message.id} failed, retrying in ${delayMs} ms`,
      { queue: message.queue, messageId: message.id, type: message.type, err: error },
    )
    if (isInProcessDelay(delayMs, this.#services.driver.capabilities)) {
      context.followup = { kind: 'retry', delayMs, error }
      return
    }
    try {
      await delivery.retry({ attempt: message.attempt + 1, delayMs, error })
    } catch (retryError) {
      this.#services.logger.error(
        `Consumer ${this.consumer.name}: failed to schedule the retry of message ${message.id}`,
        {
          err: retryError,
          queue: message.queue,
        },
      )
      context.followup = { kind: 'requeue' }
    }
  }

  /** No more attempts: `@OnError` may acknowledge, otherwise the message is dead-lettered. */
  async #terminal(
    context: DeliveryContext,
    error: unknown,
    reason: DeadLetterReason,
    withErrorHandler: boolean,
  ): Promise<void> {
    context.event.error = error
    const method = this.consumer.errorHandler
    if (withErrorHandler && method !== undefined) {
      try {
        const instance = this.#services.container.get(this.consumer.token) as Record<
          string,
          (...args: unknown[]) => unknown
        >
        const result = await instance[method]?.(error, context.message)
        if (result === 'ack') return this.#ack(context)
      } catch (handlerError) {
        this.#services.logger.error(`Consumer ${this.consumer.name}: @OnError ${method}() failed`, {
          err: handlerError,
          queue: context.message.queue,
          messageId: context.message.id,
        })
      }
    }
    return this.#deadLetter(context, error, reason)
  }

  async #deadLetter(context: DeliveryContext, error: unknown, reason: DeadLetterReason): Promise<void> {
    const { message, delivery, event } = context
    const queue = this.consumer.deadLetterQueue
    event.outcome = 'dead-letter'
    try {
      await delivery.deadLetter({ queue, reason, error, attempt: message.attempt })
    } catch (deadLetterError) {
      event.outcome = 'retry'
      event.error = deadLetterError
      this.#services.logger.error(
        `Consumer ${this.consumer.name}: failed to dead-letter message ${message.id}, it will be redelivered`,
        { err: deadLetterError, cause: error, queue: message.queue, deadLetterQueue: queue },
      )
      context.followup = { kind: 'requeue' }
      return
    }
    this.#services.logger.error(
      queue === undefined
        ? `Consumer ${this.consumer.name}: message ${message.id} rejected (${reason})`
        : `Consumer ${this.consumer.name}: message ${message.id} dead-lettered to ${queue} (${reason})`,
      { err: error, queue: message.queue, messageId: message.id, type: message.type, attempt: message.attempt, reason },
    )
  }

  async #ack(context: DeliveryContext): Promise<void> {
    context.event.outcome = 'ack'
    try {
      await context.delivery.ack()
    } catch (error) {
      this.#services.logger.warn(
        `Consumer ${this.consumer.name}: failed to acknowledge message ${context.message.id}, the broker will redeliver it`,
        { err: error, queue: context.message.queue },
      )
    }
  }

  /** Work done after the scope closed: in-process retry delays and requeues. */
  async #followup(context: DeliveryContext): Promise<void> {
    const followup = context.followup
    if (followup === undefined) return
    const { delivery, message } = context
    if (followup.kind === 'retry') {
      try {
        await sleep(followup.delayMs, this.#abort.signal)
      } catch {
        return this.#release(delivery) // stopping: the broker redelivers it later
      }
      try {
        await delivery.retry({ attempt: message.attempt + 1, delayMs: 0, error: followup.error })
        return
      } catch (error) {
        this.#services.logger.error(`Consumer ${this.consumer.name}: failed to redeliver message ${message.id}`, {
          err: error,
          queue: message.queue,
        })
      }
    }
    try {
      await sleep(this.#services.requeueDelayMs, this.#abort.signal)
    } catch {
      // stopping: release right away
    }
    return this.#release(delivery)
  }

  async #release(delivery: DriverDelivery): Promise<void> {
    try {
      await delivery.release()
    } catch (error) {
      this.#services.logger.error(
        `Consumer ${this.consumer.name}: failed to release message ${delivery.id}, the broker will redeliver it`,
        { err: error, queue: this.consumer.queue },
      )
    }
  }
}

function reasonOf(error: unknown): DeadLetterReason {
  if (error instanceof MessageValidationError) return 'validation'
  if (error instanceof MessageDecodeError) return 'decode'
  if (error instanceof NoHandlerError) return 'no-handler'
  if (error instanceof AttemptsExhaustedError) return 'max-attempts'
  return 'non-retryable'
}
