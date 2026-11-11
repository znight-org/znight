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

/** Redis (the oldest supported version and a current one) and Valkey: the same protocol, Lua scripts and stream commands. */
const SERVERS = [
  { name: 'redis 7.0', image: 'redis:7.0-alpine', command: ['redis-server'] },
  { name: 'redis', image: 'redis:7.4-alpine', command: ['redis-server'] },
  { name: 'valkey', image: 'valkey/valkey:9.0-alpine', command: ['valkey-server'] },
] as const

const silent: CoreLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** Polls an asynchronous `predicate` until it holds. */
async function eventually(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`)
    await sleep(50)
  }
}

/** Names of the consumers of a group (`XINFO CONSUMERS`). */
async function consumerNames(client: Redis, stream: string, group: string): Promise<string[]> {
  const consumers = (await client.xinfo('CONSUMERS', stream, group)) as unknown[][]
  return consumers.map(fields => String(fields[fields.indexOf('name') + 1]))
}

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
      expect(await client.exists(`${queue}:retry:znight:delayed`)).toBe(0)
      await sleep(100)
      expect((await client.xpending(queue, 'znight'))[0]).toBe(0)
      expect((await client.xpending(`${queue}:retry:znight`, 'znight'))[0]).toBe(0)
      // the retries never went back to the queue stream
      expect(await client.xlen(queue)).toBe(1)
    })

    it('keeps the retries of a group to that group (fan-out)', async () => {
      const queue = `fanout-${Date.now()}`
      const seen: Record<string, number[]> = { billing: [], shipping: [] }
      const failingOnce = (group: string) =>
        class {
          handle(_payload: unknown, message: InboundMessage) {
            seen[group]?.push(message.attempt)
            if (message.attempt === 1) throw new Error(`${group} is down`)
          }
        }
      const retry = { attempts: 3, backoff: 'fixed', delay: 200 } as const
      for (const group of ['billing', 'shipping']) {
        await startApp(driver({ maxInProcessDelayMs: 0 }), [
          { class: failingOnce(group), queue, options: { group }, handlers: [handler('handle', { retry })] },
        ])
      }
      await client.xadd(queue, '*', 'id', 'm-1', 'content-type', 'application/json', 'body', '{}')
      await waitFor(
        () => seen['billing']?.length === 2 && seen['shipping']?.length === 2,
        20_000,
        'one retry per group',
      )
      await sleep(800)
      expect(seen).toEqual({ billing: [1, 2], shipping: [1, 2] })
      expect(await client.xlen(queue)).toBe(1)
    })

    it('trims what every group acknowledged, and nothing a group has not read', async () => {
      const queue = `retention-${Date.now()}`
      await client.xgroup('CREATE', queue, 'audit', '0', 'MKSTREAM')
      let handled = 0
      class Consumer {
        handle() {
          handled++
        }
      }
      const created = driver({ claimIdleMs: 200 })
      await startApp(created, [{ class: Consumer, queue, options: { concurrency: 20 }, handlers: [handler('handle')] }])
      for (let index = 0; index < 300; index++) {
        await client.xadd(queue, '*', 'id', String(index), 'content-type', 'text/plain', 'body', String(index))
      }
      await waitFor(() => handled === 300, 20_000, 'the messages')
      await sleep(600)
      // the audit group has read nothing yet
      expect(await client.xlen(queue)).toBe(300)
      await client.xgroup('DESTROY', queue, 'audit')
      // approximate trimming removes whole macro nodes (100 entries by default)
      await eventually(async () => (await client.xlen(queue)) <= 100, 10_000, 'the acknowledged entries trimmed')
    })

    it('removes the consumers of crashed processes, idle without pending entries', async () => {
      const queue = `reap-${Date.now()}`
      let handled = 0
      class Consumer {
        handle() {
          handled++
        }
      }
      // idle for ten times claimIdleMs (2 s) without pending entries: removed
      await startApp(driver({ claimIdleMs: 200, blockMs: 100 }), [
        { class: Consumer, queue, handlers: [handler('handle')] },
      ])
      // Redis 7.0 adds a reading consumer to the group once it delivered an entry to it
      await client.xadd(queue, '*', 'id', 'm-1', 'content-type', 'text/plain', 'body', 'x')
      await waitFor(() => handled === 1, 10_000, 'the message')
      await client.call('XGROUP', 'CREATECONSUMER', queue, 'znight', 'crashed')
      expect(await consumerNames(client, queue, 'znight')).toHaveLength(2)
      await eventually(
        async () => !(await consumerNames(client, queue, 'znight')).includes('crashed'),
        10_000,
        'the crashed consumer removed',
      )
      // the live consumer, reading every 100 ms, stays
      expect(await consumerNames(client, queue, 'znight')).toHaveLength(1)
    })

    it('unblocks the reconnected reading connection by its new client id on stop', async () => {
      const queue = `reconnect-${Date.now()}`
      const received: InboundMessage[] = []
      class Consumer {
        handle(_payload: unknown, message: InboundMessage) {
          received.push(message)
        }
      }
      const app = await startApp(driver({ blockMs: 20_000 }), [
        { class: Consumer, queue, handlers: [handler('handle')] },
      ])
      const readers = async (): Promise<string[]> =>
        String(await client.call('CLIENT', 'LIST'))
          .split('\n')
          .filter(line => line.includes('cmd=xreadgroup'))
          .map(line => /\bid=(\d+)/.exec(line)?.[1] ?? '')
      await eventually(async () => (await readers()).length === 1, 5000, 'the blocking read')
      const [killed] = await readers()
      await client.call('CLIENT', 'KILL', 'ID', killed ?? '')
      // ioredis reconnects and resends the read; a message ends it, the next read is unblockable again
      await client.xadd(queue, '*', 'id', 'm-1', 'content-type', 'application/json', 'body', '{}')
      await waitFor(() => received.length === 1, 10_000, 'the message after the reconnection')
      await eventually(
        async () => {
          const ids = await readers()
          return ids.length === 1 && ids[0] !== killed
        },
        5000,
        'the next blocking read',
      )
      const started = Date.now()
      await app.stop()
      expect(Date.now() - started).toBeLessThan(5000)
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
      let handled = 0
      class Consumer {
        handle() {
          handled++
        }
      }
      const app = await startApp(driver(), [{ class: Consumer, queue, handlers: [handler('handle')] }])
      await client.xadd(queue, '*', 'id', 'm-1', 'content-type', 'text/plain', 'body', 'x')
      await waitFor(() => handled === 1, 10_000, 'the message')
      expect(await client.xinfo('CONSUMERS', queue, 'znight')).toHaveLength(1)
      await app.stop()
      expect(await client.xinfo('CONSUMERS', queue, 'znight')).toEqual([])
    })
  })
}
