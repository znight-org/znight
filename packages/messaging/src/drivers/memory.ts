/**
 * `@znight/messaging/memory`: an in-process broker for tests and local development. Deterministic
 * (FIFO queues, round-robin between competing subscribers, microtask dispatch, timers only for
 * delays), full featured (delays, native delivery counts, dead-letter queues, competing consumers)
 * and inspectable (published messages, settlements, dead letters, `idle()`, failure injection).
 *
 * ```ts
 * const driver = memory()
 * const app = await Application.create({ metadata, plugins: [MessagingPlugin.configure({ driver })] })
 * await app.start()
 * await app.get(MessageBroker).publish('orders', { id: 1 }, { type: 'order.created' })
 * await driver.idle()
 * expect(driver.settlements('orders')).toMatchObject([{ action: 'ack' }])
 * ```
 */
import type {
  DeadLetterRequest,
  DeliveryHandler,
  DriverCapabilities,
  DriverContext,
  DriverDelivery,
  MessagingDriver,
  RetryRequest,
  SubscribeOptions,
  Subscription,
} from '../driver.ts'
import type { DeadLetterReason, OutboundMessage } from '../message.ts'

import { randomUUID } from 'node:crypto'

import { jsonCodec } from '../codec.ts'
import { brokerUnavailableError } from '../errors.ts'
import { headerRecord } from '../headers.ts'
import { deadLetterHeaders, durationOption } from './shared.ts'

/** Options of {@link memory}. */
export interface MemoryDriverOptions {
  /** Longest retry delay waited in-process. Default: 1000 ms. */
  readonly maxInProcessDelayMs?: number
  /** Whether longer delays are scheduled by the driver (timers). Default: `true`. */
  readonly nativeDelay?: boolean
  /** Longest native delay. Default: unlimited. */
  readonly maxNativeDelayMs?: number
  /** Longest `publish(..., { delay })`. Default: unlimited. */
  readonly maxPublishDelayMs?: number
  /** Dead-letter naming. Default: `${queue}.dlq`. */
  readonly deadLetterName?: (queue: string) => string
}

/** A message stored by the memory broker. */
export interface MemoryMessage {
  readonly queue: string
  readonly id: string
  readonly type: string | undefined
  readonly key: string | undefined
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array | string
  readonly contentType: string | undefined
  readonly timestamp: number
  /** Deliveries made so far (the next delivery is attempt `deliveries + 1`). */
  readonly deliveries: number
  /** The body decoded with the JSON codec (`undefined` when it cannot be decoded). */
  readonly payload: unknown
}

/** A settlement performed by a consumer, in order. */
export interface MemorySettlement {
  readonly queue: string
  readonly id: string
  readonly attempt: number
  readonly action: 'ack' | 'retry' | 'release' | 'dead-letter' | 'reject'
  /** Retry delay requested (native delays only; in-process delays happen before a `retry` with delay 0). */
  readonly delayMs?: number
  readonly reason?: DeadLetterReason
  readonly error?: unknown
}

/** A dead-lettered message. */
export interface MemoryDeadLetter {
  /** Dead-letter queue (`undefined` when dead-lettering was disabled: the message was discarded). */
  readonly queue: string | undefined
  readonly originalQueue: string
  readonly message: MemoryMessage
  readonly reason: DeadLetterReason
  readonly error: unknown
  readonly attempt: number
}

/** A message injected with {@link MemoryDriver.send}, as an external producer would. */
export interface MemorySendOptions {
  /** Payload encoded with the JSON codec (ignored when `body` is given). */
  readonly payload?: unknown
  /** Raw body (e.g. malformed JSON). */
  readonly body?: Uint8Array | string
  readonly contentType?: string
  readonly type?: string
  readonly key?: string
  readonly id?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Deliveries already made (simulates a redelivered message). Default: 0. */
  readonly deliveries?: number
}

/** Operations whose failure can be injected with {@link MemoryDriver.fail}. */
export type MemoryOperation = 'connect' | 'subscribe' | 'publish' | 'ack' | 'retry' | 'dead-letter' | 'release'

/** Options of {@link MemoryDriver.fail}. */
export interface MemoryFailureOptions {
  /** Only for this queue (the destination queue for `publish`, the consumed queue otherwise). */
  readonly queue?: string
  /** Number of failures before the operation works again. Default: unlimited. */
  readonly times?: number
  /** Thrown error. Default: an `Error` naming the operation. */
  readonly error?: unknown
}

interface StoredMessage {
  readonly queue: string
  readonly id: string
  readonly type: string | undefined
  readonly key: string | undefined
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array | string
  readonly contentType: string | undefined
  readonly timestamp: number
  deliveries: number
}

interface Subscriber {
  readonly queue: string
  readonly handler: DeliveryHandler
  readonly concurrency: number
  readonly options: SubscribeOptions
  inflight: number
  active: boolean
}

interface QueueState {
  readonly ready: StoredMessage[]
  readonly subscribers: Subscriber[]
  next: number
  scheduled: boolean
}

interface Failure {
  readonly operation: MemoryOperation
  readonly queue: string | undefined
  remaining: number
  readonly error: unknown
}

const DEFAULT_IN_PROCESS_DELAY_MS = 1000
const DEFAULT_IDLE_TIMEOUT_MS = 5000

/** Creates a {@link MemoryDriver}. */
export function memory(options: MemoryDriverOptions = {}): MemoryDriver {
  return new MemoryDriver(options)
}

/** In-memory {@link MessagingDriver}. See the module documentation. */
export class MemoryDriver implements MessagingDriver {
  readonly name = 'memory'
  readonly capabilities: DriverCapabilities
  readonly #deadLetterName: (queue: string) => string
  readonly #queues = new Map<string, QueueState>()
  readonly #published: MemoryMessage[] = []
  readonly #settlements: MemorySettlement[] = []
  readonly #deadLetters: MemoryDeadLetter[] = []
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  readonly #failures: Failure[] = []
  readonly #idleWaiters = new Set<() => void>()
  #inflight = 0
  #connected = false
  #closed = false
  #idleCheckScheduled = false

  constructor(options: MemoryDriverOptions = {}) {
    const nativeDelay = options.nativeDelay ?? true
    this.capabilities = Object.freeze({
      nativeDelay,
      maxNativeDelayMs: nativeDelay
        ? durationOption(options.maxNativeDelayMs, Number.POSITIVE_INFINITY, 'maxNativeDelayMs')
        : 0,
      maxInProcessDelayMs: durationOption(
        options.maxInProcessDelayMs,
        DEFAULT_IN_PROCESS_DELAY_MS,
        'maxInProcessDelayMs',
      ),
      deliveryCount: 'native',
      maxPublishDelayMs: durationOption(options.maxPublishDelayMs, Number.POSITIVE_INFINITY, 'maxPublishDelayMs'),
    })
    this.#deadLetterName = options.deadLetterName ?? (queue => `${queue}.dlq`)
  }

  /** Whether `connect()` was called and `close()` was not. */
  get connected(): boolean {
    return this.#connected && !this.#closed
  }

  // -----------------------------------------------------------------------------------------------
  // MessagingDriver
  // -----------------------------------------------------------------------------------------------

  async connect(_context: DriverContext): Promise<void> {
    await Promise.resolve()
    this.#maybeFail('connect', undefined)
    this.#connected = true
    this.#closed = false
  }

  async close(): Promise<void> {
    await Promise.resolve()
    this.#closed = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const state of this.#queues.values()) {
      for (const subscriber of state.subscribers) subscriber.active = false
      state.subscribers.length = 0
    }
    this.#checkIdle()
  }

  deadLetterName(queue: string): string {
    return this.#deadLetterName(queue)
  }

  async publish(queue: string, message: OutboundMessage): Promise<void> {
    await Promise.resolve()
    this.#assertOpen(`publish to "${queue}"`)
    this.#maybeFail('publish', queue)
    const stored: StoredMessage = {
      queue,
      id: message.id,
      type: message.type,
      key: message.key,
      headers: { ...message.headers },
      body: message.body,
      contentType: message.contentType,
      timestamp: message.timestamp,
      deliveries: 0,
    }
    this.#published.push(snapshot(stored))
    if (message.delayMs > 0) this.#schedule(() => this.#enqueue(stored, 'tail'), message.delayMs)
    else this.#enqueue(stored, 'tail')
  }

  async subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    await Promise.resolve()
    this.#assertOpen(`subscribe to "${queue}"`)
    this.#maybeFail('subscribe', queue)
    const state = this.#queue(queue)
    const subscriber: Subscriber = {
      queue,
      handler,
      concurrency: options.concurrency,
      options,
      inflight: 0,
      active: true,
    }
    state.subscribers.push(subscriber)
    this.#pump(queue)
    return {
      cancel: async (): Promise<void> => {
        await Promise.resolve()
        subscriber.active = false
        this.#checkIdle()
      },
      close: async (): Promise<void> => {
        await Promise.resolve()
        subscriber.active = false
        const index = state.subscribers.indexOf(subscriber)
        if (index !== -1) state.subscribers.splice(index, 1)
        this.#checkIdle()
      },
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Test helpers
  // -----------------------------------------------------------------------------------------------

  /**
   * Injects a message into `queue` as an external producer would (no codec involved when `body` is
   * given). Returns the message id.
   */
  send(queue: string, options: MemorySendOptions = {}): string {
    this.#assertOpen(`send to "${queue}"`)
    const encoded =
      options.body === undefined
        ? jsonCodec.encode(options.payload, options.contentType)
        : { body: options.body, contentType: options.contentType }
    const stored: StoredMessage = {
      queue,
      id: options.id ?? randomUUID(),
      type: options.type,
      key: options.key,
      headers: { ...(options.headers ?? {}) },
      body: encoded.body,
      contentType: encoded.contentType,
      timestamp: Date.now(),
      deliveries: options.deliveries ?? 0,
    }
    this.#enqueue(stored, 'tail')
    return stored.id
  }

  /** Messages published through `publish()` (the `MessageBroker`), optionally for one queue. */
  published(queue?: string): MemoryMessage[] {
    return this.#published.filter(message => queue === undefined || message.queue === queue)
  }

  /** Messages waiting in `queue` (not delivered yet, delayed messages excluded). */
  pending(queue: string): MemoryMessage[] {
    return (this.#queues.get(queue)?.ready ?? []).map(snapshot)
  }

  /** Settlements performed by consumers, in order, optionally for one consumed queue. */
  settlements(queue?: string): MemorySettlement[] {
    return this.#settlements.filter(settlement => queue === undefined || settlement.queue === queue)
  }

  /** Dead-lettered (or discarded) messages, optionally for one consumed queue. */
  deadLetters(queue?: string): MemoryDeadLetter[] {
    return this.#deadLetters.filter(entry => queue === undefined || entry.originalQueue === queue)
  }

  /** Deliveries currently handed to consumers and not finished. */
  get inFlight(): number {
    return this.#inflight
  }

  /** Whether nothing is in flight, scheduled or deliverable. */
  isIdle(): boolean {
    if (this.#inflight > 0 || this.#timers.size > 0) return false
    for (const state of this.#queues.values()) {
      if (state.scheduled) return false
      if (state.ready.length > 0 && state.subscribers.some(s => s.active && s.inflight < s.concurrency)) return false
    }
    return true
  }

  /**
   * Resolves once nothing is in flight, scheduled (delayed messages, retries) or deliverable to an
   * active subscriber. Rejects after `timeoutMs` (default 5 s).
   */
  idle(timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#idleWaiters.delete(done)
        reject(
          new Error(`[znight] MemoryDriver.idle(): still busy after ${timeoutMs} ms (${this.#inflight} in flight)`),
        )
      }, timeoutMs)
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.#idleWaiters.add(done)
      this.#checkIdle()
    })
  }

  /** Polls `predicate` until it returns `true`; rejects after `timeoutMs` (default 5 s). */
  async waitFor(predicate: () => boolean, timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`[znight] MemoryDriver.waitFor(): condition not met after ${timeoutMs} ms`)
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }

  /**
   * Makes an operation fail (for tests): `publish` (also dead-letter publications, by destination
   * queue), `ack`, `retry`, `dead-letter`, `release` (by consumed queue), `subscribe`, `connect`.
   * Returns a function removing the failure.
   */
  fail(operation: MemoryOperation, options: MemoryFailureOptions = {}): () => void {
    const failure: Failure = {
      operation,
      queue: options.queue,
      remaining: options.times ?? Number.POSITIVE_INFINITY,
      error: options.error ?? new Error(`[memory] injected ${operation} failure`),
    }
    this.#failures.push(failure)
    return () => {
      const index = this.#failures.indexOf(failure)
      if (index !== -1) this.#failures.splice(index, 1)
    }
  }

  /** Forgets every message, settlement and failure (subscriptions are kept). */
  reset(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const state of this.#queues.values()) state.ready.length = 0
    this.#published.length = 0
    this.#settlements.length = 0
    this.#deadLetters.length = 0
    this.#failures.length = 0
    this.#checkIdle()
  }

  // -----------------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------------

  #queue(name: string): QueueState {
    let state = this.#queues.get(name)
    if (state === undefined) {
      state = { ready: [], subscribers: [], next: 0, scheduled: false }
      this.#queues.set(name, state)
    }
    return state
  }

  #enqueue(message: StoredMessage, position: 'head' | 'tail'): void {
    const state = this.#queue(message.queue)
    if (position === 'head') state.ready.unshift(message)
    else state.ready.push(message)
    this.#pump(message.queue)
  }

  #schedule(fn: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      fn()
      this.#checkIdle()
    }, delayMs)
    this.#timers.add(timer)
  }

  #pump(queue: string): void {
    const state = this.#queue(queue)
    if (state.scheduled) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      this.#dispatch(state)
      this.#checkIdle()
    })
  }

  #dispatch(state: QueueState): void {
    while (state.ready.length > 0) {
      const subscriber = this.#nextSubscriber(state)
      if (subscriber === undefined) return
      const message = state.ready.shift() as StoredMessage
      this.#deliver(subscriber, message)
    }
  }

  #nextSubscriber(state: QueueState): Subscriber | undefined {
    const count = state.subscribers.length
    for (let offset = 0; offset < count; offset++) {
      const index = (state.next + offset) % count
      const subscriber = state.subscribers[index] as Subscriber
      if (subscriber.active && subscriber.inflight < subscriber.concurrency) {
        state.next = (index + 1) % count
        return subscriber
      }
    }
    return undefined
  }

  #deliver(subscriber: Subscriber, message: StoredMessage): void {
    message.deliveries++
    subscriber.inflight++
    this.#inflight++
    const attempt = message.deliveries
    let settled = false
    /** Validates a settlement before any side effect (already settled, closed driver, injected failure). */
    const check = (action: MemoryOperation): void => {
      if (settled) throw new Error(`[memory] message ${message.id} was already settled (${action})`)
      this.#assertOpen(`${action} message ${message.id}`)
      this.#maybeFail(action, message.queue)
    }
    const record = (settlement: Omit<MemorySettlement, 'queue' | 'id' | 'attempt'>): void => {
      this.#settlements.push({ queue: message.queue, id: message.id, attempt, ...settlement })
    }
    const delivery: DriverDelivery = {
      id: message.id,
      body: message.body,
      contentType: message.contentType,
      headers: message.headers,
      type: message.type,
      key: message.key,
      attempt,
      redelivered: attempt > 1,
      timestamp: message.timestamp,
      raw: snapshot(message),
      ack: async (): Promise<void> => {
        await Promise.resolve()
        check('ack')
        settled = true
        record({ action: 'ack' })
      },
      retry: async (request: RetryRequest): Promise<void> => {
        await Promise.resolve()
        check('retry')
        settled = true
        record({ action: 'retry', delayMs: request.delayMs, error: request.error })
        if (request.delayMs > 0) this.#schedule(() => this.#enqueue(message, 'tail'), request.delayMs)
        else this.#enqueue(message, 'tail')
      },
      deadLetter: async (request: DeadLetterRequest): Promise<void> => {
        await Promise.resolve()
        check('dead-letter')
        const queue = request.queue
        if (queue !== undefined) {
          this.#maybeFail('publish', queue)
          const copy: StoredMessage = {
            ...message,
            queue,
            headers: deadLetterHeaders(message.headers, request, message.queue),
            deliveries: 0,
          }
          this.#enqueue(copy, 'tail')
        }
        settled = true
        record({ action: queue === undefined ? 'reject' : 'dead-letter', reason: request.reason, error: request.error })
        this.#deadLetters.push({
          queue,
          originalQueue: message.queue,
          message: snapshot(message),
          reason: request.reason,
          error: request.error,
          attempt: request.attempt,
        })
      },
      release: async (): Promise<void> => {
        await Promise.resolve()
        check('release')
        settled = true
        record({ action: 'release' })
        this.#enqueue(message, 'head')
      },
    }
    const finish = (): void => {
      subscriber.inflight--
      this.#inflight--
      if (!settled && !this.#closed) {
        // the consumer returned without settling: give the message back, like a broker would
        settled = true
        record({ action: 'release' })
        this.#enqueue(message, 'head')
      }
      this.#pump(message.queue)
      this.#checkIdle()
    }
    let result: Promise<void>
    try {
      result = subscriber.handler(delivery)
    } catch (error) {
      result = Promise.reject(error)
    }
    Promise.resolve(result).then(finish, finish)
  }

  #maybeFail(operation: MemoryOperation, queue: string | undefined): void {
    for (const failure of this.#failures) {
      if (failure.operation !== operation || failure.remaining <= 0) continue
      if (failure.queue !== undefined && failure.queue !== queue) continue
      failure.remaining--
      throw failure.error
    }
  }

  #assertOpen(action: string): void {
    if (this.#closed) throw brokerUnavailableError(`[memory] Cannot ${action}: the driver is closed`)
  }

  #checkIdle(): void {
    if (this.#idleWaiters.size === 0 || this.#idleCheckScheduled) return
    this.#idleCheckScheduled = true
    queueMicrotask(() => {
      this.#idleCheckScheduled = false
      if (!this.isIdle()) return
      const waiters = [...this.#idleWaiters]
      this.#idleWaiters.clear()
      for (const waiter of waiters) waiter()
    })
  }
}

function snapshot(message: StoredMessage): MemoryMessage {
  let payload: unknown
  try {
    payload = jsonCodec.decode(message.body, message.contentType)
  } catch {
    payload = undefined
  }
  return {
    queue: message.queue,
    id: message.id,
    type: message.type,
    key: message.key,
    headers: Object.assign(headerRecord(), message.headers),
    body: message.body,
    contentType: message.contentType,
    timestamp: message.timestamp,
    deliveries: message.deliveries,
    payload,
  }
}
