/**
 * Redis Streams driver against an in-memory Redis (`fake-redis.ts`, passed as the ioredis client):
 * the wire format, consumer groups, flow control, settlements (scripts), the delayed set, reclaiming
 * the entries of crashed consumers, shutdown, and the conformance kit. The Lua scripts and the
 * behaviour against a real server are covered by `test/integration/redis.test.ts`.
 */
import type { Redis } from 'ioredis'
import type { DriverDelivery, SubscribeOptions } from '../../src/driver.ts'
import type { InboundMessage, MessagingDriver } from '../../src/index.ts'
import type { TestConsumer } from '../helpers.ts'

import { Application, ErrorCode, ZnightError } from '@znight/core'

import { type RedisDriverOptions, RedisStreamFields, redis } from '../../src/drivers/redis.ts'
import { MessageBroker, MessagingHeaders, MessagingPlugin, NonRetryableError } from '../../src/index.ts'
import { describeDriverConformance } from '../../src/testing.ts'
import { caught, handler, memoryLogger, messagingMetadata, sleep } from '../helpers.ts'
import { FakeRedis, FakeReplyError } from './fake-redis.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const subscribeOptions: SubscribeOptions = {
  consumer: 'OrderConsumer',
  concurrency: 1,
  deadLetterQueue: undefined,
  maxAttempts: 1,
  retryDelays: [],
  options: {},
}

function clientOf(fake: FakeRedis): Redis {
  return fake.connection() as unknown as Redis
}

function driverFor(fake: FakeRedis, options: Partial<RedisDriverOptions> = {}): MessagingDriver {
  return redis({ client: clientOf(fake), blockMs: 50, delayPollIntervalMs: 10, ...options })
}

let apps: Application[] = []

afterEach(async () => {
  const running = apps
  apps = []
  for (const app of running.reverse()) await app.stop()
})

async function startApp(driver: MessagingDriver, consumers: readonly TestConsumer[], logger = memoryLogger()) {
  const plugin = MessagingPlugin.configure({ driver, defaults: { requeueDelay: 20 } })
  const app = await Application.create({
    metadata: messagingMetadata(consumers),
    plugins: [plugin],
    logger,
    shutdown: { signals: false },
  })
  apps.push(app)
  await app.start()
  return { app, broker: app.get(MessageBroker), logs: logger.entries }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(5)
  }
}

/** Subscribes `queue` directly through the driver and returns the deliveries it hands out (settled by the test). */
async function deliveries(driver: MessagingDriver, queue: string, options: Partial<SubscribeOptions> = {}) {
  const received: DriverDelivery[] = []
  await driver.connect({ logger: memoryLogger() })
  const subscription = await driver.subscribe(
    queue,
    delivery =>
      new Promise<void>(resolve => {
        received.push(delivery)
        for (const name of ['ack', 'retry', 'deadLetter', 'release'] as const) {
          const original = delivery[name].bind(delivery) as (...args: never[]) => Promise<void>
          Object.assign(delivery, {
            [name]: async (...args: never[]) => {
              try {
                await original(...args)
              } finally {
                resolve()
              }
            },
          })
        }
      }),
    { ...subscribeOptions, ...options },
  )
  return { received, subscription }
}

describe('wire format', () => {
  it('adds the body, the transport fields and the headers as stream fields', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    await driver.publish('orders', {
      id: 'm-1',
      type: 'order.created',
      key: 'customer-7',
      headers: { traceparent: '00-abc-def-01', tenant: 'acme' },
      body: new Uint8Array([123, 125]),
      contentType: 'application/json',
      timestamp: 1_700_000_000_000,
      delayMs: 0,
    })
    expect(fake.entries('orders')).toEqual([
      {
        id: expect.any(String),
        fields: {
          [RedisStreamFields.Id]: 'm-1',
          [RedisStreamFields.Type]: 'order.created',
          [RedisStreamFields.Key]: 'customer-7',
          [RedisStreamFields.ContentType]: 'application/json',
          [RedisStreamFields.Timestamp]: '1700000000000',
          'h:traceparent': '00-abc-def-01',
          'h:tenant': 'acme',
          [RedisStreamFields.Body]: '{}',
        },
      },
    ])
    await driver.close()
  })

  it('round-trips messages, headers and keys through a consumer group', async () => {
    const fake = new FakeRedis()
    const received: InboundMessage[] = []
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    const { id } = await broker.publish(
      'orders',
      { total: 42 },
      { type: 'order.created', key: 'k', headers: { traceparent: '00-1-2-01' } },
    )
    await waitFor(() => received.length === 1, 'the message')
    expect(received[0]).toMatchObject({
      id,
      queue: 'orders',
      driver: 'redis',
      payload: { total: 42 },
      type: 'order.created',
      key: 'k',
      attempt: 1,
      redelivered: false,
      contentType: 'application/json',
      headers: { traceparent: '00-1-2-01' },
    })
    expect(fake.callsOf('XGROUP')[0]?.args).toEqual(['CREATE', 'orders', 'znight', '0', 'MKSTREAM'])
    expect(fake.pending('orders', 'znight')).toEqual([])
  })

  it('reads entries written by other producers: fields as headers, the entry id and time', async () => {
    const fake = new FakeRedis()
    const received: InboundMessage[] = []
    class Consumer {
      handle(payload: unknown, message: InboundMessage) {
        received.push({ ...message, payload })
      }
    }
    await startApp(driverFor(fake), [{ class: Consumer, queue: 'events', handlers: [handler('handle')] }])
    const entryId = fake.add('events', { body: '{"plain":true}', source: 'legacy', 'h:x-trace': 't' })
    await waitFor(() => received.length === 1, 'the foreign entry')
    expect(received[0]).toMatchObject({
      id: entryId,
      payload: { plain: true },
      type: undefined,
      headers: { source: 'legacy', 'x-trace': 't' },
      timestamp: Number(entryId.split('-')[0]),
    })
  })

  it('prefixes keys and trims the streams it writes to', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake, { prefix: 'app:', maxLength: 2 })
    await driver.connect({ logger: memoryLogger() })
    for (const id of ['1', '2', '3']) {
      await driver.publish('orders', {
        id,
        type: undefined,
        key: undefined,
        headers: {},
        body: id,
        contentType: 'text/plain',
        timestamp: 1,
        delayMs: 0,
      })
    }
    expect(fake.callsOf('XADD')[0]?.args.slice(0, 4)).toEqual(['app:orders', 'MAXLEN', '~', '2'])
    expect(fake.entries('app:orders').map(entry => entry.fields['id'])).toEqual(['2', '3'])
    await driver.close()
  })

  it('names the dead-letter stream <queue>.dlq', () => {
    expect(redis().deadLetterName('orders')).toBe('orders.dlq')
    expect(redis({ deadLetterName: queue => `dead-${queue}` }).deadLetterName('orders')).toBe('dead-orders')
  })
})

describe('consumer groups and flow control', () => {
  it('creates the group idempotently, per consumer when asked', async () => {
    const fake = new FakeRedis()
    const first = driverFor(fake, { group: 'billing' })
    await first.connect({ logger: memoryLogger() })
    const one = await first.subscribe('orders', () => Promise.resolve(), subscribeOptions)
    const two = await first.subscribe('orders', () => Promise.resolve(), subscribeOptions)
    const three = await first.subscribe('orders', () => Promise.resolve(), {
      ...subscribeOptions,
      options: { group: 'audit' },
    })
    expect(fake.callsOf('XGROUP').map(call => call.args[2])).toEqual(['billing', 'billing', 'audit'])
    for (const subscription of [one, two, three]) {
      await subscription.cancel()
      await subscription.close()
    }
    await first.close()
  })

  it('never holds more entries than the consumer concurrency', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { concurrency: 2 })
    for (let index = 0; index < 5; index++) fake.add('orders', { body: String(index) })
    await waitFor(() => received.length === 2, 'two deliveries')
    await sleep(100)
    expect(received).toHaveLength(2)
    for (const call of fake.callsOf('XREADGROUP')) {
      expect(Number(call.args[call.args.indexOf('COUNT') + 1])).toBeLessThanOrEqual(2)
    }
    await received[0]?.ack()
    await waitFor(() => received.length === 3, 'a third delivery once a slot is free')
    for (const delivery of received.slice(1)) await delivery.ack()
    await waitFor(() => received.length === 5, 'the rest')
    for (const delivery of received.slice(3)) await delivery.ack()
    expect(fake.pending('orders', 'znight')).toEqual([])
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('refuses a queue, a dead-letter stream or a delayed set holding another type (ZNIGHT011)', async () => {
    for (const key of ['orders', 'orders.dlq', 'orders:delayed']) {
      const fake = new FakeRedis()
      fake.set(key, 'oops')
      const driver = driverFor(fake)
      await driver.connect({ logger: memoryLogger() })
      const error = await caught(() =>
        driver.subscribe('orders', () => Promise.resolve(), { ...subscribeOptions, deadLetterQueue: 'orders.dlq' }),
      )
      expect(error).toBeInstanceOf(ZnightError)
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConsumer)
      expect((error as Error).message).toContain(`"${key}"`)
      await driver.close()
    }
  })

  it('reports an unreachable server when connecting', async () => {
    const fake = new FakeRedis()
    fake.failures = command => (command === 'PING' ? new Error('connect ECONNREFUSED') : undefined)
    const error = await caught(() => driverFor(fake).connect({ logger: memoryLogger() }))
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as Error).message).toContain('ECONNREFUSED')
  })

  it('keeps reading after a failed read', async () => {
    const fake = new FakeRedis()
    let failures = 1
    fake.failures = command =>
      command === 'XREADGROUP' && failures-- > 0 ? new FakeReplyError('LOADING Redis is loading') : undefined
    const logger = memoryLogger()
    const received: InboundMessage[] = []
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
      }
    }
    const { broker } = await startApp(
      driverFor(fake, { readErrorDelayMs: 10 }),
      [{ class: Consumer, queue: 'orders', handlers: [handler('handle')] }],
      logger,
    )
    await broker.publish('orders', 1)
    await waitFor(() => received.length === 1, 'the message after the failure')
    expect(logger.entries.some(entry => entry.message.includes('reading "orders" failed'))).toBe(true)
  })
})

describe('settlements', () => {
  it('acknowledges with XACK', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    await received[0]?.ack()
    expect(fake.callsOf('XACK')[0]?.args).toEqual(['orders', 'znight', expect.any(String)])
    expect(fake.pending('orders', 'znight')).toEqual([])
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('retries at once with an acknowledged copy carrying the next attempt', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { maxAttempts: 3 })
    fake.add('orders', { body: 'x', id: 'm-1', 'h:keep': 'me', 'h:x-znight-attempt': '1' })
    await waitFor(() => received.length === 1, 'the first delivery')
    await received[0]?.retry({ attempt: 2, delayMs: 0, error: new Error('boom') })
    await waitFor(() => received.length === 2, 'the copy')
    expect(received[1]).toMatchObject({ id: 'm-1', attempt: 2, redelivered: true, headers: { keep: 'me' } })
    expect(fake.entries('orders')[1]?.fields).toMatchObject({ 'h:x-znight-attempt': '2', 'h:keep': 'me' })
    await received[1]?.ack()
    expect(fake.pending('orders', 'znight')).toEqual([])
    // the copy and the acknowledgement are one script
    expect(fake.callsOf('EVALSHA').length + fake.callsOf('EVAL').length).toBeGreaterThan(0)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('schedules delayed retries in the delayed set and moves them back when due', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { maxAttempts: 3, retryDelays: [150] })
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the first delivery')
    const started = Date.now()
    await received[0]?.retry({ attempt: 2, delayMs: 150, error: new Error('boom') })
    expect(fake.delayed('orders:delayed')).toHaveLength(1)
    expect(fake.pending('orders', 'znight')).toEqual([])
    await waitFor(() => received.length === 2, 'the delayed copy')
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(received[1]?.attempt).toBe(2)
    expect(fake.delayed('orders:delayed')).toEqual([])
    await received[1]?.ack()
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('dead-letters to the dead-letter stream with the Znight headers, and acknowledges', async () => {
    const fake = new FakeRedis()
    const dead: InboundMessage[] = []
    class Failing {
      handle() {
        throw new NonRetryableError('bad order')
      }
    }
    class Collector {
      collect(_payload: unknown, message: InboundMessage) {
        dead.push(message)
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Failing, queue: 'orders', handlers: [handler('handle')] },
      { class: Collector, queue: 'orders.dlq', options: { deadLetter: false }, handlers: [handler('collect')] },
    ])
    await broker.publish('orders', { id: 1 }, { type: 'order.created', headers: { tenant: 'acme' } })
    await waitFor(() => dead.length === 1, 'the dead letter')
    expect(dead[0]).toMatchObject({
      type: 'order.created',
      payload: { id: 1 },
      headers: {
        tenant: 'acme',
        [MessagingHeaders.DeadLetterReason]: 'non-retryable',
        [MessagingHeaders.Error]: 'bad order',
        [MessagingHeaders.OriginalQueue]: 'orders',
        [MessagingHeaders.Attempts]: '1',
      },
    })
    await waitFor(() => fake.pending('orders', 'znight').length === 0, 'the acknowledgement')
  })

  it('discards a message when dead-lettering is disabled', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    await received[0]?.deadLetter({ queue: undefined, reason: 'no-handler', error: new Error('x'), attempt: 1 })
    expect(fake.pending('orders', 'znight')).toEqual([])
    expect(fake.entries('orders')).toHaveLength(1)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('releases with a copy keeping the attempt, redelivered at once', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x', 'h:x-znight-attempt': '2' })
    await waitFor(() => received.length === 1, 'the delivery')
    await received[0]?.release()
    await waitFor(() => received.length === 2, 'the released copy')
    expect(received[1]?.attempt).toBe(2)
    await received[1]?.ack()
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('does not copy an entry that is no longer pending (settled elsewhere)', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    const entryId = fake.pending('orders', 'znight')[0]?.id ?? ''
    await fake.connection().call('XACK', 'orders', 'znight', entryId)
    await received[0]?.retry({ attempt: 2, delayMs: 0, error: new Error('x') })
    expect(fake.entries('orders')).toHaveLength(1)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('refuses a second settlement, but allows release() after a failed one', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    const delivery = received[0] as DriverDelivery
    fake.failures = command => (command === 'XACK' ? new Error('READONLY') : undefined)
    expect(await caught(() => delivery.ack())).toBeInstanceOf(Error)
    fake.failures = () => undefined
    await delivery.release()
    expect(await caught(() => delivery.ack())).toBeInstanceOf(Error)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('falls back to EVAL when the server does not know a script', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { maxAttempts: 2 })
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    await received[0]?.retry({ attempt: 2, delayMs: 0, error: new Error('x') })
    await waitFor(() => received.length === 2, 'the copy')
    await received[1]?.retry({ attempt: 3, delayMs: 0, error: new Error('x') })
    // first EVALSHA answered NOSCRIPT, then EVAL loaded the script, then EVALSHA succeeded
    expect(fake.callsOf('EVAL')).toHaveLength(1)
    expect(fake.callsOf('EVALSHA').length).toBeGreaterThanOrEqual(2)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('waits for replicas after every write when asked, and fails below the count', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake, { replicas: { count: 1, timeoutMs: 100 } })
    await driver.connect({ logger: memoryLogger() })
    const message = {
      id: '1',
      type: undefined,
      key: undefined,
      headers: {},
      body: 'x',
      contentType: 'text/plain',
      timestamp: 1,
      delayMs: 0,
    }
    const error = await caught(() => driver.publish('orders', message))
    expect((error as Error).message).toContain('0 of 1 replica')
    fake.replicas = 1
    await driver.publish('orders', message)
    expect(fake.callsOf('WAIT').map(call => call.args)).toEqual([
      ['1', '100'],
      ['1', '100'],
    ])
    await driver.close()
  })
})

describe('delayed publishing', () => {
  it('schedules delayed publications in the delayed set of the stream', async () => {
    const fake = new FakeRedis()
    const received: number[] = []
    class Consumer {
      handle() {
        received.push(Date.now())
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    const started = Date.now()
    await broker.publish('orders', 1, { delay: 200 })
    expect(fake.delayed('orders:delayed')).toHaveLength(1)
    await waitFor(() => received.length === 1, 'the delayed message')
    expect((received[0] ?? 0) - started).toBeGreaterThanOrEqual(190)
  })

  it('moves the delayed publications of a queue it only publishes to', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    await driver.publish('audit', {
      id: '1',
      type: undefined,
      key: undefined,
      headers: {},
      body: 'x',
      contentType: 'text/plain',
      timestamp: 1,
      delayMs: 30,
    })
    expect(fake.entries('audit')).toEqual([])
    await waitFor(() => fake.entries('audit').length === 1, 'the moved entry')
    await driver.close()
  })
})

describe('crashed consumers', () => {
  it('claims entries left pending by a crashed consumer, counting the deliveries as attempts', async () => {
    const fake = new FakeRedis()
    // a consumer of the group read the entry, then crashed
    const crashed = fake.connection()
    await crashed.call('XGROUP', 'CREATE', 'orders', 'znight', '0', 'MKSTREAM')
    fake.add('orders', { body: '{}', id: 'm-1' })
    await crashed.call('XREADGROUP', 'GROUP', 'znight', 'crashed-1', 'COUNT', '1', 'STREAMS', 'orders', '>')
    const received: InboundMessage[] = []
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
      }
    }
    await startApp(driverFor(fake, { claimIdleMs: 100 }), [
      {
        class: Consumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 0 } })],
      },
    ])
    await waitFor(() => received.length === 1, 'the claimed entry')
    expect(received[0]).toMatchObject({ id: 'm-1', attempt: 2, redelivered: true })
    expect(fake.callsOf('XAUTOCLAIM')[0]?.args.slice(0, 4)).toEqual(['orders', 'znight', expect.any(String), '100'])
    await waitFor(() => fake.pending('orders', 'znight').length === 0, 'the acknowledgement')
  })

  it('keeps the entries of long-running handlers claimed (XCLAIM JUSTID heartbeat)', async () => {
    const fake = new FakeRedis()
    const received: InboundMessage[] = []
    class Slow {
      async handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
        await sleep(400)
      }
    }
    const first = driverFor(fake, { claimIdleMs: 150 })
    const second = driverFor(fake, { claimIdleMs: 150 })
    const { broker } = await startApp(first, [{ class: Slow, queue: 'orders', handlers: [handler('handle')] }])
    await startApp(second, [{ class: Slow, queue: 'orders', handlers: [handler('handle')] }])
    await broker.publish('orders', 1)
    await sleep(600)
    expect(received).toHaveLength(1)
    expect(fake.callsOf('XCLAIM').some(call => call.args.includes('JUSTID'))).toBe(true)
  })
})

describe('shutdown', () => {
  it('unblocks the blocking read, releases what it read late, retires the consumer and quits its connections', async () => {
    const fake = new FakeRedis()
    const client = fake.connection()
    const driver = redis({ client: client as unknown as Redis, blockMs: 10_000 })
    await driver.connect({ logger: memoryLogger() })
    const subscription = await driver.subscribe('orders', () => Promise.resolve(), subscribeOptions)
    await waitFor(() => fake.callsOf('XREADGROUP').length === 1, 'the blocking read')
    const started = Date.now()
    await subscription.cancel()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(fake.callsOf('CLIENT').map(call => call.args[0])).toEqual(['ID', 'UNBLOCK'])
    await subscription.close()
    expect(fake.consumers('orders', 'znight')).toEqual([])
    await driver.close()
    // the blocking connection is the driver's, the client is the application's
    const blocking = [...fake.connections.values()].filter(connection => connection !== client)
    expect(blocking.every(connection => connection.quits === 1)).toBe(true)
    expect(client.quits).toBe(0)
  })

  it('quits the client it created from a URL only', async () => {
    const fake = new FakeRedis()
    const client = fake.connection()
    const driver = redis({ client: client as unknown as Redis })
    await driver.connect({ logger: memoryLogger() })
    await driver.close()
    await driver.close()
    expect(client.quits).toBe(0)
    expect(await caught(() => driver.connect({ logger: memoryLogger() }))).toBeInstanceOf(ZnightError)
  })

  it('keeps the consumer in the group while it has pending entries', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    fake.failures = command => (command === 'EVALSHA' || command === 'EVAL' ? new Error('down') : undefined)
    expect(await caught(() => (received[0] as DriverDelivery).release())).toBeInstanceOf(Error)
    await subscription.cancel()
    await subscription.close()
    fake.failures = () => undefined
    expect(fake.consumers('orders', 'znight')).toHaveLength(1)
    expect(fake.pending('orders', 'znight')).toHaveLength(1)
    await driver.close()
  })
})

describe('options and capabilities', () => {
  it('declares its capabilities', () => {
    expect(redis().capabilities).toEqual({
      nativeDelay: true,
      maxNativeDelayMs: Number.POSITIVE_INFINITY,
      maxInProcessDelayMs: 1000,
      deliveryCount: 'header',
      maxPublishDelayMs: Number.POSITIVE_INFINITY,
    })
    expect(redis({ maxInProcessDelayMs: 0 }).capabilities.maxInProcessDelayMs).toBe(0)
  })

  it('validates its options', () => {
    expect(() => redis({ maxLength: 0 })).toThrow('maxLength')
    expect(() => redis({ deadLetterMaxLength: -1 })).toThrow('deadLetterMaxLength')
    expect(() => redis({ claimIdleMs: -1 })).toThrow('claimIdleMs')
    expect(() => redis({ blockMs: Number.NaN })).toThrow('blockMs')
    expect(() => redis({ group: '' })).toThrow('group')
    expect(() => redis({ replicas: { count: 0 } })).toThrow('replicas')
    expect(() => redis({ url: 'redis://x', client: {} as Redis })).toThrow('either')
  })

  it('refuses an invalid consumer group option', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    const error = await caught(() =>
      driver.subscribe('orders', () => Promise.resolve(), { ...subscribeOptions, options: { group: 42 } }),
    )
    expect(error).toBeInstanceOf(ZnightError)
    await driver.close()
  })
})

// the conformance scenarios, against the in-memory Redis (the real server: test/integration/redis.test.ts)
const server = new FakeRedis()
describeDriverConformance({
  name: 'redis (fake server)',
  driver: overrides => driverFor(server, { claimIdleMs: 5000, ...overrides }),
  test: { describe, it },
  nativeDelayMs: 200,
  timeoutMs: 15_000,
})
