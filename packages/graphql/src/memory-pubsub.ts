/**
 * `MemoryPubSub` (RFC 0005 §5.6, §8.7): the in-process `PubSub` of `GraphQLPlugin`, one RFC 0006
 * `EventChannel` per subscriber.
 */
import type { SubscribeOptions } from './pubsub.ts'

import { EventChannel } from '@znight/http'

import { GraphQLErrorCode, GraphQLException } from './errors.ts'
import { PubSub } from './pubsub.ts'

/** Options of {@link MemoryPubSub}. */
export interface MemoryPubSubOptions {
  /**
   * Events buffered per subscriber. A subscriber that falls further behind gets a final
   * `SUBSCRIPTION_OVERFLOW` error and its subscription ends. Default 100.
   */
  readonly bufferSize?: number
}

const DEFAULT_BUFFER_SIZE = 100
const PUBLISHED: Promise<void> = Promise.resolve()

/** One subscriber: its channel, and whether it overflowed. */
class Subscriber<T> implements AsyncIterableIterator<T> {
  readonly channel: EventChannel<T>
  readonly #iterator: AsyncIterator<T>
  overflowed = false

  constructor(channel: EventChannel<T>) {
    this.channel = channel
    this.#iterator = channel[Symbol.asyncIterator]()
  }

  async next(): Promise<IteratorResult<T>> {
    const step = await this.#iterator.next()
    if (step.done === true && this.overflowed) {
      this.overflowed = false
      throw new GraphQLException('The subscriber fell behind the events: the subscription ended', {
        code: GraphQLErrorCode.SubscriptionOverflow,
      })
    }
    return step
  }

  return(): Promise<IteratorResult<T>> {
    this.overflowed = false
    return this.#iterator.return?.() ?? Promise.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}

/**
 * In-process fan-out of events to subscribers: what `GraphQLPlugin` provides as `PubSub` by default.
 * Deployments with several instances supply their own `PubSub` (`pubsub` option).
 *
 * ```ts
 * GraphQLPlugin.configure({ pubsub: new MemoryPubSub({ bufferSize: 500 }) })
 * ```
 */
export class MemoryPubSub<Events extends object = Record<string, unknown>> extends PubSub<Events> {
  readonly #bufferSize: number
  readonly #topics = new Map<string, Set<Subscriber<unknown>>>()
  #closed = false

  constructor(options: MemoryPubSubOptions = {}) {
    super()
    const bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE
    if (!(Number.isSafeInteger(bufferSize) && bufferSize >= 1)) {
      throw new TypeError(`MemoryPubSub: bufferSize must be a positive integer (received ${String(bufferSize)})`)
    }
    this.#bufferSize = bufferSize
  }

  /** Subscribers of every topic. */
  get subscribers(): number {
    let count = 0
    for (const subscribers of this.#topics.values()) count += subscribers.size
    return count
  }

  publish<K extends keyof Events & string>(topic: K, payload: Events[K]): Promise<void> {
    const subscribers = this.#topics.get(topic)
    if (subscribers !== undefined) {
      for (const subscriber of subscribers) {
        const channel = subscriber.channel
        // `false` from an open channel is an overflow ('close'): it closes after its buffered events
        if (!channel.closed && !channel.push(payload)) subscriber.overflowed = true
      }
    }
    return PUBLISHED
  }

  subscribe<K extends keyof Events & string>(
    topic: K,
    options: SubscribeOptions = {},
  ): AsyncIterableIterator<Events[K]> {
    const channel = new EventChannel<Events[K]>({
      capacity: this.#bufferSize,
      overflow: 'close',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const subscriber = new Subscriber(channel)
    if (this.#closed) {
      channel.close()
      return subscriber
    }
    let subscribers = this.#topics.get(topic)
    if (subscribers === undefined) {
      subscribers = new Set()
      this.#topics.set(topic, subscribers)
    }
    const set = subscribers
    set.add(subscriber as Subscriber<unknown>)
    channel.onClose(() => {
      set.delete(subscriber as Subscriber<unknown>)
      if (set.size === 0 && this.#topics.get(topic) === set) this.#topics.delete(topic)
    })
    return subscriber
  }

  /** Ends every subscription; later subscriptions end at once. */
  close(): void {
    this.#closed = true
    for (const subscribers of [...this.#topics.values()]) {
      for (const subscriber of [...subscribers]) subscriber.channel.close()
    }
    this.#topics.clear()
  }
}
