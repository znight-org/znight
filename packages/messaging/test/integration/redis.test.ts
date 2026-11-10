import type { CoreLogger } from '@znight/core'
import type { InboundMessage, MessagingDriver } from '../../src/index.ts'

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { Redis } from 'ioredis'

import { type RedisDriverOptions, redis } from '../../src/drivers/redis.ts'
import { MessageBroker } from '../../src/index.ts'
import { describeDriverConformance } from '../../src/testing.ts'
import { handler, sleep } from '../helpers.ts'
import { integration, startApp, stopApps, waitFor } from './support.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

/** Redis and Valkey: the same protocol, Lua scripts and stream commands. */
const SERVERS = [
  { name: 'redis', image: 'redis:7.4-alpine', command: ['redis-server'] },
  { name: 'valkey', image: 'valkey/valkey:9.0-alpine', command: ['valkey-server'] },
] as const

const silent: CoreLogger = { debug() {}, info() {}, warn() {}, error() {} }

for (const server of SERVERS) {
  describe.skipIf(!integration)(`Redis Streams on ${server.name} (testcontainers)`, () => {
    afterEach(stopApps)

    let container: StartedRedisContainer
    let url: string
    let client: Redis
    const drivers: MessagingDriver[] = []

    const driver = (options: Partial<RedisDriverOptions> = {}): MessagingDriver => {
      const created = redis({ url, blockMs: 500, delayPollIntervalMs: 50, ...options })
      drivers.push(created)
      return created
    }

    beforeAll(async () => {
      container = await new RedisContainer(server.image).withCommand([...server.command]).start()
      url = container.getConnectionUrl()
      client = new Redis(url)
    }, 180_000)

    afterAll(async () => {
      await Promise.allSettled(drivers.map(created => created.close()))
      client?.disconnect()
      await container?.stop()
    })

    describeDriverConformance({
      name: `redis (${server.name})`,
      driver: overrides => driver(overrides),
      test: { describe, it },
      nativeDelayMs: 500,
      timeoutMs: 60_000,
    })

    it('runs the scripts: retries through the delayed set, dead letters and binary bodies', async () => {
      const queue = `scripts-${Date.now()}`
      const attempts: number[] = []
      const dead: InboundMessage[] = []
      class Failing {
        handle(_payload: unknown, message: InboundMessage) {
          attempts.push(message.attempt)
          throw new Error('still failing')
        }
      }
      class Collector {
        collect(_payload: unknown, message: InboundMessage) {
          dead.push(message)
        }
      }
      const app = await startApp(driver({ maxInProcessDelayMs: 0 }), [
        {
          class: Failing,
          queue,
          handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 300 } })],
        },
        { class: Collector, queue: `${queue}.dlq`, options: { deadLetter: false }, handlers: [handler('collect')] },
      ])
      const bytes = new Uint8Array([0, 255, 1, 254, 10, 13])
      await app.get(MessageBroker).publish(queue, bytes, { headers: { traceparent: '00-a-b-01' } })
      await waitFor(() => dead.length === 1, 30_000, 'the dead letter')
      expect(attempts).toEqual([1, 2, 3])
      expect(new Uint8Array(dead[0]?.body as Uint8Array)).toEqual(bytes)
      expect(dead[0]?.headers).toMatchObject({
        traceparent: '00-a-b-01',
        'x-znight-dead-letter-reason': 'max-attempts',
        'x-znight-attempts': '3',
        'x-znight-original-queue': queue,
      })
      expect(await client.exists(`${queue}:delayed`)).toBe(0)
      await sleep(100)
      expect((await client.xpending(queue, 'znight'))[0]).toBe(0)
    })

    it('claims back the entries of a crashed consumer (XAUTOCLAIM)', async () => {
      const queue = `crash-${Date.now()}`
      await client.xgroup('CREATE', queue, 'znight', '0', 'MKSTREAM')
      await client.xadd(queue, '*', 'id', 'm-1', 'content-type', 'application/json', 'body', '{"n":1}')
      // a member of the group read the entry and died before settling it
      await client.xreadgroup('GROUP', 'znight', 'crashed', 'COUNT', 1, 'STREAMS', queue, '>')
      const received: InboundMessage[] = []
      class Consumer {
        handle(_payload: unknown, message: InboundMessage) {
          received.push(message)
        }
      }
      await startApp(driver({ claimIdleMs: 500 }), [
        {
          class: Consumer,
          queue,
          handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 0 } })],
        },
      ])
      await waitFor(() => received.length === 1, 10_000, 'the claimed entry')
      expect(received[0]).toMatchObject({ id: 'm-1', attempt: 2, redelivered: true, payload: { n: 1 } })
      await sleep(1500)
      expect(received).toHaveLength(1)
      expect((await client.xpending(queue, 'znight'))[0]).toBe(0)
    })

    it('trims the streams it writes to (MAXLEN ~)', async () => {
      const queue = `trim-${Date.now()}`
      const created = driver({ maxLength: 10 })
      await created.connect({ logger: silent })
      for (let index = 0; index < 500; index++) {
        await created.publish(queue, {
          id: String(index),
          type: undefined,
          key: undefined,
          headers: {},
          body: String(index),
          contentType: 'text/plain',
          timestamp: Date.now(),
          delayMs: 0,
        })
      }
      // approximate trimming removes whole macro nodes: far below 500, never below 10
      const length = await client.xlen(queue)
      expect(length).toBeGreaterThanOrEqual(10)
      expect(length).toBeLessThan(500)
    })

    it('retires its consumers from the group when it stops', async () => {
      const queue = `retire-${Date.now()}`
      class Consumer {
        handle() {}
      }
      const app = await startApp(driver(), [{ class: Consumer, queue, handlers: [handler('handle')] }])
      await sleep(100)
      expect(await client.xinfo('CONSUMERS', queue, 'znight')).toHaveLength(1)
      await app.stop()
      expect(await client.xinfo('CONSUMERS', queue, 'znight')).toEqual([])
    })
  })
}
