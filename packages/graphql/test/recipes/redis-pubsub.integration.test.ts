/**
 * The Redis `PubSub` recipe (`redis-pubsub.ts`) against a Redis container through ioredis, wired as
 * the GraphQL guide shows: two instances, each with a publisher and a duplicated subscriber
 * connection. Runs with `ZNIGHT_INTEGRATION=1` (Docker required).
 */
import type { StartedRedisContainer } from '@testcontainers/redis'

import { RedisContainer } from '@testcontainers/redis'
import Redis from 'ioredis'

import { RedisPubSub } from './redis-pubsub.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

interface CatalogEvents {
  bookAdded: { readonly title: string }
}

const integration = process.env['ZNIGHT_INTEGRATION'] === '1'

describe.skipIf(!integration)('RedisPubSub (testcontainers, ioredis)', () => {
  let container: StartedRedisContainer
  const connections: Redis[] = []

  function instance(): RedisPubSub<CatalogEvents> {
    const publisher = new Redis(container.getConnectionUrl())
    const subscriber = publisher.duplicate()
    connections.push(publisher, subscriber)
    return new RedisPubSub<CatalogEvents>({ publisher, subscriber })
  }

  /** `PUBSUB NUMSUB channel`, polled until it is `count`. */
  async function subscribers(channel: string, count: number): Promise<number> {
    const admin = connections[0] as Redis
    let current = -1
    for (let attempt = 0; attempt < 100; attempt++) {
      const reply = (await admin.call('PUBSUB', 'NUMSUB', channel)) as [string, number]
      current = Number(reply[1])
      if (current === count) break
      await Bun.sleep(10)
    }
    return current
  }

  beforeAll(async () => {
    container = await new RedisContainer('redis:7.4-alpine').start()
  }, 180_000)

  afterAll(async () => {
    await Promise.all(connections.map(connection => connection.quit()))
    await container?.stop()
  })

  it('delivers what one instance publishes to the subscribers of another, then unsubscribes', async () => {
    const [a, b] = [instance(), instance()]
    const leave = new AbortController()
    const onB = b.subscribe('bookAdded', { signal: leave.signal })
    expect(await subscribers('graphql:bookAdded', 1)).toBe(1)

    await a.publish('bookAdded', { title: 'Tehanu' })

    expect(await onB.next()).toEqual({ done: false, value: { title: 'Tehanu' } })
    leave.abort()
    expect(await onB.next()).toEqual({ done: true, value: undefined })
    expect(await subscribers('graphql:bookAdded', 0)).toBe(0)
  }, 20_000)

  it('close() leaves every Redis channel', async () => {
    const pubsub = instance()
    pubsub.subscribe('bookAdded')
    expect(await subscribers('graphql:bookAdded', 1)).toBe(1)

    pubsub.close()

    expect(await subscribers('graphql:bookAdded', 0)).toBe(0)
  }, 20_000)
})
