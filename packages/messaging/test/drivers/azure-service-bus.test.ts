/**
 * Azure Service Bus driver against an in-memory namespace (`fake-service-bus.ts`, passed as the
 * client and the administration client): names, message mapping, flow control, settlements,
 * attempts, the two retry owners, verification, provisioning and shutdown; then the public
 * conformance kit. The behaviour against the emulator is covered by
 * `test/integration/azure-service-bus.test.ts`.
 */
import type { DriverDelivery, SubscribeOptions } from '../../src/driver.ts'
import type { InboundMessage, MessagingDriver, OutboundMessage } from '../../src/index.ts'
import type { TestConsumer } from '../helpers.ts'

import { ServiceBusClient } from '@azure/service-bus'
import { Application, ZnightError } from '@znight/core'

import {
  type AzureServiceBusDriver,
  type AzureServiceBusDriverOptions,
  azureServiceBus,
} from '../../src/drivers/azure-service-bus.ts'
import { MessageBroker, MessagingHeaders, MessagingPlugin, NonRetryableError } from '../../src/index.ts'
import { describeDriverConformance } from '../../src/testing.ts'
import { caught, handler, memoryLogger, messageOf, messagingMetadata, sleep } from '../helpers.ts'
import { FakeServiceBus, restUnauthorized } from './fake-service-bus.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const subscribeOptions: SubscribeOptions = {
  consumer: 'OrderConsumer',
  concurrency: 1,
  deadLetterQueue: undefined,
  maxAttempts: 1,
  retryDelays: [],
  options: {},
}

function driverFor(fake: FakeServiceBus, options: Partial<AzureServiceBusDriverOptions> = {}): AzureServiceBusDriver {
  return azureServiceBus({
    client: fake.client,
    administrationClient: fake.admin,
    maxWaitTimeMs: 50,
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
  const logger = memoryLogger()
  await driver.connect({ logger })
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
  return { received, subscription, logs: logger.entries }
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: 'm-1',
    type: undefined,
    key: undefined,
    headers: {},
    body: '{"id":1}',
    contentType: 'application/json',
    timestamp: Date.now(),
    delayMs: 0,
    ...overrides,
  }
}

describe('options and connection', () => {
  it('declares its capabilities', () => {
    const fake = new FakeServiceBus()
    const year = 365 * 24 * 3600 * 1000
    expect(driverFor(fake).capabilities).toEqual({
      nativeDelay: true,
      maxNativeDelayMs: 10 * year,
      maxInProcessDelayMs: 1000,
      deliveryCount: 'native',
      maxPublishDelayMs: 10 * year,
    })
    expect(driverFor(fake, { retries: 'entity' }).capabilities.maxInProcessDelayMs).toBe(0)
    expect(driverFor(fake, { maxInProcessDelayMs: 250 }).capabilities.maxInProcessDelayMs).toBe(250)
    expect(driverFor(fake).name).toBe('azure-service-bus')
  })

  it('validates its options', () => {
    expect(() => azureServiceBus({})).toThrow(
      'azureServiceBus() needs a connectionString, a fullyQualifiedNamespace or a client',
    )
    expect(() => azureServiceBus({ connectionString: 'x', retries: 'broker' as 'znight' })).toThrow(
      "retries must be 'znight' or 'entity'",
    )
    expect(() => azureServiceBus({ connectionString: 'x', maxInProcessDelayMs: -1 })).toThrow('maxInProcessDelayMs')
    expect(() => azureServiceBus({ connectionString: 'x', maxWaitTimeMs: Number.NaN })).toThrow('maxWaitTimeMs')
    expect(() => azureServiceBus({ connectionString: 'x', maxAutoLockRenewalDurationInMs: -5 })).toThrow(
      'maxAutoLockRenewalDurationInMs',
    )
  })

  it('creates and owns a client from a connection string', async () => {
    const driver = azureServiceBus({
      connectionString: 'Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=s',
    })
    await driver.connect({ logger: memoryLogger() })
    expect(driver.client).toBeInstanceOf(ServiceBusClient)
    expect(driver.client?.fullyQualifiedNamespace).toBe('acme.servicebus.windows.net')
    expect(driver.administrationClient).toBeDefined()
    await driver.close()
    expect(driver.client).toBeUndefined()
    expect(messageOf(await caught(driver.connect({ logger: memoryLogger() })))).toContain('the driver is closed')
  })

  it('authenticates with DefaultAzureCredential (@azure/identity) when no credential is given', async () => {
    const driver = azureServiceBus({ fullyQualifiedNamespace: 'acme.servicebus.windows.net' })
    await driver.connect({ logger: memoryLogger() })
    expect(driver.client?.fullyQualifiedNamespace).toBe('acme.servicebus.windows.net')
    expect(driver.credential?.constructor.name).toBe('DefaultAzureCredential')
    await driver.close()
  })

  it('uses the credential it is given', async () => {
    const credential = { getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 60_000 }) }
    const driver = azureServiceBus({ fullyQualifiedNamespace: 'acme.servicebus.windows.net', credential })
    await driver.connect({ logger: memoryLogger() })
    expect(driver.credential).toBe(credential)
    await driver.close()
  })

  it('leaves the clients it is given open', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    await driver.publish('orders', outbound())
    await driver.close()
    expect(fake.closed.client).toBe(false)
    expect(fake.closed.senders).toBe(1)
  })
})

describe('names', () => {
  it('sends to the entity named by the queue and receives from the queue of the same name', async () => {
    const fake = new FakeServiceBus()
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
    await waitFor(() => fake.callsOf('completeMessage').length === 1, 'the message')
    expect(fake.callsOf('createSender').map(call => call.entity)).toEqual(['orders'])
    expect(fake.callsOf('createReceiver').map(call => call.entity)).toEqual(['orders'])
    expect(received[0]).toMatchObject({ queue: 'orders', driver: 'azure-service-bus', payload: { id: 1 } })
  })

  it('reads topic subscriptions, mapped or written topic/subscription', async () => {
    const fake = new FakeServiceBus()
    fake.createSubscription('events', 'billing')
    fake.createSubscription('events', 'audit')
    const billing: InboundMessage[] = []
    const audit: InboundMessage[] = []
    class BillingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        billing.push(message)
      }
    }
    class AuditConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        audit.push(message)
      }
    }
    const driver = driverFor(fake, { subscriptions: { billing: 'events/billing' }, entities: { orders: 'events' } })
    const { broker } = await startApp(driver, [
      { class: BillingConsumer, queue: 'billing', options: { deadLetter: false }, handlers: [handler('handle')] },
      {
        class: AuditConsumer,
        queue: 'events/subscriptions/audit',
        options: { deadLetter: false },
        handlers: [handler('handle')],
      },
    ])
    await broker.publish('orders', 'hello')
    await waitFor(() => billing.length === 1 && audit.length === 1, 'both subscriptions')
    expect(fake.callsOf('sendMessages').map(call => call.entity)).toEqual(['events'])
    expect(fake.callsOf('createReceiver').map(call => call.entity)).toEqual(['events/billing', 'events/audit'])
    expect(billing[0]).toMatchObject({ queue: 'billing', payload: 'hello', driver: 'azure-service-bus' })
    expect(audit[0]?.queue).toBe('events/subscriptions/audit')
  })

  it('names the native dead-letter sub-queue and reads it', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const driver = driverFor(fake, { subscriptions: queue => (queue === 'billing' ? 'events/billing' : queue) })
    expect(driver.deadLetterName('orders')).toBe('orders/$deadletterqueue')
    expect(driver.deadLetterName('billing')).toBe('billing/$deadletterqueue')
    fake.createSubscription('events', 'billing')
    class Consumer {
      handle() {}
    }
    await startApp(driver, [
      {
        class: Consumer,
        queue: 'orders/$deadletterqueue',
        options: { deadLetter: false },
        handlers: [handler('handle')],
      },
      {
        class: Consumer,
        queue: 'billing/$deadletterqueue',
        options: { deadLetter: false },
        handlers: [handler('handle')],
      },
    ])
    const receivers = fake.callsOf('createReceiver')
    expect(receivers.map(call => [call.entity, call.args[0].subQueueType])).toEqual([
      ['orders', 'deadLetter'],
      ['events/billing', 'deadLetter'],
    ])
  })

  it('refuses invalid entity paths', async () => {
    const fake = new FakeServiceBus()
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    const error = await caught(driver.subscribe('a/b/c/d', async () => {}, subscribeOptions))
    expect(error).toBeInstanceOf(ZnightError)
    expect(messageOf(error)).toContain('"a/b/c/d" is not a queue, a topic/subscription')
    expect(messageOf(await caught(driver.publish('events/billing', outbound())))).toContain(
      'publishes to a queue or a topic',
    )
    await driver.close()
  })
})

describe('messages', () => {
  it('maps the id, type, content type, key, headers and body to Service Bus properties', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    await driver.publish(
      'orders',
      outbound({
        id: 'id-1',
        type: 'order.created',
        key: 'customer-1',
        headers: { 'x-tenant': 'acme', traceparent: '00-a-b-01', [MessagingHeaders.Id]: 'ignored' },
      }),
    )
    await driver.publish('orders', outbound({ id: 'id-2', body: new Uint8Array([0, 255, 7]), contentType: 'x/bin' }))
    const [sent, binary] = fake.pending('orders')
    expect(sent).toMatchObject({
      messageId: 'id-1',
      subject: 'order.created',
      contentType: 'application/json',
      sessionId: 'customer-1',
      partitionKey: 'customer-1',
      applicationProperties: { 'x-tenant': 'acme', traceparent: '00-a-b-01' },
    })
    expect(Buffer.from(sent?.body).toString()).toBe('{"id":1}')
    expect([...Buffer.from(binary?.body)]).toEqual([0, 255, 7])
    expect(binary?.sessionId).toBeUndefined()
    expect(messageOf(await caught(driver.publish('orders', outbound({ key: 'k'.repeat(129) }))))).toContain(
      'at most 128 characters',
    )
    await driver.close()
  })

  it('round-trips messages through the application, with Diagnostic-Id as traceparent', async () => {
    const fake = new FakeServiceBus()
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
      { type: 'order.created', key: 'customer-1', headers: { 'x-tenant': 'acme' } },
    )
    // a message of another producer: numbers in properties, the SDK's Diagnostic-Id, no message id
    await fake.client.createSender('orders').sendMessages({
      body: Buffer.from('"raw"'),
      applicationProperties: { 'Diagnostic-Id': '00-c-d-01', count: 3 },
    })
    await waitFor(() => received.length === 2, 'both messages')
    const [first, raw] = received
    expect(first).toMatchObject({ id, type: 'order.created', key: 'customer-1', payload: { id: 1 }, attempt: 1 })
    expect(first?.headers).toEqual({ 'x-tenant': 'acme' })
    expect(first?.contentType).toStartWith('application/json')
    expect(first?.timestamp).toBeGreaterThanOrEqual(before)
    expect(raw?.payload).toBe('raw')
    expect(raw?.headers).toEqual({ 'Diagnostic-Id': '00-c-d-01', traceparent: '00-c-d-01', count: '3' })
    expect(raw?.id).toBeString()
  })

  it('schedules delayed publications', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    const before = Date.now()
    await driver.publish('orders', outbound({ delayMs: 60_000 }))
    const [call] = fake.callsOf('scheduleMessages')
    expect((call?.args[1] as Date | undefined)?.getTime()).toBeGreaterThanOrEqual(before + 60_000)
    expect(fake.callsOf('sendMessages')).toHaveLength(0)
    await driver.close()
  })

  it('reports a missing entity, and creates a queue with provision: true', async () => {
    const fake = new FakeServiceBus()
    const driver = driverFor(fake)
    await driver.connect({ logger: memoryLogger() })
    const error = await caught(driver.publish('missing', outbound()))
    expect(error).toBeInstanceOf(ZnightError)
    expect(messageOf(error)).toContain('Azure Service Bus: queue or topic "missing" not found')
    await driver.close()
    const provisioning = driverFor(fake, { provision: true })
    await provisioning.connect({ logger: memoryLogger() })
    await provisioning.publish('missing', outbound())
    expect(fake.callsOf('createQueue').map(call => call.entity)).toEqual(['missing'])
    expect(fake.pending('missing')).toHaveLength(1)
    await provisioning.close()
  })
})

describe('flow control and settlements', () => {
  it('never receives more messages than the free concurrency, with lock renewal', async () => {
    const fake = new FakeServiceBus()
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
    const driver = driverFor(fake, { maxAutoLockRenewalDurationInMs: 120_000 })
    const { broker } = await startApp(driver, [
      { class: SlowConsumer, queue: 'orders', options: { concurrency: 2 }, handlers: [handler('handle')] },
    ])
    for (let index = 0; index < 6; index++) await broker.publish('orders', index)
    await waitFor(() => done === 6, 'six messages')
    expect(max).toBe(2)
    for (const call of fake.callsOf('receiveMessages')) expect(call.args[0]).toBeLessThanOrEqual(2)
    expect(fake.callsOf('createReceiver')[0]?.args[0]).toMatchObject({
      receiveMode: 'peekLock',
      maxAutoLockRenewalDurationInMs: 120_000,
      skipParsingBodyAsJson: true,
    })
  })

  it('completes, abandons and schedules retry copies before completing the original', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const sender = fake.client.createSender('orders')
    for (let index = 0; index < 4; index++) {
      await sender.sendMessages({ body: Buffer.from('1'), messageId: `m${index}`, applicationProperties: { k: 'v' } })
    }
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { concurrency: 4, maxAttempts: 5 })
    await waitFor(() => received.length === 4, 'four deliveries')
    const [first, second, third, fourth] = received as [DriverDelivery, DriverDelivery, DriverDelivery, DriverDelivery]
    await first.ack()
    await second.release()
    await third.retry({ attempt: 2, delayMs: 0, error: new Error('now') })
    const before = Date.now()
    await fourth.retry({ attempt: 2, delayMs: 5000, error: new Error('later') })
    expect(fake.callsOf('completeMessage').map(call => call.args[0].messageId)).toEqual(['m0', 'm3'])
    expect(fake.callsOf('abandonMessage').map(call => call.args[0].messageId)).toEqual(['m1', 'm2'])
    const [schedule] = fake.callsOf('scheduleMessages')
    expect(schedule?.entity).toBe('orders')
    expect((schedule?.args[1] as Date | undefined)?.getTime()).toBeGreaterThanOrEqual(before + 5000)
    const copy = schedule?.args[0]
    expect(copy.applicationProperties).toMatchObject({ k: 'v', [MessagingHeaders.Attempt]: '2', 'x-znight-id': 'm3' })
    expect(copy.messageId).not.toBe('m3')
    const order = fake.calls.map(call => call.method).filter(method => /schedule|complete/.test(method))
    expect(order.slice(-2)).toEqual(['scheduleMessages', 'completeMessage'])
    expect(messageOf(await caught(first.ack()))).toContain('already settled')
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('keeps the original when the retry copy cannot be scheduled', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    await fake.client.createSender('orders').sendMessages({ body: Buffer.from('1'), messageId: 'm' })
    fake.failures = method => (method === 'scheduleMessages' ? new Error('busy') : undefined)
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders', { maxAttempts: 3 })
    await waitFor(() => received.length === 1, 'the delivery')
    expect(messageOf(await caught(received[0]?.retry({ attempt: 2, delayMs: 5000, error: new Error('x') })))).toBe(
      'busy',
    )
    expect(fake.callsOf('completeMessage')).toHaveLength(0)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('counts attempts from the delivery count and the x-znight-attempt of scheduled copies', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const attempts: number[] = []
    class FlakyConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        if (message.attempt < 4) throw new Error(`attempt ${message.attempt}`)
      }
    }
    const { broker } = await startApp(driverFor(fake, { maxInProcessDelayMs: 20 }), [
      {
        class: FlakyConsumer,
        queue: 'orders',
        // 10 ms in-process (abandon), then 30 ms and 60 ms scheduled
        handlers: [handler('handle', { retry: { attempts: 4, backoff: 'exponential', delay: 10 } })],
      },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => attempts.length === 4, 'four attempts')
    expect(attempts).toEqual([1, 2, 3, 4])
    expect(fake.callsOf('abandonMessage')).toHaveLength(1)
    expect(fake.callsOf('scheduleMessages')).toHaveLength(2)
  })
})

describe('dead letters', () => {
  it('dead-letters to the native sub-queue with the Znight properties, read back at attempt 1', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const dead: InboundMessage[] = []
    class FailingConsumer {
      handle() {
        throw new Error('always failing')
      }
    }
    class DeadLetters {
      handle(_payload: unknown, message: InboundMessage) {
        dead.push(message)
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      {
        class: FailingConsumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 5 } })],
      },
      {
        class: DeadLetters,
        queue: 'orders/$deadletterqueue',
        options: { deadLetter: false },
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 5 } })],
      },
    ])
    await broker.publish('orders', { id: 1 }, { type: 'a', headers: { keep: 'me' } })
    await waitFor(() => dead.length === 1, 'the dead letter')
    const [call] = fake.callsOf('deadLetterMessage')
    expect(call?.args[1]).toMatchObject({
      deadLetterReason: 'max-attempts',
      deadLetterErrorDescription: 'always failing',
      [MessagingHeaders.DeadLetterReason]: 'max-attempts',
      [MessagingHeaders.OriginalQueue]: 'orders',
      [MessagingHeaders.Attempts]: '2',
    })
    expect(dead[0]).toMatchObject({ type: 'a', attempt: 1, payload: { id: 1 } })
    expect(dead[0]?.headers).toMatchObject({
      keep: 'me',
      [MessagingHeaders.Error]: 'always failing',
      DeadLetterReason: 'max-attempts',
    })
    expect(dead[0]?.headers[MessagingHeaders.Attempt]).toBeUndefined()
    expect(dead[0]?.headers['x-znight-delivery-base']).toBeUndefined()
  })

  it('sends dead letters to another entity, then completes', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    fake.createQueue('graveyard')
    class FailingConsumer {
      handle() {
        throw new NonRetryableError('permanent')
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: FailingConsumer, queue: 'orders', options: { deadLetter: 'graveyard' }, handlers: [handler('handle')] },
    ])
    await broker.publish('orders', 1, { type: 't', key: 'k' })
    await waitFor(() => fake.pending('graveyard').length === 1, 'the dead letter')
    const [copy] = fake.pending('graveyard')
    expect(copy).toMatchObject({ subject: 't', sessionId: 'k' })
    expect(copy?.applicationProperties).toMatchObject({
      [MessagingHeaders.DeadLetterReason]: 'non-retryable',
      [MessagingHeaders.Error]: 'permanent',
    })
    await waitFor(() => fake.pending('orders').length === 0, 'the original completed')
  })

  it('completes the message when dead-lettering is disabled', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    class FailingConsumer {
      handle() {
        throw new NonRetryableError('permanent')
      }
    }
    const { broker } = await startApp(driverFor(fake), [
      { class: FailingConsumer, queue: 'orders', options: { deadLetter: false }, handlers: [handler('handle')] },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => fake.callsOf('completeMessage').length === 1, 'the completion')
    expect(fake.pending('orders', true)).toHaveLength(0)
  })
})

describe("retries: 'entity'", () => {
  it('abandons every failure and lets maxDeliveryCount dead-letter natively', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders', { maxDeliveryCount: 3 })
    const attempts: number[] = []
    class FailingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        throw new Error('fail')
      }
    }
    const { broker, logs } = await startApp(driverFor(fake, { retries: 'entity' }), [
      {
        class: FailingConsumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 60_000 } })],
      },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => fake.pending('orders', true).length === 1, 'the native dead letter')
    expect(attempts).toEqual([1, 2, 3])
    expect(fake.callsOf('scheduleMessages')).toHaveLength(0)
    expect(fake.callsOf('deadLetterMessage')).toHaveLength(0)
    expect(fake.pending('orders', true)[0]?.applicationProperties?.['DeadLetterReason']).toBe(
      'MaxDeliveryCountExceeded',
    )
    expect(logs.some(entry => entry.message.includes('dead-letter') && entry.level === 'error')).toBe(false)
  })

  it('dead-letters non-retryable failures natively at once', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders', { maxDeliveryCount: 5 })
    class FailingConsumer {
      handle() {
        throw new NonRetryableError('permanent')
      }
    }
    const { broker } = await startApp(driverFor(fake, { retries: 'entity' }), [
      {
        class: FailingConsumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 1 } })],
      },
    ])
    await broker.publish('orders', 1)
    await waitFor(() => fake.pending('orders', true).length === 1, 'the dead letter')
    expect(fake.callsOf('deadLetterMessage')[0]?.args[1]).toMatchObject({ deadLetterReason: 'non-retryable' })
  })

  it('warns when maxDeliveryCount differs from the attempts, and checks the consumer override', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders', { maxDeliveryCount: 10 })
    class Consumer {
      handle() {}
    }
    const { logs } = await startApp(driverFor(fake, { retries: 'entity' }), [
      {
        class: Consumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 1 } })],
      },
    ])
    expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('after 10 delivery attempt(s)'))).toBe(
      true,
    )
    const error = await caught(
      startApp(driverFor(fake), [
        { class: Consumer, queue: 'orders', options: { retries: 'entity' }, handlers: [handler('handle')] },
      ]),
    )
    expect(messageOf(error)).toContain(
      "@Consumer({ retries: 'entity' }) needs a driver created with azureServiceBus({ retries: 'entity' })",
    )
  })
})

describe('verification and provisioning', () => {
  it('refuses a missing entity, and provisions queues and subscriptions on demand', async () => {
    const fake = new FakeServiceBus()
    class Consumer {
      handle() {}
    }
    const error = await caught(
      startApp(driverFor(fake), [{ class: Consumer, queue: 'orders', handlers: [handler('handle')] }]),
    )
    expect(error).toBeInstanceOf(ZnightError)
    expect(messageOf(error)).toContain('Azure Service Bus: queue "orders" not found')
    await startApp(driverFor(fake, { provision: true }), [
      {
        class: Consumer,
        queue: 'orders',
        handlers: [handler('handle', { retry: { attempts: 12, backoff: 'fixed', delay: 1 } })],
      },
      { class: Consumer, queue: 'events/billing', handlers: [handler('handle')] },
    ])
    expect(fake.entities.get('orders')?.maxDeliveryCount).toBe(12)
    expect(fake.entities.get('events/billing')?.maxDeliveryCount).toBe(10)
    expect(fake.callsOf('createTopic').map(call => call.entity)).toEqual(['events'])
  })

  it('refuses a maxDeliveryCount below the attempts Znight makes', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders', { maxDeliveryCount: 3 })
    class Consumer {
      handle() {}
    }
    const error = await caught(
      startApp(driverFor(fake), [
        {
          class: Consumer,
          queue: 'orders',
          handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 1 } })],
        },
      ]),
    )
    expect(messageOf(error)).toContain(
      'queue "orders" dead-letters messages after 3 delivery attempt(s), but Consumer allows 5 attempt(s)',
    )
  })

  it('refuses session-enabled entities', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders', { requiresSession: true })
    class Consumer {
      handle() {}
    }
    const error = await caught(
      startApp(driverFor(fake), [{ class: Consumer, queue: 'orders', handlers: [handler('handle')] }]),
    )
    expect(messageOf(error)).toContain('queue "orders" requires sessions')
  })

  it('refuses scheduled retries on subscriptions and dead-letter sub-queues', async () => {
    const fake = new FakeServiceBus()
    fake.createSubscription('events', 'billing')
    fake.createQueue('orders')
    class Consumer {
      handle() {}
    }
    const retry = { attempts: 3, backoff: 'fixed' as const, delay: 5000 }
    const subscription = await caught(
      startApp(driverFor(fake), [
        { class: Consumer, queue: 'events/billing', handlers: [handler('handle', { retry })] },
      ]),
    )
    expect(messageOf(subscription)).toContain('cannot schedule a retry on subscription "events/billing"')
    const deadLetters = await caught(
      startApp(driverFor(fake), [
        {
          class: Consumer,
          queue: 'orders/$deadletterqueue',
          options: { deadLetter: false },
          handlers: [handler('handle', { retry })],
        },
      ]),
    )
    expect(messageOf(deadLetters)).toContain('cannot schedule a retry on the dead-letter sub-queue')
    const nested = await caught(
      startApp(driverFor(fake), [{ class: Consumer, queue: 'orders/$deadletterqueue', handlers: [handler('handle')] }]),
    )
    expect(messageOf(nested)).toContain('a dead-letter sub-queue has no dead-letter sub-queue')
  })

  it('checks the entity with a peek when the administration client is refused or disabled', async () => {
    const fake = new FakeServiceBus()
    fake.failures = method => (method.startsWith('get') ? restUnauthorized() : undefined)
    class Consumer {
      handle() {}
    }
    const missing = await caught(
      startApp(driverFor(fake), [{ class: Consumer, queue: 'orders', handlers: [handler('handle')] }]),
    )
    expect(messageOf(missing)).toContain('Azure Service Bus: queue "orders" not found')
    fake.createQueue('orders')
    const { logs } = await startApp(driverFor(fake), [
      { class: Consumer, queue: 'orders', handlers: [handler('handle')] },
    ])
    expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('its settings are not checked'))).toBe(
      true,
    )
    const peeks = fake.callsOf('peekMessages').length
    const disabled = driverFor(fake, { administrationClient: false })
    await startApp(disabled, [{ class: Consumer, queue: 'orders', handlers: [handler('handle')] }])
    expect(fake.callsOf('peekMessages').length).toBe(peeks + 1)
    expect(disabled.administrationClient).toBeUndefined()
  })
})

describe('shutdown', () => {
  it('stops receiving on cancel, gives back late messages and closes its receivers', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    const driver = driverFor(fake, { maxWaitTimeMs: 10_000 })
    const { received, subscription } = await deliveries(driver, 'orders')
    await sleep(20)
    const started = Date.now()
    await subscription.cancel()
    expect(Date.now() - started).toBeLessThan(1000)
    await fake.client.createSender('orders').sendMessages({ body: Buffer.from('1') })
    await sleep(50)
    expect(received).toHaveLength(0)
    await subscription.close()
    await driver.close()
    expect(fake.closed.receivers).toBe(1)
    expect(fake.pending('orders')).toHaveLength(1)
  })

  it('waits for the deliveries in flight before closing', async () => {
    const fake = new FakeServiceBus()
    fake.createQueue('orders')
    await fake.client.createSender('orders').sendMessages({ body: Buffer.from('1') })
    const driver = driverFor(fake)
    const { received, subscription } = await deliveries(driver, 'orders')
    await waitFor(() => received.length === 1, 'the delivery')
    await subscription.cancel()
    let closed = false
    const closing = driver.close().then(() => {
      closed = true
    })
    await sleep(30)
    expect(closed).toBe(false)
    await received[0]?.release()
    await closing
    expect(fake.closed.receivers).toBe(1)
    expect(fake.pending('orders')).toHaveLength(1)
  })
})

// the public conformance kit, against the in-memory namespace (the emulator runs it under
// ZNIGHT_INTEGRATION=1, see test/integration/azure-service-bus.test.ts)
const conformanceBus = new FakeServiceBus()
describeDriverConformance({
  name: 'azure-service-bus (in-memory)',
  driver: overrides => driverFor(conformanceBus, overrides),
  prepareQueue: queue => {
    conformanceBus.createQueue(queue)
    return Promise.resolve()
  },
  test: { describe, it },
  nativeDelayMs: 200,
  timeoutMs: 15_000,
})
