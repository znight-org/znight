/**
 * RabbitMQ driver against a fake amqplib (`fake-amqplib.ts`): recovery after connection losses,
 * closed channels and cancelled consumers, copies of routed messages, quorum delivery limits, the
 * delay levels of delayed publications and the correlation of returned messages. The behaviour of a
 * real broker is covered by `test/integration/rabbitmq.test.ts`.
 */
import type { DeliveryHandler, DriverDelivery, SubscribeOptions } from '../../src/driver.ts'
import type { OutboundMessage } from '../../src/message.ts'
import type { FakeMessage } from './fake-amqplib.ts'

import * as realAmqplib from 'amqplib'

import { memoryLogger, messageOf } from '../helpers.ts'
import { fakeBroker, connect as fakeConnect } from './fake-amqplib.ts'
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'

const originalAmqplib = { ...realAmqplib }
mock.module('amqplib', () => ({ ...originalAmqplib, connect: fakeConnect }))
afterAll(() => {
  mock.module('amqplib', () => originalAmqplib)
})

const { rabbitmq } = await import('../../src/drivers/rabbitmq.ts')

const options: SubscribeOptions = {
  consumer: 'TestConsumer',
  concurrency: 1,
  deadLetterQueue: undefined,
  maxAttempts: 3,
  retryDelays: [],
  options: {},
}

function outbound(id: string, extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id,
    type: undefined,
    key: undefined,
    headers: {},
    body: '{}',
    contentType: 'application/json',
    timestamp: Date.now(),
    delayMs: 0,
    ...extra,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

/** A driver connected to the fake broker, with a fast reconnection. */
async function connected(extra: Partial<Parameters<typeof rabbitmq>[0]> = {}) {
  const logger = memoryLogger()
  const driver = rabbitmq({ url: 'amqp://fake', reconnect: { initialDelayMs: 2, maxDelayMs: 10 }, ...extra })
  await driver.connect({ logger })
  const lines = (): string[] => logger.entries.map(entry => `${entry.level} ${entry.message}`)
  return { driver, logger, lines }
}

const ignore: DeliveryHandler = async () => {}

beforeEach(() => {
  fakeBroker.reset()
})

describe('recovery', () => {
  it('reconnects again when the connection is lost while the consumers resume', async () => {
    const { driver, lines } = await connected()
    await driver.subscribe('q', ignore, options)
    let releaseChannel: (() => void) | undefined
    fakeBroker.onCreateChannel = model => {
      if (model !== fakeBroker.models[1]) return undefined
      return new Promise<void>(resolve => {
        releaseChannel = resolve
      })
    }
    ;(fakeBroker.models[0] as (typeof fakeBroker.models)[0]).kill(new Error('CONNECTION_FORCED'))
    await waitFor(() => releaseChannel !== undefined)
    // the second connection is lost while the consumer channel opens on it
    fakeBroker.models[1]?.kill(new Error('CONNECTION_FORCED'))
    releaseChannel?.()
    await waitFor(() => fakeBroker.connects === 3 && fakeBroker.active('q').length === 1)
    expect(fakeBroker.active('q')[0]?.channel.model).toBe(fakeBroker.models[2] as (typeof fakeBroker.models)[0])
    await driver.publish('q', outbound('after'))
    expect(fakeBroker.publications.at(-1)?.routingKey).toBe('q')
    await waitFor(() => lines().includes('info RabbitMQ connection restored'))
    await driver.close()
  })

  it('retries a subscription that fails to resume after a reconnection', async () => {
    const { driver, lines } = await connected()
    await driver.subscribe('q', ignore, options)
    let failures = 1
    fakeBroker.onCreateChannel = model => {
      if (model === fakeBroker.models[1] && failures-- > 0) throw new Error('transient channel failure')
    }
    fakeBroker.models[0]?.kill(new Error('CONNECTION_FORCED'))
    await waitFor(() => fakeBroker.consumers.length === 2 && fakeBroker.active('q').length === 1)
    expect(fakeBroker.connects).toBe(2)
    expect(lines()).toContain('error RabbitMQ: cannot consume "q" again')
    await waitFor(() => lines().includes('info RabbitMQ connection restored'))
    await driver.close()
  })

  it('keeps reconnecting while the broker is unreachable', async () => {
    const { driver } = await connected()
    await driver.subscribe('q', ignore, options)
    fakeBroker.connectFailures = 3
    fakeBroker.models[0]?.kill()
    await waitFor(() => fakeBroker.active('q').length === 1 && fakeBroker.models.length === 2)
    expect(fakeBroker.connects).toBe(5)
    await driver.close()
  })

  it('consumes again when a consumer channel closes on a channel error', async () => {
    const { driver, lines } = await connected()
    await driver.subscribe('q', ignore, options)
    const first = fakeBroker.active('q')[0]
    first?.channel.fail(new Error('PRECONDITION_FAILED - delivery acknowledgement timed out'))
    await waitFor(() => fakeBroker.active('q').length === 1 && fakeBroker.consumers.length === 2)
    expect(fakeBroker.connects).toBe(1)
    expect(lines()).toContain('info RabbitMQ: consuming "q" again')
    await driver.close()
  })

  it('resubscribes (declaring the queues again) when the broker cancels the consumer', async () => {
    const { driver, lines } = await connected()
    await driver.subscribe('q', ignore, { ...options, deadLetterQueue: 'q.dlq' })
    const first = fakeBroker.active('q')[0]
    fakeBroker.declarations.length = 0
    fakeBroker.cancelConsumers('q') // queue deleted and re-created by an operator
    await waitFor(() => fakeBroker.active('q').length === 1)
    expect(first?.channel.closed).toBe(true)
    expect(fakeBroker.declarations.map(declaration => declaration.name)).toEqual(['q', 'q.dlq'])
    expect(lines()).toContain('error RabbitMQ cancelled the consumer of "q" (queue deleted?), consuming again')
    await driver.close()
  })

  it('retries with backoff while the cancelled queue cannot be consumed', async () => {
    const { driver } = await connected({ assertTopology: false })
    await driver.subscribe('q', ignore, options)
    let failures = 2
    fakeBroker.onCreateChannel = () => {
      if (failures-- > 0) throw new Error("NOT_FOUND - no queue 'q'")
    }
    fakeBroker.cancelConsumers('q')
    await waitFor(() => fakeBroker.active('q').length === 1)
    expect(fakeBroker.declarations).toEqual([]) // assertTopology: false never declares
    await driver.close()
  })

  it('does not resubscribe a cancelled or closed subscription', async () => {
    const { driver } = await connected()
    const subscription = await driver.subscribe('q', ignore, options)
    await subscription.cancel()
    await subscription.close()
    fakeBroker.models[0]?.kill()
    await waitFor(() => fakeBroker.models.length === 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fakeBroker.consumers).toHaveLength(1)
    await driver.close()
  })
})

describe('republished copies', () => {
  async function received(extra: Parameters<typeof connected>[0] = {}) {
    const { driver } = await connected(extra)
    const deliveries: DriverDelivery[] = []
    await driver.subscribe(
      'q',
      delivery => {
        deliveries.push(delivery)
        return Promise.resolve()
      },
      options,
    )
    return { driver, deliveries }
  }

  it('keeps the type read from the routing key on retries and dead letters', async () => {
    const { driver, deliveries } = await received({ typeFromRoutingKey: true })
    fakeBroker.deliver('q', { exchange: 'events', routingKey: 'order.created', properties: { messageId: 'm1' } })
    await waitFor(() => deliveries.length === 1)
    expect(deliveries[0]?.type).toBe('order.created')

    await deliveries[0]?.retry({ attempt: 2, delayMs: 0, error: new Error('boom') })
    const copy = fakeBroker.publications.at(-1)
    expect(copy).toMatchObject({ exchange: '', routingKey: 'q' })
    expect(copy?.options.type).toBe('order.created')

    // the copy comes back through the default exchange: no routing key to read the type from
    fakeBroker.deliver('q', { exchange: '', routingKey: 'q', properties: copy?.options as FakeMessage['properties'] })
    await waitFor(() => deliveries.length === 2)
    expect(deliveries[1]).toMatchObject({ type: 'order.created', attempt: 2 })

    await deliveries[1]?.deadLetter({ queue: 'q.dlq', reason: 'max-attempts', error: new Error('boom'), attempt: 2 })
    const dead = fakeBroker.publications.at(-1)
    expect(dead).toMatchObject({ exchange: '', routingKey: 'q.dlq' })
    expect(dead?.options.type).toBe('order.created')
    await driver.close()
  })

  it('never copies broker headers nor CC/BCC destinations', async () => {
    const { driver, deliveries } = await received()
    fakeBroker.deliver('q', {
      properties: {
        messageId: 'm1',
        type: 'order.created',
        headers: {
          'x-tenant': 'acme',
          CC: ['q', 'other'],
          BCC: ['spy'],
          'x-death': [{ count: 1 }],
          'x-delivery-count': 1,
        },
      },
    })
    await waitFor(() => deliveries.length === 1)
    await deliveries[0]?.retry({ attempt: 3, delayMs: 0, error: new Error('boom') })
    expect(fakeBroker.publications.at(-1)?.options.headers).toEqual({ 'x-tenant': 'acme', 'x-znight-attempt': '3' })
    await driver.close()
  })
})

describe('quorum queues delivery limit', () => {
  const declared = (name: string) => fakeBroker.declarations.filter(declaration => declaration.name === name)

  it('declares consumed and dead-letter quorum queues without delivery limit on RabbitMQ 4', async () => {
    const { driver } = await connected()
    await driver.subscribe('q', ignore, { ...options, deadLetterQueue: 'q.dlq', retryDelays: [10_000] })
    expect(declared('q')[0]?.arguments).toEqual({ 'x-queue-type': 'quorum', 'x-delivery-limit': -1 })
    expect(declared('q.dlq')[0]?.arguments).toEqual({ 'x-queue-type': 'quorum', 'x-delivery-limit': -1 })
    // nothing consumes delay queues
    expect(declared('q.delay.10000')[0]?.arguments['x-delivery-limit']).toBeUndefined()
    await driver.close()
  })

  it('keeps a configured delivery limit, classic queues and RabbitMQ 3 untouched', async () => {
    const configured = await connected({ queueArguments: { 'x-delivery-limit': 50 } })
    await configured.driver.subscribe('a', ignore, options)
    expect(declared('a')[0]?.arguments).toEqual({ 'x-queue-type': 'quorum', 'x-delivery-limit': 50 })
    await configured.driver.close()

    const classic = await connected({ queueType: 'classic' })
    await classic.driver.subscribe('b', ignore, options)
    expect(declared('b')[0]?.arguments).toEqual({ 'x-queue-type': 'classic' })
    await classic.driver.close()

    fakeBroker.version = '3.13.7' // no default delivery limit, and -1 is not accepted
    const old = await connected()
    await old.driver.subscribe('c', ignore, options)
    expect(declared('c')[0]?.arguments).toEqual({ 'x-queue-type': 'quorum' })
    await old.driver.close()
  })

  it('declares an existing queue as it is, with a warning, when it has no delivery limit', async () => {
    fakeBroker.onAssertQueue = (name, args) =>
      args['x-delivery-limit'] === undefined
        ? undefined
        : new Error(
            `Operation failed: QueueDeclare; 406 (PRECONDITION-FAILED) with message "PRECONDITION_FAILED - inequivalent arg 'x-delivery-limit' for queue '${name}' in vhost '/': received the value '-1' of type 'byte' but current is none"`,
          )
    const { driver, logger } = await connected()
    await driver.subscribe('q', ignore, options)
    expect(declared('q').map(declaration => declaration.arguments)).toEqual([
      { 'x-queue-type': 'quorum', 'x-delivery-limit': -1 },
      { 'x-queue-type': 'quorum' },
    ])
    expect(fakeBroker.active('q')).toHaveLength(1)
    const warning = logger.entries.find(entry => entry.level === 'warn')
    expect(warning?.message).toStartWith('RabbitMQ: queue "q" exists without "x-delivery-limit"')
    await driver.close()
  })
})

describe('delayed publications', () => {
  /** Topic matching of the delay routing keys (patterns of `*` and literal words, exact word count). */
  function matches(pattern: string, key: string): boolean {
    const words = key.split('.')
    const parts = pattern.split('.')
    return parts.length === words.length && parts.every((part, index) => part === '*' || part === words[index])
  }

  /** Follows a delayed publication through the declared topology: total wait and levels crossed. */
  function route(exchange: string, routingKey: string): { readonly waitMs: number; readonly queues: string[] } {
    let current = exchange
    let waitMs = 0
    const queues: string[] = []
    for (let hops = 0; hops < 200; hops++) {
      const targets = fakeBroker.bindings.filter(
        binding => binding.source === current && matches(binding.pattern, routingKey),
      )
      expect(targets).toHaveLength(1)
      const target = targets[0] as (typeof fakeBroker.bindings)[0]
      if (target.kind === 'exchange') {
        current = target.destination
        continue
      }
      const args = fakeBroker.declarations.find(declaration => declaration.name === target.destination)?.arguments ?? {}
      queues.push(target.destination)
      waitMs += args['x-message-ttl'] as number
      current = args['x-dead-letter-exchange'] as string
      if (current === '') return { waitMs, queues } // default exchange: the CC header routes it home
    }
    throw new Error('no route')
  }

  it('uses the same 32 delay levels whatever the delays', async () => {
    const { driver } = await connected({ assertTopology: false })
    for (let index = 0; index < 50; index++) {
      await driver.publish('reminders', outbound(`r${index}`, { delayMs: 3_600_000 + index * 5 }))
    }
    const names = [...new Set(fakeBroker.declarations.map(declaration => declaration.name))]
    expect(names).toEqual(Array.from({ length: 32 }, (_, level) => `znight.delays.${level}`))
    expect(fakeBroker.declarations).toHaveLength(32) // declared once per connection
    expect(fakeBroker.exchanges).toHaveLength(32)
    expect(fakeBroker.bindings).toHaveLength(63)
    expect(fakeBroker.declarations[3]?.arguments).toEqual({
      'x-queue-type': 'quorum',
      'x-message-ttl': 8,
      'x-dead-letter-exchange': 'znight.delays.2',
      'x-dead-letter-strategy': 'at-least-once',
      'x-overflow': 'reject-publish',
    })
    expect(fakeBroker.declarations[0]?.arguments['x-dead-letter-exchange']).toBe('')
    await driver.close()
  })

  it('routes each delayed publication through the levels of its delay, then home through CC', async () => {
    const { driver } = await connected()
    const delays = [1, 2, 5, 1000, 1001, 3_600_005, 2 ** 31, 4_294_967_294, 4_294_967_295]
    for (const delayMs of delays) {
      fakeBroker.publications.length = 0
      await driver.publish('reminders', outbound('m', { delayMs, headers: { 'x-tenant': 'acme' } }))
      const [publication] = fakeBroker.publications
      expect(publication?.options.headers).toEqual({ 'x-tenant': 'acme', CC: ['reminders'] })
      const { waitMs, queues } = route(publication?.exchange as string, publication?.routingKey as string)
      // never early, at most 1 ms late (rounded up to an odd number of milliseconds)
      expect(waitMs).toBe(delayMs % 2 === 0 ? delayMs + 1 : delayMs)
      expect(queues.at(-1)).toBe('znight.delays.0')
    }
    expect(fakeBroker.publications[0]?.exchange).toBe('znight.delays.31')
    await driver.close()
  })

  it('names the levels after delayLevelPrefix and declares classic levels for classic queues', async () => {
    const { driver } = await connected({ delayLevelPrefix: 'app.delays', queueType: 'classic' })
    await driver.publish('q', outbound('m', { delayMs: 5 }))
    expect(fakeBroker.publications[0]).toMatchObject({
      exchange: 'app.delays.2',
      routingKey: `znight-delay.${'0.'.repeat(29)}1.0.1`,
    })
    expect(fakeBroker.declarations[1]?.arguments).toEqual({
      'x-queue-type': 'classic',
      'x-message-ttl': 2,
      'x-dead-letter-exchange': 'app.delays.0',
    })
    await driver.close()
  })
})

describe('returned publications', () => {
  it('fails only the publication that was returned when two share a message id', async () => {
    const { driver } = await connected()
    fakeBroker.missingQueues.add('missing')
    fakeBroker.confirmDelayMs = 5 // quorum queue: the routable publication is confirmed after the return
    const settle = (promise: Promise<void>): Promise<string> =>
      promise.then(
        () => 'ok',
        (error: unknown) => `failed: ${messageOf(error)}`,
      )
    const [orders, missing] = await Promise.all([
      settle(driver.publish('orders', outbound('evt-1'))),
      settle(driver.publish('missing', outbound('evt-1'))),
    ])
    expect(orders).toBe('ok')
    expect(missing).toBe('failed: ZNIGHT021: RabbitMQ: message evt-1 is unroutable, queue "missing" does not exist')
    await driver.close()
  })

  it('fails every returned publication of the same queue and id', async () => {
    const { driver } = await connected()
    fakeBroker.missingQueues.add('missing')
    const results = await Promise.allSettled([
      driver.publish('missing', outbound('dup')),
      driver.publish('missing', outbound('dup')),
    ])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    await driver.close()
  })

  it('declares a retry delay queue again once a retry to it was returned (queue deleted)', async () => {
    const { driver } = await connected()
    const deliveries: DriverDelivery[] = []
    await driver.subscribe(
      'q',
      delivery => {
        deliveries.push(delivery)
        return Promise.resolve()
      },
      { ...options, retryDelays: [10_000] },
    )
    const declarations = () => fakeBroker.declarations.filter(declaration => declaration.name === 'q.delay.10000')
    expect(declarations()).toHaveLength(1)
    fakeBroker.missingQueues.add('q.delay.10000')
    fakeBroker.deliver('q', { properties: { messageId: 'm1' } })
    fakeBroker.deliver('q', { properties: { messageId: 'm2' } })
    await waitFor(() => deliveries.length === 2)
    const error = await deliveries[0]?.retry({ attempt: 2, delayMs: 10_000, error: new Error('x') }).catch(e => e)
    expect(messageOf(error)).toContain('is unroutable, queue "q.delay.10000" does not exist')
    fakeBroker.missingQueues.delete('q.delay.10000')
    await deliveries[1]?.retry({ attempt: 2, delayMs: 10_000, error: new Error('x') })
    expect(declarations()).toHaveLength(2)
    await driver.close()
  })
})
