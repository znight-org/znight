/**
 * The "Write your own PubSub" recipe of the GraphQL guide (`docs/guide/graphql.md`), shown there as
 * is from its first import: a `PubSub` shared by every instance of an application through Redis
 * pub/sub. Tested by `redis-pubsub.test.ts` against an in-memory Redis, and against a Redis
 * container with ioredis by `redis-pubsub.integration.test.ts` (`ZNIGHT_INTEGRATION=1`).
 */
import type { SubscribeOptions } from '@znight/graphql'

import { GraphQLErrorCode, GraphQLException, PubSub } from '@znight/graphql'
import { EventChannel } from '@znight/http'

/** The connection that publishes (an ioredis `Redis` fits). */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>
}

/** A connection dedicated to subscriptions (another ioredis `Redis`, e.g. `publisher.duplicate()`). */
export interface RedisSubscriber {
  subscribe(channel: string): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
}

export interface RedisPubSubOptions {
  readonly publisher: RedisPublisher
  readonly subscriber: RedisSubscriber
  /** Prefix of the Redis channels, so that applications can share a Redis. Default `'graphql:'`. */
  readonly prefix?: string
  /** Events buffered per subscriber; one that falls further behind ends with SUBSCRIPTION_OVERFLOW. Default 100. */
  readonly bufferSize?: number
}

/**
 * Every instance publishes to Redis and subscribes to the Redis channels its own subscribers need,
 * once per topic, then fans each message out to them. Payloads travel as JSON.
 */
export class RedisPubSub<Events extends object = Record<string, unknown>> extends PubSub<Events> {
  readonly #publisher: RedisPublisher
  readonly #subscriber: RedisSubscriber
  readonly #prefix: string
  readonly #bufferSize: number
  /** The local subscribers of each Redis channel. */
  readonly #channels = new Map<string, Set<EventChannel<unknown>>>()
  #closed = false

  constructor(options: RedisPubSubOptions) {
    super()
    this.#publisher = options.publisher
    this.#subscriber = options.subscriber
    this.#prefix = options.prefix ?? 'graphql:'
    this.#bufferSize = options.bufferSize ?? 100
    this.#subscriber.on('message', (channel, message) => this.#deliver(channel, message))
  }

  async publish<K extends keyof Events & string>(topic: K, payload: Events[K]): Promise<void> {
    await this.#publisher.publish(this.#prefix + topic, JSON.stringify(payload))
  }

  subscribe<K extends keyof Events & string>(
    topic: K,
    options: SubscribeOptions = {},
  ): AsyncIterableIterator<Events[K]> {
    // a bounded queue per subscriber, closed when the signal aborts (client gone, shutdown)
    const events = new EventChannel<Events[K]>({
      capacity: this.#bufferSize,
      overflow: 'drop-newest',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (this.#closed) events.close()
    else this.#add(this.#prefix + topic, events as EventChannel<unknown>)
    const iterator = events[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      return: () => {
        events.close()
        return Promise.resolve({ done: true, value: undefined })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }

  /** Ends every subscription and unsubscribes from Redis. The connections are yours to close. */
  close(): void {
    this.#closed = true
    for (const subscribers of [...this.#channels.values()]) {
      for (const events of [...subscribers]) events.close()
    }
  }

  #add(channel: string, events: EventChannel<unknown>): void {
    let subscribers = this.#channels.get(channel)
    if (subscribers === undefined) {
      const created = new Set<EventChannel<unknown>>()
      subscribers = created
      this.#channels.set(channel, created)
      // the first local subscriber of the topic: listen to its Redis channel
      this.#subscriber.subscribe(channel).catch((error: unknown) => {
        for (const subscriber of [...created]) subscriber.fail(error)
      })
    }
    const set = subscribers
    set.add(events)
    events.onClose(() => {
      set.delete(events)
      if (set.size > 0 || this.#channels.get(channel) !== set) return
      // the last one left: stop listening
      this.#channels.delete(channel)
      this.#subscriber.unsubscribe(channel).catch(() => {})
    })
  }

  #deliver(channel: string, message: string): void {
    const subscribers = this.#channels.get(channel)
    if (subscribers === undefined) return
    let payload: unknown
    try {
      payload = JSON.parse(message)
    } catch {
      return // not a message of this PubSub
    }
    for (const events of subscribers) {
      if (!events.push(payload)) {
        events.fail(
          new GraphQLException('The subscriber fell behind the events: the subscription ended', {
            code: GraphQLErrorCode.SubscriptionOverflow,
          }),
        )
      }
    }
  }
}
