/**
 * The Redis `PubSub` recipe (`redis-pubsub.ts`) against an in-memory Redis that behaves like Redis
 * pub/sub: commands of a connection apply in order after a round trip, a message reaches the
 * connections subscribed to its channel when it is published, and nobody else.
 */
import type { GraphQLContext } from '../../src/index.ts'
import type { RedisPublisher, RedisSubscriber } from './redis-pubsub.ts'

import Redis from 'ioredis'

import { GraphQLErrorCode, GraphQLException } from '../../src/index.ts'
import { bind, boot, field, graphqlMetadata } from '../support/app.ts'
import { RedisPubSub } from './redis-pubsub.ts'
import { describe, expect, it } from 'bun:test'

interface Book {
  readonly title: string
  readonly createdAt?: Date | string
}

interface CatalogEvents {
  bookAdded: Book
  bookRemoved: string
}

/** A Redis server in memory: its connections and the commands they sent. */
class FakeRedis {
  readonly connections = new Set<FakeConnection>()
  readonly commands: string[] = []
  /** Rejects the `SUBSCRIBE` commands of these channels. */
  readonly refused = new Set<string>()

  connect(): FakeConnection {
    const connection = new FakeConnection(this)
    this.connections.add(connection)
    return connection
  }

  /** Waits until every command sent so far has been applied. */
  async flush(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  }

  /** `PUBSUB NUMSUB channel`. */
  numsub(channel: string): number {
    return [...this.connections].filter(connection => connection.channels.has(channel)).length
  }
}

class FakeConnection implements RedisPublisher, RedisSubscriber {
  readonly channels = new Set<string>()
  readonly #server: FakeRedis
  readonly #listeners: ((channel: string, message: string) => void)[] = []

  constructor(server: FakeRedis) {
    this.#server = server
  }

  async publish(channel: string, message: string): Promise<number> {
    await Promise.resolve()
    this.#server.commands.push(`PUBLISH ${channel}`)
    const receivers = [...this.#server.connections].filter(connection => connection.channels.has(channel))
    for (const receiver of receivers) receiver.#receive(channel, message)
    return receivers.length
  }

  async subscribe(channel: string): Promise<number> {
    await Promise.resolve()
    this.#server.commands.push(`SUBSCRIBE ${channel}`)
    if (this.#server.refused.has(channel)) throw new Error(`NOPERM no permissions to access the '${channel}' channel`)
    this.channels.add(channel)
    return this.channels.size
  }

  async unsubscribe(channel: string): Promise<number> {
    await Promise.resolve()
    this.#server.commands.push(`UNSUBSCRIBE ${channel}`)
    this.channels.delete(channel)
    return this.channels.size
  }

  on(event: 'message', listener: (channel: string, message: string) => void): this {
    if (event === 'message') this.#listeners.push(listener)
    return this
  }

  #receive(channel: string, message: string): void {
    // delivered after the PUBLISH reply, like a message read from another socket
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener(channel, message)
    })
  }
}

/** One instance of the application: its own two connections to the shared Redis. */
function instance(redis: FakeRedis, options: { prefix?: string; bufferSize?: number } = {}) {
  return new RedisPubSub<CatalogEvents>({ publisher: redis.connect(), subscriber: redis.connect(), ...options })
}

describe('RedisPubSub (in-memory Redis)', () => {
  it('delivers what one instance publishes to the subscribers of every instance, as JSON', async () => {
    const redis = new FakeRedis()
    const [a, b] = [instance(redis), instance(redis)]
    const onA = a.subscribe('bookAdded')
    const onB = b.subscribe('bookAdded')
    await redis.flush()

    await a.publish('bookAdded', { title: 'Tehanu', createdAt: new Date('2024-02-01T00:00:00.000Z') })

    const expected = { done: false, value: { title: 'Tehanu', createdAt: '2024-02-01T00:00:00.000Z' } }
    expect(await onA.next()).toEqual(expected)
    expect(await onB.next()).toEqual(expected)
    expect(redis.commands).toEqual([
      'SUBSCRIBE graphql:bookAdded',
      'SUBSCRIBE graphql:bookAdded',
      'PUBLISH graphql:bookAdded',
    ])
  })

  it('keeps topics apart and delivers in publication order', async () => {
    const redis = new FakeRedis()
    const pubsub = instance(redis)
    const added = pubsub.subscribe('bookAdded')
    const removed = pubsub.subscribe('bookRemoved')
    await redis.flush()

    await pubsub.publish('bookRemoved', 'b1')
    await pubsub.publish('bookAdded', { title: 'Dune' })
    await pubsub.publish('bookAdded', { title: 'Tehanu' })

    expect((await added.next()).value).toEqual({ title: 'Dune' })
    expect((await added.next()).value).toEqual({ title: 'Tehanu' })
    expect((await removed.next()).value).toBe('b1')
  })

  it('listens to a Redis channel once per topic, and leaves it with the last subscriber', async () => {
    const redis = new FakeRedis()
    const pubsub = instance(redis)
    const first = new AbortController()
    const second = new AbortController()
    const one = pubsub.subscribe('bookAdded', { signal: first.signal })
    const two = pubsub.subscribe('bookAdded', { signal: second.signal })
    await redis.flush()
    expect(redis.numsub('graphql:bookAdded')).toBe(1)

    const pending = one.next()
    first.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    await redis.flush()
    expect(redis.numsub('graphql:bookAdded')).toBe(1)

    await two.return?.()
    second.abort()
    await redis.flush()
    expect(redis.numsub('graphql:bookAdded')).toBe(0)
    expect(redis.commands).toEqual(['SUBSCRIBE graphql:bookAdded', 'UNSUBSCRIBE graphql:bookAdded'])
  })

  it('ends a subscriber that falls behind with SUBSCRIPTION_OVERFLOW, after its buffered events', async () => {
    const redis = new FakeRedis()
    const pubsub = instance(redis, { bufferSize: 2 })
    const slow = pubsub.subscribe('bookRemoved')
    const fast = pubsub.subscribe('bookRemoved')
    await redis.flush()
    const received: string[] = []
    const reading = (async () => {
      for await (const id of fast) if (received.push(id) === 3) break
    })()

    for (const id of ['b1', 'b2', 'b3']) await pubsub.publish('bookRemoved', id)
    await reading

    expect(received).toEqual(['b1', 'b2', 'b3'])
    expect((await slow.next()).value).toBe('b1')
    expect((await slow.next()).value).toBe('b2')
    const error = await slow.next().then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(GraphQLException)
    expect((error as GraphQLException).code).toBe(GraphQLErrorCode.SubscriptionOverflow)
    await redis.flush()
    expect(redis.numsub('graphql:bookRemoved')).toBe(0)
  })

  it('ignores the channels of other prefixes and messages that are not JSON', async () => {
    const redis = new FakeRedis()
    const shop = instance(redis, { prefix: 'shop:' })
    const blog = instance(redis, { prefix: 'blog:' })
    const books = shop.subscribe('bookRemoved')
    await redis.flush()

    await blog.publish('bookRemoved', 'blog-post')
    await redis.connect().publish('shop:bookRemoved', 'not json')
    await shop.publish('bookRemoved', 'b7')

    expect(await books.next()).toEqual({ done: false, value: 'b7' })
  })

  it('fails the subscribers of a topic when Redis refuses the subscription', async () => {
    const redis = new FakeRedis()
    redis.refused.add('graphql:bookAdded')
    const pubsub = instance(redis)
    const books = pubsub.subscribe('bookAdded')

    await expect(books.next()).rejects.toThrow('NOPERM')
    await redis.flush()
    expect(redis.commands).toEqual(['SUBSCRIBE graphql:bookAdded', 'UNSUBSCRIBE graphql:bookAdded'])
  })

  it('close() ends every subscription and unsubscribes; later subscriptions end at once', async () => {
    const redis = new FakeRedis()
    const pubsub = instance(redis)
    const added = pubsub.subscribe('bookAdded')
    const removed = pubsub.subscribe('bookRemoved')
    await redis.flush()

    pubsub.close()
    await redis.flush()

    expect(await added.next()).toEqual({ done: true, value: undefined })
    expect(await removed.next()).toEqual({ done: true, value: undefined })
    expect(await pubsub.subscribe('bookAdded').next()).toEqual({ done: true, value: undefined })
    expect(redis.numsub('graphql:bookAdded') + redis.numsub('graphql:bookRemoved')).toBe(0)
  })

  it('takes two ioredis connections', () => {
    const publisher = new Redis({ lazyConnect: true })
    const subscriber = publisher.duplicate()
    try {
      expect(new RedisPubSub<CatalogEvents>({ publisher, subscriber })).toBeInstanceOf(RedisPubSub)
    } finally {
      publisher.disconnect()
      subscriber.disconnect()
    }
  })
})

/** A mutation that publishes, and the subscription that streams what it published. */
class Catalog {
  constructor(readonly pubsub: RedisPubSub<CatalogEvents>) {}
  now(): number {
    return 0
  }
  async addBook(args: { title: string }): Promise<string> {
    await this.pubsub.publish('bookAdded', { title: args.title })
    return args.title
  }
  async *bookAdded(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncGenerator<string> {
    for await (const book of this.pubsub.subscribe('bookAdded', { signal: ctx.signal })) yield book.title
  }
}

describe('RedisPubSub as the pubsub option', () => {
  it('streams to a subscription of one instance what a mutation published on another', async () => {
    const redis = new FakeRedis()
    const metadata = graphqlMetadata({
      providers: [{ class: Catalog, deps: ['@znight/graphql#PubSub'] }],
      types: [
        { kind: 'object', name: 'Query', fields: [field('now', 'Int', bind(Catalog, 'now'))] },
        {
          kind: 'object',
          name: 'Mutation',
          fields: [
            field('addBook', 'String', bind(Catalog, 'addBook', { operation: 'mutation' }), {
              args: [{ name: 'title', type: 'String!' }],
            }),
          ],
        },
        {
          kind: 'object',
          name: 'Subscription',
          fields: [field('bookAdded', 'String', bind(Catalog, 'bookAdded', { operation: 'subscription' }))],
        },
      ],
    })
    await using a = await boot(metadata, { pubsub: instance(redis) })
    await using b = await boot(metadata, { pubsub: instance(redis) })

    const stream = await b.plugin.subscribe({ query: 'subscription { bookAdded }' })
    await redis.flush()
    const added = await a.plugin.execute({ query: 'mutation { addBook(title: "Tehanu") }' })

    expect(added).toEqual({ data: { addBook: 'Tehanu' } })
    expect(await stream.next()).toEqual({ done: false, value: { data: { bookAdded: 'Tehanu' } } })
    await stream.return()
    await redis.flush()
    expect(redis.numsub('graphql:bookAdded')).toBe(0)
  })
})
