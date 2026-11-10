/**
 * Pub/Sub driver against an in-memory Pub/Sub (`fake-pubsub.ts`, passed as the generated clients):
 * names, attributes, flow control, settlements, attempts, the two retry owners, verification,
 * provisioning, ordering keys, leases and shutdown. The behaviour against the emulator is covered by
 * `test/integration/pubsub.test.ts`.
 */
import type { DriverDelivery, SubscribeOptions } from '../../src/driver.ts'
import type { InboundMessage, MessagingDriver } from '../../src/index.ts'
import type { TestConsumer } from '../helpers.ts'

import { Application } from '@znight/core'

import { type PubSubDriverOptions, pubsub } from '../../src/drivers/pubsub.ts'
import { MessageBroker, MessagingHeaders, MessagingPlugin, NonRetryableError } from '../../src/index.ts'
import { caught, handler, memoryLogger, messageOf, messagingMetadata, sleep } from '../helpers.ts'
import { FakePubSub, grpcError, PERMISSION_DENIED } from './fake-pubsub.ts'
import { afterEach, describe, expect, it, jest } from 'bun:test'

const subscribeOptions: SubscribeOptions = {
  consumer: 'OrderConsumer',
  concurrency: 1,
  deadLetterQueue: undefined,
  maxAttempts: 1,
  retryDelays: [],
  options: {},
}

function driverFor(fake: FakePubSub, options: Partial<PubSubDriverOptions> = {}): MessagingDriver {
  return pubsub({
    projectId: fake.project,
    publisherClient: fake.publisher,
    subscriberClient: fake.subscriber,
    pullTimeoutMs: 200,
    ...options,
  })
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
  return { app, plugin, broker: app.get(MessageBroker), logs: logger.entries }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(5)
  }
}

/** Subscribes `queue` directly through the driver and returns the deliveries it hands out. */
async function deliveries(driver: MessagingDriver, queue: string, options: Partial<SubscribeOptions> = {}) {
  const received: DriverDelivery[] = []
  await driver.connect({ logger: memoryLogger() })
  const subscription = await driver.subscribe(
    queue,
    delivery =>
      new Promise<void>(resolve => {
        received.push(delivery)
        // settled by the test: resolve once a settlement happened
        const settle = (name: 'ack' | 'retry' | 'deadLetter' | 'release') => {
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
        for (const name of ['ack', 'retry', 'deadLetter', 'release'] as const) settle(name)
      }),
    { ...subscribeOptions, ...options },
  )
  return { received, subscription }
}

describe('names', () => {
  it('publishes to the topic and consumes the subscription of the same name by default', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    const received: InboundMessage[] = []
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    await broker.publish('orders', { id: 1 })
    await waitFor(() => received.length === 1, 'the message')
    expect(fake.callsOf('publish')[0].topic).toBe('projects/test-project/topics/orders')
    expect(fake.callsOf('pull')[0].subscription).toBe('projects/test-project/subscriptions/orders')
    expect(received[0]).toMatchObject({ queue: 'orders', driver: 'pubsub', attempt: 1 })
  })

  it('maps queues through records, functions and full resource names', async () => {
    const fake = new FakePubSub()
    fake.createTopic('events')
    fake.createTopic('projects/other/topics/audit')
    fake.createSubscription('events-notifications-prod', 'events')
    fake.createQueue('events-notifications-prod-dlq', false)
    const received: InboundMessage[] = []
    class NotificationConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
      }
    }
    const driver = driverFor(fake, {
      topics: queue => (queue === 'audit' ? 'projects/other/topics/audit' : queue),
      subscriptions: { notifications: 'events-notifications-prod' },
      deadLetterName: () => 'events-notifications-prod-dlq',
    })
    const { broker } = await startApp(driver, [
      { class: NotificationConsumer, queue: 'notifications', handlers: [handler('handle')] },
    ])
    await broker.publish('events', 'hello')
    await broker.publish('audit', 'trail')
    await waitFor(() => received.length === 1, 'the notification')
    expect(fake.callsOf('publish').map(request => request.topic)).toEqual([
      'projects/test-project/topics/events',
      'projects/other/topics/audit',
    ])
    expect(received[0]).toMatchObject({ queue: 'notifications', payload: 'hello' })
  })

  it('names the dead-letter topic <queue>-dlq', () => {
    expect(driverFor(new FakePubSub()).deadLetterName('orders')).toBe('orders-dlq')
  })
})

describe('messages', () => {
  it('round-trips the body, the transport attributes, the headers and the ordering key', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    const received: InboundMessage[] = []
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    const before = Date.now()
    const { id } = await broker.publish(
      'orders',
      { id: 1 },
      { type: 'order.created', key: 'customer-1', headers: { 'x-tenant': 'acme', traceparent: '00-a-b-01' } },
    )
    await broker.publish('orders', new Uint8Array([0, 255, 7]))
    await waitFor(() => received.length === 2, 'both messages')
    const published = fake.callsOf('publish')[0].messages[0]
    expect(published.orderingKey).toBe('customer-1')
    expect(Buffer.from(published.data).toString()).toBe('{"id":1}')
    expect(published.attributes).toMatchObject({
      [MessagingHeaders.Id]: id,
      [MessagingHeaders.Type]: 'order.created',
      'content-type': 'application/json',
      'x-tenant': 'acme',
      traceparent: '00-a-b-01',
    })
    const [first, binary] = received
    expect(first).toMatchObject({ id, type: 'order.created', key: 'customer-1', payload: { id: 1 } })
    expect(first?.headers).toEqual({ 'x-tenant': 'acme', traceparent: '00-a-b-01' })
    expect(first?.contentType).toStartWith('application/json')
    expect(first?.timestamp).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000)
    expect([...((binary?.payload ?? []) as Uint8Array)]).toEqual([0, 255, 7])
    expect(binary?.key).toBeUndefined()
  })

  it('falls back to the Pub/Sub message id and exposes googclient_traceparent as traceparent', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    const received: InboundMessage[] = []
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        received.push(message)
      }
    }
    await startApp(driverFor(fake), [{ class: Consumer, queue: 'orders', handlers: [handler('handle')] }])
    // published by another client: no Znight attributes
    await fake.publisher.publish({
      topic: fake.topicPath('orders'),
      messages: [{ data: Buffer.from('"raw"'), attributes: { googclient_traceparent: '00-c-d-01' } }],
    })
    await fake.publisher.publish({
      topic: fake.topicPath('orders'),
      messages: [{ data: Buffer.from('"both"'), attributes: { googclient_traceparent: 'x', traceparent: 'mine' } }],
    })
    await waitFor(() => received.length === 2, 'the raw messages')
    expect(received[0]?.id).toBe(fake.received('orders')[0]?.messageId as string)
    expect(received[0]?.headers['traceparent']).toBe('00-c-d-01')
    expect(received[1]?.headers['traceparent']).toBe('mine')
  })

  it('checks the Pub/Sub attribute limits before publishing', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    const message = {
      id: 'x',
      type: undefined,
      key: undefined,
      body: '1',
      contentType: 'application/json',
      timestamp: Date.now(),
      delayMs: 0,
    }
    const tooMany = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [`h${index}`, 'v']))
    expect(messageOf(await caught(driver.publish('orders', { ...message, headers: tooMany })))).toContain(
      'at most 100 attributes',
    )
    expect(messageOf(await caught(driver.publish('orders', { ...message, headers: { googx: 'v' } })))).toContain(
      '"googx" is not a valid Pub/Sub attribute name',
    )
    expect(
      messageOf(await caught(driver.publish('orders', { ...message, headers: { big: 'é'.repeat(513) } }))),
    ).toContain('longer than 1024 bytes')
    expect(
      messageOf(await caught(driver.publish('orders', { ...message, headers: { ['k'.repeat(257)]: 'v' } }))),
    ).toContain('is not a valid Pub/Sub attribute name')
    expect(fake.callsOf('publish')).toHaveLength(0)
    await driver.close()
  })

  it('reports a missing topic, and does not support delayed publishing', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    class Consumer {
      handle() {}
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    expect(messageOf(await caught(broker.publish('missing', 1)))).toContain('Pub/Sub: topic "missing" not found')
    expect(messageOf(await caught(broker.publish('orders', 1, { delay: 1000 })))).toContain(
      'does not support delayed publishing',
    )
  })
})

describe('flow control and settlements', () => {
  it('never leases more messages than the consumer concurrency', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    let active = 0
    let max = 0
    let done = 0
    class SlowConsumer {
      async handle() {
        active++
        max = Math.max(max, active)
        await sleep(30)
        active--
        done++
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: SlowConsumer, queue: 'orders', options: { concurrency: 2 }, handlers: [handler('handle')] },
    ])
    for (let index = 0; index < 6; index++) await broker.publish('orders', index)
    await waitFor(() => done === 6, 'six messages')
    expect(max).toBe(2)
    for (const request of fake.callsOf('pull')) expect(request.maxMessages).toBeLessThanOrEqual(2)
  })

  it('acknowledges, retries with an ack deadline and releases with a zero deadline', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders', false)
    for (let index = 0; index < 3; index++) {
      await fake.publisher.publish({ topic: fake.topicPath('orders'), messages: [{ data: Buffer.from('1') }] })
    }
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { concurrency: 3 })
    await waitFor(() => received.length === 3, 'three deliveries')
    const [first, second, third] = received as [DriverDelivery, DriverDelivery, DriverDelivery]
    await first.ack()
    await second.retry({ attempt: 2, delayMs: 2500, error: new Error('boom') })
    await third.release()
    expect(fake.callsOf('acknowledge').map(request => request.ackIds)).toEqual([
      [(first.raw as { ackId: string }).ackId],
    ])
    const deadlines = fake
      .callsOf('modifyAckDeadline')
      .filter(request => request.ackIds.length === 1 && request.ackDeadlineSeconds !== 60)
      .map(request => request.ackDeadlineSeconds)
    expect(deadlines).toEqual([3, 0])
    expect(messageOf(await caught(first.ack()))).toContain('already settled')
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('declares its capabilities', () => {
    expect(driverFor(new FakePubSub()).capabilities).toEqual({
      nativeDelay: true,
      maxNativeDelayMs: 600_000,
      maxInProcessDelayMs: 1000,
      deliveryCount: 'native',
      maxPublishDelayMs: 0,
    })
    expect(driverFor(new FakePubSub(), { retries: 'subscription' }).capabilities.maxInProcessDelayMs).toBe(0)
  })

  it('validates its options', async () => {
    expect(() => pubsub({ ackDeadlineSeconds: 5 })).toThrow('ackDeadlineSeconds must be an integer between 10 and 600')
    expect(() => pubsub({ retries: 'broker' as 'znight' })).toThrow("retries must be 'znight' or 'subscription'")
    expect(() => pubsub({ maxInProcessDelayMs: -1 })).toThrow('maxInProcessDelayMs')
    const fake = new FakePubSub()
    fake.createQueue('orders')
    class Consumer {
      handle() {}
    }
    expect(
      messageOf(
        await caught(
          startApp(driverFor(fake), [
            { class: Consumer, queue: 'orders', options: { retries: 'never' }, handlers: [handler('handle')] },
          ]),
        ),
      ),
    ).toContain("Consumer: the Pub/Sub option retries must be 'znight' or 'subscription'")
  })
})

describe('attempts and dead letters (retries: znight)', () => {
  /** A consumer failing until `succeedAt`, recording each attempt. */
  function flaky(attempts: number[], succeedAt: number) {
    return class FlakyConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        if (message.attempt < succeedAt) throw new Error(`transient ${message.attempt}`)
      }
    }
  }

  it('counts attempts in memory without a dead-letter policy', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    const attempts: number[] = []
    const { broker } = await startApp(driverFor(fake), [
      {
        class: flaky(attempts, 3),
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 0 } })],
      },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => attempts.length === 3, 'three attempts')
    expect(attempts).toEqual([1, 2, 3])
    await waitFor(() => fake.pending('orders').length === 0, 'the acknowledgement')
  })

  it('counts attempts with deliveryAttempt and dead-letters to the policy topic', async () => {
    const fake = new FakePubSub()
    fake.createTopic('orders')
    fake.createQueue('orders-dead', false)
    fake.createSubscription('orders', 'orders', {
      deadLetterPolicy: { deadLetterTopic: 'orders-dead', maxDeliveryAttempts: 5 },
    })
    const attempts: number[] = []
    const { broker } = await startApp(driverFor(fake), [
      {
        class: flaky(attempts, 99),
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 0 } })],
      },
    ])
    await broker.publish('orders', 1, { headers: { keep: 'me' } })
    await waitFor(() => fake.received('orders-dead').length === 1, 'the dead letter')
    expect(attempts).toEqual([1, 2, 3])
    expect(fake.received('orders-dead')[0]?.attributes).toMatchObject({
      keep: 'me',
      [MessagingHeaders.DeadLetterReason]: 'max-attempts',
      [MessagingHeaders.Error]: 'transient 3',
      [MessagingHeaders.OriginalQueue]: 'orders',
      [MessagingHeaders.Attempts]: '3',
    })
    expect(fake.callsOf('publish').map(request => request.topic)).not.toContain(fake.topicPath('orders-dlq'))
  })

  it('refuses a dead-letter policy that would forward a message before its last attempt', async () => {
    const fake = new FakePubSub()
    fake.createTopic('orders')
    fake.createQueue('orders-dead', false)
    fake.createSubscription('orders', 'orders', {
      deadLetterPolicy: { deadLetterTopic: 'orders-dead', maxDeliveryAttempts: 5 },
    })
    class Consumer {
      handle() {}
    }
    const error = await caught(
      startApp(driverFor(fake), [
        {
          class: Consumer,
          queue: 'orders',
          handlers: [handler('handle', { retry: { attempts: 6, backoff: 'fixed', delay: 0 } })],
        },
      ]),
    )
    expect(messageOf(error)).toContain(
      'subscription "orders" forwards messages to its dead-letter topic after 5 delivery attempt(s), but Consumer allows 6',
    )
  })

  it('dead-letters to <queue>-dlq with the Znight attributes, the error truncated to an attribute', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    class FailingConsumer {
      handle() {
        throw new NonRetryableError('é'.repeat(2000))
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: FailingConsumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    await broker.publish('orders', { id: 1 }, { type: 'order.created', key: 'k1' })
    await waitFor(() => fake.received('orders-dlq').length === 1, 'the dead letter')
    const [copy] = fake.received('orders-dlq')
    expect(Buffer.from(copy?.data as Uint8Array).toString()).toBe('{"id":1}')
    expect(copy?.orderingKey).toBe('k1')
    expect(copy?.attributes?.[MessagingHeaders.Type]).toBe('order.created')
    expect(copy?.attributes?.[MessagingHeaders.DeadLetterReason]).toBe('non-retryable')
    expect(Buffer.byteLength(copy?.attributes?.[MessagingHeaders.Error] ?? '')).toBeLessThanOrEqual(1024)
    await waitFor(() => fake.pending('orders').length === 0, 'the acknowledgement')
  })

  it('without dead-lettering, nacks when a dead-letter policy may apply and drops otherwise', async () => {
    const fake = new FakePubSub()
    fake.createQueue('plain', false)
    fake.createTopic('guarded')
    fake.createQueue('guarded-dead', false)
    fake.createSubscription('guarded', 'guarded', {
      deadLetterPolicy: { deadLetterTopic: 'guarded-dead', maxDeliveryAttempts: 5 },
    })
    fake.createQueue('hidden', false)
    fake.failures = (method, request) =>
      method === 'getSubscription' && request.subscription.endsWith('/hidden')
        ? grpcError(PERMISSION_DENIED, 'denied')
        : undefined
    const settled: Record<string, string[]> = {}
    for (const queue of ['plain', 'guarded', 'hidden']) {
      await fake.publisher.publish({ topic: fake.topicPath(queue), messages: [{ data: Buffer.from('1') }] })
      const driver = driverFor(fake)
      const { received, subscription } = await deliveries(driver, queue)
      await waitFor(() => received.length === 1, `the ${queue} delivery`)
      const calls = fake.calls.length
      await received[0]?.deadLetter({ queue: undefined, reason: 'max-attempts', error: new Error('x'), attempt: 1 })
      settled[queue] = fake.calls
        .slice(calls)
        .filter(call => call.method !== 'pull')
        .map(call => (call.method === 'modifyAckDeadline' ? `nack ${call.request.ackDeadlineSeconds}` : call.method))
      await subscription.cancel()
      await subscription.close()
      await driver.close()
    }
    expect(settled).toEqual({ plain: ['acknowledge'], guarded: ['nack 0'], hidden: ['nack 0'] })
  })

  it('fails when the subscription or the dead-letter topic is missing', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders', false)
    class Consumer {
      handle() {}
    }
    expect(
      messageOf(
        await caught(startApp(driverFor(fake), [{ class: Consumer, queue: 'missing', handlers: [handler('handle')] }])),
      ),
    ).toContain('Pub/Sub: subscription "missing" not found')
    expect(
      messageOf(
        await caught(startApp(driverFor(fake), [{ class: Consumer, queue: 'orders', handlers: [handler('handle')] }])),
      ),
    ).toContain('Pub/Sub: dead-letter topic "orders-dlq" not found')
  })

  it('warns and skips the checks without the permission to read the subscription', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    fake.failures = method =>
      method === 'getSubscription' || method === 'getTopic' ? grpcError(PERMISSION_DENIED, 'denied') : undefined
    const received: unknown[] = []
    class Consumer {
      handle(payload: unknown) {
        received.push(payload)
      }
    }
    const { broker, logs } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => received.length === 1, 'the message')
    expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('cannot read subscription'))).toBe(true)
  })

  it('warns when a retrying consumer reads a subscription without dead-letter policy', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders')
    class Consumer {
      handle() {}
    }
    const { logs } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('has no dead-letter policy'))).toBe(true)
  })
})

describe('retries: subscription', () => {
  it('nacks every failure at once and lets the subscription dead-letter', async () => {
    const fake = new FakePubSub()
    fake.createTopic('orders')
    fake.createQueue('orders-dead', false)
    fake.createSubscription('orders', 'orders', {
      deadLetterPolicy: { deadLetterTopic: 'orders-dead', maxDeliveryAttempts: 5 },
    })
    const attempts: number[] = []
    class FailingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        throw new Error('fail')
      }
    }
    const { broker } = await startApp(driverFor(fake, { retries: 'subscription' }), [
      {
        class: FailingConsumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 60_000 } })],
      },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => fake.received('orders-dead').length === 1, 'the forwarded message')
    expect(attempts).toEqual([1, 2, 3, 4, 5])
    const settlements = fake.callsOf('modifyAckDeadline').filter(request => request.ackDeadlineSeconds !== 60)
    expect(settlements.map(request => request.ackDeadlineSeconds)).toEqual([0, 0, 0, 0, 0])
    expect(fake.callsOf('publish')).toHaveLength(1)
    expect(fake.received('orders-dead')[0]?.attributes?.['CloudPubSubDeadLetterSourceDeliveryCount']).toBe('5')
  })

  it('requires a dead-letter policy and warns when the attempts differ from it', async () => {
    const fake = new FakePubSub()
    fake.createQueue('plain', false)
    fake.createTopic('guarded')
    fake.createQueue('guarded-dead', false)
    fake.createSubscription('guarded', 'guarded', {
      deadLetterPolicy: { deadLetterTopic: 'guarded-dead', maxDeliveryAttempts: 5 },
    })
    class Consumer {
      handle() {}
    }
    const driver = () => driverFor(fake, { retries: 'subscription' })
    expect(
      messageOf(await caught(startApp(driver(), [{ class: Consumer, queue: 'plain', handlers: [handler('handle')] }]))),
    ).toContain('subscription "plain" has no dead-letter policy')
    const { logs } = await startApp(driver(), [
      { class: Consumer, queue: 'guarded', handlers: [handler('handle')] },
      // a consumer can give the ownership back to Znight
      {
        class: Consumer,
        token: 'src/app.ts#Plain',
        queue: 'plain',
        options: { retries: 'znight', deadLetter: false },
        handlers: [handler('handle')],
      },
    ])
    expect(
      logs.some(
        entry => entry.level === 'warn' && entry.message.includes('after 5 delivery attempt(s), but Consumer allows 3'),
      ),
    ).toBe(true)
  })
})

describe('retries: subscription, terminal failures and overrides', () => {
  it('reports a terminal failure as rejected, never as dead-lettered to a topic it does not publish to', async () => {
    const fake = new FakePubSub()
    fake.createTopic('orders')
    fake.createQueue('orders-dead', false)
    fake.createSubscription('orders', 'orders', {
      deadLetterPolicy: { deadLetterTopic: 'orders-dead', maxDeliveryAttempts: 5 },
    })
    class Consumer {
      handle() {
        throw new NonRetryableError('bad order')
      }
    }
    const { broker, logs, plugin } = await startApp(driverFor(fake, { retries: 'subscription' }), [
      {
        class: Consumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 0 } })],
      },
    ])
    expect(plugin.consumers()[0]?.deadLetterQueue).toBeUndefined()
    await broker.publish('orders', 1)
    await waitFor(() => fake.received('orders-dead').length === 1, 'the forwarded message')
    expect(logs.some(entry => entry.message.includes('dead-lettered to'))).toBe(false)
    expect(logs.filter(entry => entry.message.includes('rejected (non-retryable)'))).toHaveLength(5)
    // nothing published by Znight: the subscription forwarded the message
    expect(fake.callsOf('publish')).toHaveLength(1)
  })

  it("refuses @Consumer({ retries: 'subscription' }) under a driver whose retries are 'znight'", async () => {
    const fake = new FakePubSub()
    fake.createTopic('orders')
    fake.createQueue('orders-dead', false)
    fake.createSubscription('orders', 'orders', {
      deadLetterPolicy: { deadLetterTopic: 'orders-dead', maxDeliveryAttempts: 5 },
    })
    class Consumer {
      handle() {}
    }
    const error = await caught(
      startApp(driverFor(fake), [
        { class: Consumer, queue: 'orders', options: { retries: 'subscription' }, handlers: [handler('handle')] },
      ]),
    )
    expect(messageOf(error)).toContain(
      "Consumer: @Consumer({ retries: 'subscription' }) needs a driver created with pubsub({ retries: 'subscription' })",
    )
    expect(fake.callsOf('pull')).toHaveLength(0)
  })
})

describe('provisioning', () => {
  it('creates nothing by default, and the missing topology with provision: true', async () => {
    const fake = new FakePubSub()
    const received: unknown[] = []
    class Consumer {
      handle(payload: unknown) {
        received.push(payload)
      }
    }
    const { broker } = await startApp(driverFor(fake, { provision: true }), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    expect([...fake.topics].sort()).toEqual([fake.topicPath('orders'), fake.topicPath('orders-dlq')])
    expect([...fake.subscriptions.keys()].sort()).toEqual([
      fake.subscriptionPath('orders'),
      fake.subscriptionPath('orders-dlq'),
    ])
    await broker.publish('orders', 1)
    await broker.publish('fresh', 2)
    await waitFor(() => received.length === 1, 'the message')
    expect(fake.topics.has(fake.topicPath('fresh'))).toBe(true)
    expect(fake.subscriptions.get(fake.subscriptionPath('orders'))?.deadLetterPolicy).toBeUndefined()
  })

  it("creates the subscription with a dead-letter policy under retries: 'subscription'", async () => {
    const fake = new FakePubSub()
    const attempts: number[] = []
    class FailingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        throw new Error('fail')
      }
    }
    const { broker, logs } = await startApp(driverFor(fake, { retries: 'subscription', provision: true }), [
      {
        class: FailingConsumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 6, backoff: 'fixed', delay: 0 } })],
      },
    ])
    expect(fake.subscriptions.get(fake.subscriptionPath('orders'))?.deadLetterPolicy).toEqual({
      deadLetterTopic: fake.topicPath('orders-dlq'),
      maxDeliveryAttempts: 6,
    })
    expect(fake.subscriptions.has(fake.subscriptionPath('orders-dlq'))).toBe(true)
    expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('delivery attempt(s)'))).toBe(false)
    await broker.publish('orders', 1)
    await waitFor(() => fake.received('orders-dlq').length === 1, 'the forwarded message')
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('gives a provisioned dead-letter policy at least 5 delivery attempts (the Pub/Sub minimum)', async () => {
    const fake = new FakePubSub()
    class Consumer {
      handle() {}
    }
    const { logs } = await startApp(driverFor(fake, { retries: 'subscription', provision: true }), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    expect(fake.subscriptions.get(fake.subscriptionPath('orders'))?.deadLetterPolicy?.maxDeliveryAttempts).toBe(5)
    expect(
      logs.some(
        entry => entry.level === 'warn' && entry.message.includes('after 5 delivery attempt(s), but Consumer allows 3'),
      ),
    ).toBe(true)
  })
})

describe('ordering keys', () => {
  it('handles the messages of a key one after the other on ordered subscriptions', async () => {
    const fake = new FakePubSub()
    fake.createTopic('orders')
    fake.createQueue('orders-dlq', false)
    fake.createSubscription('orders', 'orders', { enableMessageOrdering: true })
    const log: string[] = []
    let active = 0
    let max = 0
    class Consumer {
      async handle(payload: number, message: InboundMessage) {
        active++
        max = Math.max(max, active)
        log.push(`${message.key}:${payload}`)
        await sleep(20)
        active--
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', options: { concurrency: 4 }, handlers: [handler('handle')] },
    ])
    for (let index = 0; index < 4; index++) await broker.publish('orders', index, { key: index < 3 ? 'a' : 'b' })
    await waitFor(() => log.length === 4, 'four messages')
    expect(log.filter(entry => entry.startsWith('a:'))).toEqual(['a:0', 'a:1', 'a:2'])
    expect(max).toBe(2)
  })
})

describe('leases and shutdown', () => {
  it('extends the leases of in-flight messages and never overrides a settlement', async () => {
    jest.useFakeTimers()
    try {
      const fake = new FakePubSub()
      fake.createQueue('orders', false)
      await fake.publisher.publish({ topic: fake.topicPath('orders'), messages: [{ data: Buffer.from('1') }] })
      // extensions take 400 ms to land
      fake.latency = (method, request) =>
        method === 'modifyAckDeadline' && request.ackDeadlineSeconds === 10 ? 400 : 0
      const driver = driverFor(fake, { ackDeadlineSeconds: 10, pullTimeoutMs: 50 })
      const { received, subscription } = await deliveries(driver, 'orders')
      const advance = async (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 10) {
          jest.advanceTimersByTime(10)
          for (let tick = 0; tick < 20; tick++) await Promise.resolve()
        }
      }
      await advance(100)
      expect(received).toHaveLength(1)
      // the extension due at 5 s lands at 5.4 s; the retry is sent at 5.1 s
      await advance(5000)
      const retried = received[0]?.retry({ attempt: 2, delayMs: 300_000, error: new Error('boom') })
      await advance(1000)
      await retried
      await advance(10_000)
      const deadlines = fake.applied
        .filter(call => call.method === 'modifyAckDeadline')
        .map(call => call.request.ackDeadlineSeconds)
      expect(deadlines).toEqual([10, 10, 300])
      await subscription.cancel()
      await advance(200)
      await subscription.close()
      await driver.close()
    } finally {
      jest.useRealTimers()
    }
  })

  it('extends older leases on time while the initial deadline of a new batch is in flight', async () => {
    jest.useFakeTimers()
    try {
      const fake = new FakePubSub()
      fake.createQueue('orders', false)
      await fake.publisher.publish({ topic: fake.topicPath('orders'), messages: [{ data: Buffer.from('1') }] })
      // the initial deadline of the second message (ack-2) takes 3 s to land
      fake.latency = (method, request) =>
        method === 'modifyAckDeadline' && request.ackIds.length === 1 && request.ackIds[0] === 'ack-2' ? 3000 : 0
      const driver = driverFor(fake, { ackDeadlineSeconds: 10, pullTimeoutMs: 50 })
      const { received, subscription } = await deliveries(driver, 'orders', { concurrency: 2 })
      const advance = async (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 10) {
          jest.advanceTimersByTime(10)
          for (let tick = 0; tick < 20; tick++) await Promise.resolve()
        }
      }
      await advance(100)
      expect(received).toHaveLength(1)
      await advance(3900)
      await fake.publisher.publish({ topic: fake.topicPath('orders'), messages: [{ data: Buffer.from('2') }] })
      await advance(600)
      expect(received).toHaveLength(2)
      // the tick at 5 s runs while the initial deadline of ack-2 (sent after 4 s) is still in flight
      await advance(700)
      const extensionsOfFirst = fake.applied.filter(
        call => call.method === 'modifyAckDeadline' && call.request.ackIds.includes('ack-1'),
      )
      expect(extensionsOfFirst).toHaveLength(2)
      await advance(3000)
      for (const delivery of received) await delivery.ack()
      await subscription.cancel()
      await advance(200)
      await subscription.close()
      await driver.close()
    } finally {
      jest.useRealTimers()
    }
  })

  it('releases the messages of a pull that completes after the subscription stopped', async () => {
    const fake = new FakePubSub()
    fake.createQueue('orders', false)
    fake.latency = method => (method === 'pull' ? 100 : 0)
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    await sleep(20)
    await fake.publisher.publish({ topic: fake.topicPath('orders'), messages: [{ data: Buffer.from('1') }] })
    await subscription.cancel()
    await waitFor(
      () => fake.callsOf('modifyAckDeadline').some(request => request.ackDeadlineSeconds === 0),
      'the release',
    )
    expect(received).toHaveLength(0)
    await subscription.close()
    await driver.close()
  })

  it('closes the clients it was given only when it created them', async () => {
    const fake = new FakePubSub()
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    await driver.close()
    expect(fake.closed).toEqual({ publisher: false, subscriber: false })
  })
})
