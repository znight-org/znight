/**
 * NATS JetStream driver against an in-memory JetStream (`fake-nats.ts`, passed as the connection and
 * the JetStream context): subjects, streams and durable consumers, headers, settlements (double ack,
 * `nak(delay)`, `term()`), native attempts, the ack-wait extension, verification and provisioning,
 * max-deliver advisories, back-pressure, shutdown, and the conformance kit. The behaviour against a
 * real server is covered by `test/integration/nats.test.ts`.
 */
import type { InboundMessage, MessagingDriver } from '../../src/index.ts'
import type { TestConsumer } from '../helpers.ts'

import { headers as natsHeaders } from '@nats-io/transport-node'
import { Application } from '@znight/core'

import { type NatsDriverOptions, nats } from '../../src/drivers/nats.ts'
import { MessageBroker, MessagingHeaders, MessagingPlugin, NonRetryableError } from '../../src/index.ts'
import { describeDriverConformance } from '../../src/testing.ts'
import { caught, handler, memoryLogger, messageOf, messagingMetadata, sleep } from '../helpers.ts'
import { FakeNats } from './fake-nats.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const NANOS_PER_MS = 1_000_000

function driverFor(fake: FakeNats, options: Partial<NatsDriverOptions> = {}): MessagingDriver {
  return nats({ connection: fake.connection, jetstream: fake.jetstream, fetchExpiresMs: 1000, ...options })
}

/** A stream per queue and per dead-letter queue (`orders`, `orders_dlq` capturing `orders.dlq`). */
function fakeWithQueues(...queues: string[]): FakeNats {
  const fake = new FakeNats()
  for (const queue of queues) {
    fake.createStream(queue.replaceAll('.', '_'), [queue])
    fake.createStream(`${queue.replaceAll('.', '_')}_dlq`, [`${queue}.dlq`])
  }
  return fake
}

let apps: Application[] = []

afterEach(async () => {
  const running = apps
  apps = []
  for (const app of running.reverse()) await app.stop()
})

async function startApp(driver: MessagingDriver, consumers: readonly TestConsumer[], logger = memoryLogger()) {
  const app = await Application.create({
    metadata: messagingMetadata(consumers),
    plugins: [MessagingPlugin.configure({ driver, defaults: { requeueDelay: 20 } })],
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

/** A consumer recording the messages it receives. */
function collector(queue: string, extra: Partial<TestConsumer> = {}) {
  const received: InboundMessage[] = []
  class Collector {
    handle(_payload: unknown, message: InboundMessage) {
      received.push(message)
    }
  }
  const consumer: TestConsumer = { class: Collector, queue, handlers: [handler('handle')], ...extra }
  return { received, consumer }
}

describe('names', () => {
  it('publishes to the subject of the queue and reads a durable pull consumer on the stream capturing it', async () => {
    const fake = fakeWithQueues('orders')
    const { received, consumer } = collector('orders')
    const { broker } = await startApp(driverFor(fake), [consumer])
    await broker.publish('orders', { id: 1 })
    await waitFor(() => received.length === 1, 'the message')
    expect(fake.callsOf('publish')[0]).toMatchObject({ subject: 'orders' })
    expect(fake.callsOf('streams.find')).toContain('orders')
    expect(fake.consumer('orders', 'znight-orders')?.config).toMatchObject({
      durable_name: 'znight-orders',
      filter_subject: 'orders',
      ack_policy: 'explicit',
      max_deliver: -1,
      ack_wait: 30_000 * NANOS_PER_MS,
    })
    expect(received[0]).toMatchObject({ queue: 'orders', driver: 'nats', attempt: 1, redelivered: false })
  })

  it('maps subjects, streams and durable names', async () => {
    const fake = new FakeNats()
    fake.createStream('EVENTS', ['events.>'])
    fake.createStream('DEAD', ['dead.>'])
    const { received, consumer } = collector('notifications', { options: { durable: 'notifier' } })
    const driver = driverFor(fake, {
      subjects: { notifications: 'events.notifications', 'notifications.dlq': 'dead.notifications' },
      streams: queue => (queue === 'notifications' ? 'EVENTS' : undefined),
    })
    const { broker } = await startApp(driver, [consumer])
    await broker.publish('notifications', 'hello')
    await waitFor(() => received.length === 1, 'the notification')
    expect(fake.callsOf('publish')[0]).toMatchObject({ subject: 'events.notifications' })
    expect(fake.consumer('EVENTS', 'notifier')?.config.filter_subject).toBe('events.notifications')
    expect(fake.callsOf('streams.info')).toContain('EVENTS')
    expect(received[0]?.payload).toBe('hello')
  })

  it('derives valid durable names from the prefix and the queue', async () => {
    const fake = fakeWithQueues('orders.created')
    const { consumer } = collector('orders.created')
    await startApp(driverFor(fake, { durablePrefix: 'billing' }), [consumer])
    expect(fake.consumer('orders_created', 'billing-orders_created')).toBeDefined()
  })

  it('names the dead-letter subject <queue>.dlq', () => {
    expect(driverFor(new FakeNats()).deadLetterName('orders')).toBe('orders.dlq')
    expect(driverFor(new FakeNats(), { deadLetterName: queue => `dead.${queue}` }).deadLetterName('orders')).toBe(
      'dead.orders',
    )
  })
})

describe('messages', () => {
  it('round-trips the body, the transport headers, the application headers and the key', async () => {
    const fake = fakeWithQueues('orders')
    const { received, consumer } = collector('orders')
    const { broker } = await startApp(driverFor(fake), [consumer])
    const before = Date.now()
    const { id } = await broker.publish(
      'orders',
      { id: 1 },
      { type: 'order.created', key: 'customer-1', headers: { 'x-tenant': 'acme', traceparent: '00-a-b-01' } },
    )
    await broker.publish('orders', new Uint8Array([0, 255, 7]))
    await waitFor(() => received.length === 2, 'both messages')
    const published = fake.callsOf('publish')[0]
    expect(published.options.msgID).toBe(id)
    expect(new TextDecoder().decode(published.data)).toBe('{"id":1}')
    expect(FakeNats.headersOf(fake.messages('orders')[0] ?? { headers: undefined })).toMatchObject({
      [MessagingHeaders.Id]: id,
      [MessagingHeaders.Type]: 'order.created',
      'content-type': 'application/json',
      'x-znight-key': 'customer-1',
      'x-tenant': 'acme',
      traceparent: '00-a-b-01',
      'Nats-Msg-Id': id,
    })
    const [first, binary] = received
    expect(first).toMatchObject({ id, type: 'order.created', key: 'customer-1', payload: { id: 1 } })
    // transport headers and the JetStream headers (Nats-*) are not application headers
    expect(first?.headers).toEqual({ 'x-tenant': 'acme', traceparent: '00-a-b-01' })
    expect(first?.contentType).toStartWith('application/json')
    expect(first?.timestamp).toBeGreaterThanOrEqual(before)
    expect([...((binary?.payload ?? []) as Uint8Array)]).toEqual([0, 255, 7])
    expect(binary?.key).toBeUndefined()
  })

  it('falls back to <stream>:<sequence> for messages published without a Znight id', async () => {
    const fake = fakeWithQueues('orders')
    const { received, consumer } = collector('orders')
    await startApp(driverFor(fake), [consumer])
    await fake.jetstream.publish('orders', new TextEncoder().encode('raw'))
    await waitFor(() => received.length === 1, 'the raw message')
    expect(received[0]).toMatchObject({ id: 'orders:1', type: undefined, headers: {} })
  })

  it('refuses delayed publications and headers JetStream cannot carry', async () => {
    const fake = fakeWithQueues('orders')
    const { broker } = await startApp(driverFor(fake), [])
    expect(messageOf(await caught(broker.publish('orders', 1, { delay: 1000 })))).toContain(
      'does not support delayed publishing',
    )
    expect(messageOf(await caught(broker.publish('orders', 1, { headers: { 'x-bad': 'a\nb' } })))).toContain(
      'cannot carry',
    )
    expect(fake.callsOf('publish')).toHaveLength(0)
  })
})

describe('publishing', () => {
  it('fails when no stream captures the subject, naming the fixes', async () => {
    const fake = new FakeNats()
    const { broker } = await startApp(driverFor(fake), [])
    const error = await caught(broker.publish('orders', 1))
    expect(error).toMatchObject({ code: 'ZNIGHT011' })
    expect(messageOf(error)).toContain('no stream captures the subject "orders"')
  })

  it('creates the stream of a published subject with provision: true', async () => {
    const fake = new FakeNats()
    const driver = driverFor(fake, { provision: true, streamConfig: { max_age: 60_000 * NANOS_PER_MS } })
    const { broker } = await startApp(driver, [])
    await broker.publish('orders.created', 1)
    expect(fake.callsOf('streams.add')[0]).toMatchObject({
      name: 'orders_created',
      subjects: ['orders.created'],
      max_age: 60_000 * NANOS_PER_MS,
    })
    expect(fake.messages('orders_created')).toHaveLength(1)
  })
})

describe('settlements', () => {
  it('acknowledges with a confirmed double ack', async () => {
    const fake = fakeWithQueues('orders')
    const { received, consumer } = collector('orders')
    const { broker } = await startApp(driverFor(fake), [consumer])
    await broker.publish('orders', 1)
    await waitFor(() => fake.callsOf('ackAck').length === 1, 'the ack')
    expect(received).toHaveLength(1)
    expect(fake.callsOf('ack')).toHaveLength(0)
  })

  it('retries with nak(delay): attempts are the JetStream delivery count', async () => {
    const fake = fakeWithQueues('orders')
    const attempts: number[] = []
    class Flaky {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        if (message.attempt < 3) throw new Error('transient')
      }
    }
    // the first retry waits in-process (then nak at once), the second one is a native nak delay
    const { broker } = await startApp(driverFor(fake, { maxInProcessDelayMs: 50 }), [
      {
        class: Flaky,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'exponential', delay: 40 } })],
      },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => attempts.length === 3, 'three attempts')
    expect(attempts).toEqual([1, 2, 3])
    // an explicit delay every time, so that a consumer backoff never adds to the @Retry delay
    expect(fake.callsOf('nak').map(call => call.millis)).toEqual([1, 80])
    expect(fake.callsOf('flush').length).toBeGreaterThanOrEqual(2)
  })

  it('dead-letters by publishing a deduplicated copy to <queue>.dlq, then terminating the original', async () => {
    const fake = fakeWithQueues('orders')
    class Failing {
      handle() {
        throw new NonRetryableError('permanent\nfailure')
      }
    }
    const { received, consumer } = collector('orders.dlq', { options: { deadLetter: false } })
    const { broker } = await startApp(driverFor(fake), [
      { class: Failing, queue: 'orders', handlers: [handler('handle')] },
      consumer,
    ])
    await broker.publish('orders', { id: 1 }, { type: 'a', key: 'k', headers: { keep: 'me' } })
    await waitFor(() => received.length === 1, 'the dead letter')
    const dead = received[0]
    expect(dead).toMatchObject({ type: 'a', key: 'k', attempt: 1, payload: { id: 1 } })
    expect(dead?.headers).toMatchObject({
      keep: 'me',
      [MessagingHeaders.DeadLetterReason]: 'non-retryable',
      [MessagingHeaders.Error]: 'permanent failure',
      [MessagingHeaders.OriginalQueue]: 'orders',
      [MessagingHeaders.Attempts]: '1',
    })
    const copy = fake.callsOf('publish')[1]
    expect(copy).toMatchObject({ subject: 'orders.dlq', options: { msgID: 'znight-dlq-orders-znight-orders-1' } })
    const term = fake.callsOf('term')[0]
    expect(term).toMatchObject({ stream: 'orders', seq: 1 })
    expect(term.reason).toContain('non-retryable')
    expect(fake.calls.findIndex(call => call.method === 'term')).toBeGreaterThan(
      fake.calls.findIndex(call => call.method === 'publish' && call.args.subject === 'orders.dlq'),
    )
  })

  it('keeps the dead letter of each consumer of a stream (fan-out with one durable prefix per service)', async () => {
    const fake = fakeWithQueues('orders')
    class Failing {
      handle() {
        throw new NonRetryableError('poison')
      }
    }
    const failing: TestConsumer = { class: Failing, queue: 'orders', handlers: [handler('handle')] }
    const { broker } = await startApp(driverFor(fake, { durablePrefix: 'billing' }), [failing])
    await startApp(driverFor(fake, { durablePrefix: 'shipping' }), [failing])
    await broker.publish('orders', 1)
    await waitFor(() => fake.callsOf('term').length === 2, 'both terms')
    expect(fake.messages('orders_dlq')).toHaveLength(2)
    expect([...(fake.streams.get('orders_dlq')?.msgIds ?? [])].sort()).toEqual([
      'znight-dlq-orders-billing-orders-1',
      'znight-dlq-orders-shipping-orders-1',
    ])
  })

  it('terminates without a copy when dead-lettering is disabled', async () => {
    const fake = fakeWithQueues('orders')
    class Failing {
      handle() {
        throw new NonRetryableError('permanent')
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Failing, queue: 'orders', options: { deadLetter: false }, handlers: [handler('handle')] },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => fake.callsOf('term').length === 1, 'the term')
    expect(fake.callsOf('publish')).toHaveLength(1)
  })

  it('gives the message back (nak) when the dead-letter copy cannot be published', async () => {
    const fake = fakeWithQueues('orders')
    fake.failures = (method, args) =>
      method === 'publish' && args.subject === 'orders.dlq' ? new Error('stream unavailable') : undefined
    class Failing {
      handle() {
        throw new NonRetryableError('permanent')
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Failing, queue: 'orders', handlers: [handler('handle')] },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => fake.callsOf('nak').length >= 1, 'the release')
    expect(fake.callsOf('term')).toHaveLength(0)
    expect(fake.callsOf('nak')[0].millis).toBeUndefined()
  })

  it('extends the ack wait (working) while a handler runs', async () => {
    const fake = fakeWithQueues('orders')
    fake.createConsumer('orders', {
      durable_name: 'znight-orders',
      filter_subject: 'orders',
      ack_wait: 200 * NANOS_PER_MS,
    })
    const attempts: number[] = []
    class Slow {
      async handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        await sleep(600)
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Slow, queue: 'orders', options: { concurrency: 2 }, handlers: [handler('handle')] },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => fake.callsOf('ackAck').length === 1, 'the ack', 3000)
    expect(attempts).toEqual([1])
    expect(fake.callsOf('working').length).toBeGreaterThanOrEqual(3)
  })
})

describe('verification and provisioning', () => {
  it('fails to subscribe when no stream captures the subject', async () => {
    const { consumer } = collector('orders')
    const error = await caught(startApp(driverFor(new FakeNats()), [consumer]))
    expect(error).toMatchObject({ code: 'ZNIGHT011' })
    expect(messageOf(error)).toContain('no stream captures the subject "orders"')
  })

  it('fails to subscribe when no stream captures the dead-letter subject', async () => {
    const fake = new FakeNats()
    fake.createStream('orders')
    const { consumer } = collector('orders')
    expect(messageOf(await caught(startApp(driverFor(fake), [consumer])))).toContain(
      'no stream captures the dead-letter subject "orders.dlq"',
    )
  })

  it('fails to subscribe when a mapped stream does not capture the subject or the dead-letter subject', async () => {
    const cases: [NatsDriverOptions['streams'], string][] = [
      [{ orders: 'ORDERS' }, 'stream "ORDERS" does not capture the subject "orders"'],
      [() => 'EVENTS', 'stream "EVENTS" does not capture the dead-letter subject "orders.dlq"'],
    ]
    for (const [streams, expected] of cases) {
      const fake = new FakeNats()
      fake.createStream('ORDERS', ['orders.created'])
      fake.createStream('EVENTS', ['orders'])
      fake.createStream('orders_dlq', ['orders.dlq'])
      const { consumer } = collector('orders')
      const error = await caught(startApp(driverFor(fake, { streams }), [consumer]))
      expect(error).toMatchObject({ code: 'ZNIGHT011' })
      expect(messageOf(error)).toContain(expected)
    }
  })

  it('accepts a mapped stream that captures the subject through a wildcard, or is filled by sources', async () => {
    const fake = new FakeNats()
    fake.createStream('ORDERS', ['orders.>'])
    fake.createStream('AGGREGATE', []).config.sources = [{ name: 'ORDERS' }]
    const { consumer } = collector('orders.created')
    const { consumer: aggregated } = collector('orders.updated', {
      options: { stream: 'AGGREGATE', deadLetter: false },
    })
    await startApp(driverFor(fake, { streams: { 'orders.created': 'ORDERS', 'orders.created.dlq': 'ORDERS' } }), [
      consumer,
      aggregated,
    ])
    expect(fake.consumer('ORDERS', 'znight-orders_created')).toBeDefined()
    expect(fake.consumer('AGGREGATE', 'znight-orders_updated')).toBeDefined()
  })

  it('creates the streams of a consumer and of its dead letters with provision: true', async () => {
    const fake = new FakeNats()
    const { received, consumer } = collector('orders')
    const { broker } = await startApp(driverFor(fake, { provision: true }), [consumer])
    expect(fake.callsOf('streams.add').map(config => [config.name, config.subjects])).toEqual([
      ['orders', ['orders']],
      ['orders_dlq', ['orders.dlq']],
    ])
    await broker.publish('orders', 1)
    await waitFor(() => received.length === 1, 'the message')
  })

  it('applies consumerConfig and ackWaitMs to the consumers it creates', async () => {
    const fake = fakeWithQueues('orders')
    const { consumer } = collector('orders')
    await startApp(driverFor(fake, { ackWaitMs: 5000, consumerConfig: { max_ack_pending: 64 } }), [consumer])
    expect(fake.consumer('orders', 'znight-orders')?.config).toMatchObject({
      ack_wait: 5000 * NANOS_PER_MS,
      max_ack_pending: 64,
    })
  })

  it('refuses existing consumers it cannot settle or that would stop delivering before the last attempt', async () => {
    const cases: [object, string][] = [
      [{ deliver_subject: 'push.inbox' }, 'is a push consumer'],
      [{ ack_policy: 'none' }, "acknowledgement policy is 'none'"],
      [{ max_deliver: 2 }, 'stops delivering a message after 2 deliveries, but Flaky allows 3 attempt(s)'],
      [{ filter_subject: 'payments' }, 'filters "payments": Flaky reads "orders"'],
      [{ filter_subject: '' }, 'has no filter subject (it reads the whole stream): Flaky reads "orders"'],
      [{ filter_subjects: ['orders', 'payments'] }, 'filters "orders", "payments": Flaky reads "orders"'],
    ]
    for (const [config, expected] of cases) {
      const fake = fakeWithQueues('orders')
      fake.createConsumer('orders', { durable_name: 'znight-orders', filter_subject: 'orders', ...config })
      class Flaky {
        handle() {}
      }
      const error = await caught(
        startApp(driverFor(fake), [
          {
            class: Flaky,
            queue: 'orders',
            handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 10 } })],
          },
        ]),
      )
      expect(error).toMatchObject({ code: 'ZNIGHT011' })
      expect(messageOf(error)).toContain(expected)
    }
  })

  it('accepts an existing consumer filtering the subject through filter_subjects', async () => {
    const fake = fakeWithQueues('orders')
    fake.createConsumer('orders', { durable_name: 'znight-orders', filter_subjects: ['orders'] })
    const { consumer } = collector('orders')
    await startApp(driverFor(fake), [consumer])
    expect(fake.callsOf('consumers.add')).toEqual([])
  })

  it('refuses invalid consumer options', async () => {
    const fake = fakeWithQueues('orders')
    const { consumer } = collector('orders', { options: { durable: 'bad.name' } })
    expect(messageOf(await caught(startApp(driverFor(fake), [consumer])))).toContain(
      'the NATS option durable must be a consumer name',
    )
  })
})

describe('max-deliver advisories', () => {
  it('dead-letters a message JetStream stopped delivering (max_deliver), once per queue group', async () => {
    const fake = fakeWithQueues('orders')
    fake.createConsumer('orders', { durable_name: 'znight-orders', filter_subject: 'orders', max_deliver: 5 })
    const { received, consumer } = collector('orders.dlq', { options: { deadLetter: false } })
    const blocked: unknown[] = []
    class Stuck {
      handle(payload: unknown) {
        blocked.push(payload)
      }
    }
    const { logs } = await startApp(driverFor(fake), [
      { class: Stuck, queue: 'orders', handlers: [handler('handle')] },
      consumer,
    ])
    expect(fake.callsOf('subscribe')).toContainEqual({
      subject: '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.orders.znight-orders',
      queue: 'znight-advisories-orders-znight-orders',
    })
    // a message whose deliveries are exhausted, stored without going through the consumer
    fake.consumer('orders', 'znight-orders')?.states.set(1, {
      deliveries: 5,
      availableAt: 0,
      outstanding: 0,
      done: 'exhausted',
    })
    const headers = natsHeaders()
    headers.set('x-tenant', 'acme')
    await fake.jetstream.publish('orders', new TextEncoder().encode('"lost"'), { msgID: 'm-1', headers })
    fake.advisory('orders', 'znight-orders', 1, 5)
    await waitFor(() => received.length === 1, 'the dead letter of the advisory')
    expect(received[0]?.headers).toMatchObject({
      'x-tenant': 'acme',
      [MessagingHeaders.DeadLetterReason]: 'max-attempts',
      [MessagingHeaders.OriginalQueue]: 'orders',
      [MessagingHeaders.Attempts]: '5',
    })
    expect(fake.callsOf('publish').at(-1)?.options.msgID).toBe('znight-dlq-orders-znight-orders-1')
    expect(blocked).toEqual([])
    expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('max_deliver'))).toBe(true)
  })

  it('does not listen to advisories for consumers without max_deliver', async () => {
    const fake = fakeWithQueues('orders')
    const { consumer } = collector('orders')
    await startApp(driverFor(fake), [consumer])
    expect(fake.callsOf('subscribe')).toEqual([])
  })
})

describe('back-pressure and shutdown', () => {
  it('never fetches more messages than the free concurrency slots', async () => {
    const fake = fakeWithQueues('orders')
    let active = 0
    let max = 0
    let done = 0
    class Slow {
      async handle() {
        active++
        max = Math.max(max, active)
        await sleep(30)
        active--
        done++
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Slow, queue: 'orders', options: { concurrency: 3 }, handlers: [handler('handle')] },
    ])
    for (let index = 0; index < 10; index++) await broker.publish('orders', index)
    await waitFor(() => done === 10, 'ten messages')
    expect(max).toBe(3)
    expect(Math.max(...fake.callsOf('fetch').map(call => call.max_messages))).toBe(3)
    expect(fake.callsOf('fetch').every(call => call.expires === 1000)).toBe(true)
  })

  it('stops fetching on cancel and gives back what a stopped fetch still yields', async () => {
    const fake = fakeWithQueues('orders')
    const { received, consumer } = collector('orders')
    const { app, broker } = await startApp(driverFor(fake), [consumer])
    await broker.publish('orders', 1)
    await waitFor(() => received.length === 1, 'the message')
    await app.stop()
    const fetches = fake.callsOf('fetch').length
    await fake.jetstream.publish('orders', new TextEncoder().encode('2'))
    await sleep(50)
    expect(fake.callsOf('fetch')).toHaveLength(fetches)
    expect(received).toHaveLength(1)
  })

  it('drains the connection it created and only flushes the one it was given', async () => {
    const given = fakeWithQueues('orders')
    const driver = driverFor(given)
    await driver.connect({ logger: memoryLogger() })
    await driver.close()
    expect(given.drained).toBe(false)
    expect(given.closed).toBe(false)
    expect(given.callsOf('flush')).toHaveLength(1)
    // idempotent, and a closed driver cannot reconnect
    await driver.close()
    expect(messageOf(await caught(driver.connect({ logger: memoryLogger() })))).toContain('the driver is closed')
  })

  it('reports a server without JetStream as unavailable', async () => {
    const fake = new FakeNats()
    fake.managerError = Object.assign(new Error('jetstream is not enabled'), { name: 'JetStreamNotEnabled' })
    const error = await caught(driverFor(fake).connect({ logger: memoryLogger() }))
    expect(error).toMatchObject({ code: 'ZNIGHT021' })
    expect(messageOf(error)).toContain('NATS JetStream: cannot reach JetStream (jetstream is not enabled)')
  })

  it('validates its options', () => {
    expect(() => nats({ jetstream: new FakeNats().jetstream })).toThrow('nats(): jetstream requires connection')
    expect(() => nats({ durablePrefix: 'a.b' })).toThrow('durablePrefix')
    expect(() => nats({ fetchExpiresMs: 500 })).toThrow('fetchExpiresMs must be at least 1000')
    expect(() => nats({ ackWaitMs: 50 })).toThrow('ackWaitMs must be at least 100')
    expect(nats().capabilities).toEqual({
      nativeDelay: true,
      maxNativeDelayMs: 9_007_199_254,
      maxInProcessDelayMs: 1000,
      deliveryCount: 'native',
      maxPublishDelayMs: 0,
    })
  })
})

// the conformance scenarios against the in-memory JetStream (the real server runs them under
// ZNIGHT_INTEGRATION=1, see test/integration/nats.test.ts)
const shared = new FakeNats()
describeDriverConformance({
  name: 'nats (fake JetStream)',
  driver: overrides =>
    nats({ connection: shared.connection, jetstream: shared.jetstream, fetchExpiresMs: 1000, ...overrides }),
  prepareQueue: async (queue, deadLetterQueue) => {
    await Promise.resolve()
    shared.createStream(queue, [queue])
    shared.createStream(`${queue}_dlq`, [deadLetterQueue])
  },
  test: { describe, it },
  nativeDelayMs: 200,
  timeoutMs: 15_000,
})
