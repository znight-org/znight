/**
 * Redis Streams driver against an in-memory Redis (`fake-redis.ts`, passed as the ioredis client):
 * the wire format, consumer groups (fan-out with retries), flow control, settlements (scripts), the
 * delayed sets, reclaiming the entries of crashed consumers, housekeeping (trimming, idle consumers),
 * reconnections, shutdown, and the conformance kit. The Lua scripts and the
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
    await waitFor(() => fake.pending('orders', 'znight').length === 0, 'the acknowledgement')
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

  it('reads RESP3 replies (a map of streams, flattened by ioredis)', async () => {
    const fake = new FakeRedis()
    fake.resp3 = true
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x', id: 'm-3' })
    await waitFor(() => received.length === 1, 'the delivery')
    expect(received[0]?.id).toBe('m-3')
    await received[0]?.ack()
    await subscription.cancel()
    await subscription.close()
    await driver.close()
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
    expect(fake.callsOf('XGROUP').map(call => call.args.slice(1, 3))).toEqual([
      ['orders', 'billing'],
      ['orders:retry:billing', 'billing'],
      ['orders', 'billing'],
      ['orders:retry:billing', 'billing'],
      ['orders', 'audit'],
      ['orders:retry:audit', 'audit'],
    ])
    for (const subscription of [one, two, three]) {
      await subscription.cancel()
      await subscription.close()
    }
    await first.close()
  })

  it('keeps the retries of a group to that group: the other groups of a fan-out see the message once', async () => {
    const fake = new FakeRedis()
    const billing: InboundMessage[] = []
    const shipping: InboundMessage[] = []
    class Billing {
      handle(_payload: unknown, message: InboundMessage) {
        billing.push(message)
        if (message.attempt === 1) throw new Error('billing is down')
      }
    }
    class Shipping {
      handle(_payload: unknown, message: InboundMessage) {
        shipping.push(message)
        if (message.attempt === 1) throw new Error('shipping is down')
      }
    }
    const retry = { attempts: 3, backoff: 'fixed', delay: 0 } as const
    // two services, one group each
    const { broker } = await startApp(driverFor(fake, { maxInProcessDelayMs: 0 }), [
      { class: Billing, queue: 'orders', options: { group: 'billing' }, handlers: [handler('handle', { retry })] },
    ])
    await startApp(driverFor(fake, { maxInProcessDelayMs: 0 }), [
      { class: Shipping, queue: 'orders', options: { group: 'shipping' }, handlers: [handler('handle', { retry })] },
    ])
    await broker.publish('orders', { id: 1 })
    await waitFor(() => billing.length === 2 && shipping.length === 2, 'one retry per group')
    await sleep(150)
    expect(billing.map(message => message.attempt)).toEqual([1, 2])
    expect(shipping.map(message => message.attempt)).toEqual([1, 2])
    // the copies went to the retry stream of each group, never to the shared queue stream
    expect(fake.entries('orders')).toHaveLength(1)
    expect(fake.entries('orders:retry:billing')).toHaveLength(1)
    expect(fake.entries('orders:retry:shipping')).toHaveLength(1)
    expect(fake.pending('orders:retry:billing', 'billing')).toEqual([])
    expect(fake.pending('orders:retry:shipping', 'shipping')).toEqual([])
  })

  it('reads the queue stream and the retry stream, holding extra entries until a slot is free', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { maxAttempts: 3 })
    fake.add('orders', { body: 'first', id: 'm-1' })
    await waitFor(() => received.length === 1, 'the first delivery')
    // a released copy (retry stream) and a new entry (queue stream) are read together, one slot only
    fake.add('orders', { body: 'second', id: 'm-2' })
    await received[0]?.release()
    await waitFor(() => received.length === 2, 'the second delivery')
    await sleep(80)
    expect(received).toHaveLength(2)
    await received[1]?.ack()
    await waitFor(() => received.length === 3, 'the entry held back')
    expect(received.map(delivery => delivery.id).sort()).toEqual(['m-1', 'm-1', 'm-2'])
    await received[2]?.ack()
    expect(fake.pending('orders', 'znight')).toEqual([])
    expect(fake.pending('orders:retry:znight', 'znight')).toEqual([])
    await subscription.cancel()
    await subscription.close()
    await driver.close()
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
    for (const key of [
      'orders',
      'orders.dlq',
      'orders:delayed',
      'orders:retry:znight',
      'orders:retry:znight:delayed',
    ]) {
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

  it('refuses servers older than Redis 7.0, and connects when INFO is not allowed', async () => {
    const old = new FakeRedis()
    old.version = '6.2.14'
    const error = await caught(() => driverFor(old).connect({ logger: memoryLogger() }))
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as Error).message).toContain('Redis 7.0 or later')
    const restricted = new FakeRedis()
    restricted.failures = command => (command === 'INFO' ? new FakeReplyError('NOPERM no permissions') : undefined)
    const driver = driverFor(restricted)
    await driver.connect({ logger: memoryLogger() })
    await driver.close()
    const valkey = new FakeRedis()
    valkey.version = '7.2.4'
    const current = driverFor(valkey)
    await current.connect({ logger: memoryLogger() })
    await current.close()
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
    expect(received[1]?.raw).toMatchObject({ stream: 'orders:retry:znight', group: 'znight' })
    expect(fake.entries('orders')).toHaveLength(1)
    expect(fake.entries('orders:retry:znight')[0]?.fields).toMatchObject({ 'h:x-znight-attempt': '2', 'h:keep': 'me' })
    await received[1]?.ack()
    expect(fake.pending('orders', 'znight')).toEqual([])
    expect(fake.pending('orders:retry:znight', 'znight')).toEqual([])
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
    expect(fake.delayed('orders:retry:znight:delayed')).toHaveLength(1)
    expect(fake.pending('orders', 'znight')).toEqual([])
    await waitFor(() => received.length === 2, 'the delayed copy')
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(received[1]?.attempt).toBe(2)
    expect(fake.delayed('orders:retry:znight:delayed')).toEqual([])
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
    expect(fake.entries('orders:retry:znight')).toEqual([])
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
    await waitFor(() => received.length === 2, 'the released copy')
    await received[1]?.ack()
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
    await waitFor(() => received.length === 3, 'the second copy')
    await received[2]?.ack()
    // first EVALSHA answered NOSCRIPT, then EVAL loaded the script, then EVALSHA succeeded
    const isMove = (call: { args: readonly string[] }) => call.args[0]?.startsWith('-- znight:move') === true
    expect(fake.callsOf('EVAL').filter(isMove)).toHaveLength(1)
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

describe('housekeeping', () => {
  it('trims what every group acknowledged, never what a group still has to read or settle', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake, { claimIdleMs: 40 })
    const { received, subscription } = await deliveries(driver, 'orders', { concurrency: 3 })
    // a second group that has read nothing yet holds every entry
    await fake.connection().call('XGROUP', 'CREATE', 'orders', 'audit', '0')
    for (const index of [1, 2, 3]) fake.add('orders', { body: String(index) })
    await waitFor(() => received.length === 3, 'three deliveries')
    for (const delivery of received) await delivery.ack()
    await sleep(100)
    expect(fake.entries('orders')).toHaveLength(3)
    // the second group reads the first two and settles one: the second one is still pending
    const audit = fake.connection()
    await audit.call('XREADGROUP', 'GROUP', 'audit', 'a-1', 'COUNT', '2', 'STREAMS', 'orders', '>')
    const [first, second] = fake.pending('orders', 'audit')
    await audit.call('XACK', 'orders', 'audit', first?.id ?? '')
    await waitFor(() => fake.entries('orders').length === 2, 'the first entry trimmed')
    expect(fake.entries('orders')[0]?.id).toBe(second?.id ?? '')
    expect(fake.callsOf('EVAL').some(call => call.args[0]?.startsWith('-- znight:trim'))).toBe(true)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('keeps the acknowledged entries of the queue streams with keepAcknowledged, not of the retry streams', async () => {
    const fake = new FakeRedis()
    const driver = driverFor(fake, { claimIdleMs: 40, keepAcknowledged: true })
    const { received, subscription } = await deliveries(driver, 'orders', { maxAttempts: 2 })
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    await received[0]?.retry({ attempt: 2, delayMs: 0, error: new Error('x') })
    await waitFor(() => received.length === 2, 'the retry')
    await received[1]?.ack()
    await waitFor(() => fake.entries('orders:retry:znight').length === 0, 'the retry stream trimmed')
    expect(fake.entries('orders')).toHaveLength(1)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('removes the consumers of crashed processes idle without pending entries', async () => {
    const fake = new FakeRedis()
    // a long blocking read: the consumer of this process is not seen again during the test
    const driver = driverFor(fake, { claimIdleMs: 40, blockMs: 10_000, consumerName: 'me' })
    const { received, subscription } = await deliveries(driver, 'orders')
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    await received[0]?.ack()
    // idle for ten times max(claimIdleMs, blockMs) (100 s here): removed; recently seen, or a consumer
    // of this process: kept
    fake.idleConsumer('orders', 'znight', 'crashed-old', 600_000)
    fake.idleConsumer('orders', 'znight', 'crashed-recent', 0)
    fake.idleConsumer('orders', 'znight', 'me-1', 600_000)
    fake.idleConsumer('orders:retry:znight', 'znight', 'crashed-old', 600_000)
    await waitFor(() => !fake.consumers('orders', 'znight').includes('crashed-old'), 'the idle consumer removed')
    expect(fake.consumers('orders:retry:znight', 'znight')).not.toContain('crashed-old')
    expect(fake.consumers('orders', 'znight').sort()).toEqual(['crashed-recent', 'me-1'])
    expect(fake.callsOf('EVAL').some(call => call.args[0]?.startsWith('-- znight:reap'))).toBe(true)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('logs a failed housekeeping run once, and keeps going', async () => {
    const fake = new FakeRedis()
    const logger = memoryLogger()
    const driver = driverFor(fake, { claimIdleMs: 20 })
    await driver.connect({ logger })
    const subscription = await driver.subscribe('orders', () => Promise.resolve(), subscribeOptions)
    fake.failures = command => (command === 'EVALSHA' || command === 'EVAL' ? new FakeReplyError('BUSY') : undefined)
    await sleep(120)
    fake.failures = () => undefined
    const warnings = logger.entries.filter(entry => entry.message.includes('housekeeping failed'))
    expect(warnings.filter(entry => entry.level === 'warn')).toHaveLength(1)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })
})

describe('reconnections', () => {
  async function blockingRead(fake: FakeRedis) {
    const client = fake.connection()
    const driver = redis({ client: client as unknown as Redis, blockMs: 300 })
    const received: DriverDelivery[] = []
    await driver.connect({ logger: memoryLogger() })
    const subscription = await driver.subscribe(
      'orders',
      async delivery => {
        received.push(delivery)
        await delivery.ack()
      },
      subscribeOptions,
    )
    await waitFor(() => fake.callsOf('XREADGROUP').length === 1, 'the blocking read')
    const reading = fake.connections.get(fake.callsOf('XREADGROUP')[0]?.connection ?? 0)
    if (reading === undefined) throw new Error('no reading connection')
    return { driver, subscription, reading, received }
  }

  it('never unblocks a stale client id after a reconnection, and reads the new one', async () => {
    const fake = new FakeRedis()
    const { driver, subscription, reading, received } = await blockingRead(fake)
    const stale = reading.id
    // the server restarted: the reading connection got another id, another client the old one
    reading.reconnect()
    fake.connection(stale)
    // the resent read returns, then the next read starts with a fresh CLIENT ID
    fake.add('orders', { body: 'x' })
    await waitFor(() => received.length === 1, 'the delivery')
    await waitFor(() => fake.callsOf('XREADGROUP').length === 2, 'the next blocking read')
    const started = Date.now()
    await subscription.cancel()
    expect(Date.now() - started).toBeLessThan(250)
    const ids = fake.callsOf('CLIENT').filter(call => call.args[0] === 'ID')
    expect(ids).toHaveLength(2)
    const unblocked = fake.callsOf('CLIENT').filter(call => call.args[0] === 'UNBLOCK')
    expect(unblocked.length).toBeGreaterThan(0)
    expect(unblocked.every(call => call.args[1] === String(reading.id))).toBe(true)
    await subscription.close()
    await driver.close()
  })

  it('waits for a read resent after a reconnection instead of unblocking an unknown client', async () => {
    const fake = new FakeRedis()
    const { driver, subscription, reading } = await blockingRead(fake)
    reading.reconnect()
    const started = Date.now()
    await subscription.cancel()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(fake.callsOf('CLIENT').filter(call => call.args[0] === 'UNBLOCK')).toEqual([])
    await subscription.close()
    await driver.close()
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
    const client_ = fake.callsOf('CLIENT').map(call => call.args[0])
    expect(client_[0]).toBe('ID')
    expect(client_).toContain('UNBLOCK')
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
