import type { InboundMessage } from '../../src/index.ts'

import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import { connect } from 'amqplib'

import { RabbitMQDriver, rabbitmq } from '../../src/drivers/rabbitmq.ts'
import { MessageBroker, NonRetryableError } from '../../src/index.ts'
import { handler, memoryLogger, sleep } from '../helpers.ts'
import { driverConformance, integration, startApp, waitFor } from './conformance.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe.skipIf(!integration)('RabbitMQ (testcontainers)', () => {
  let container: StartedRabbitMQContainer
  let url: string

  beforeAll(async () => {
    container = await new RabbitMQContainer('rabbitmq:4.1-alpine').start()
    url = container.getAmqpUrl()
  }, 180_000)

  afterAll(async () => {
    await container?.stop()
  })

  driverConformance(
    'rabbitmq',
    () => ({
      createDriver: overrides => rabbitmq({ url, reconnect: { initialDelayMs: 100, maxDelayMs: 1000 }, ...overrides }),
      prepareQueue: async () => {},
      nativeDelayMs: 1000,
    }),
    { delayedPublish: true },
  )

  it('counts redeliveries of quorum queues (x-delivery-count)', async () => {
    const attempts: number[] = []
    let released = false
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
      }
    }
    const queue = `rabbit-count-${Date.now()}`
    const driver = rabbitmq({ url })
    // release the first delivery by hand, through the raw driver API
    const original = driver.subscribe.bind(driver)
    driver.subscribe = (q, deliveryHandler, options) =>
      original(
        q,
        async delivery => {
          if (!released) {
            released = true
            await delivery.release()
            return
          }
          await deliveryHandler(delivery)
        },
        options,
      )
    const app = await startApp(driver, [{ class: Consumer, queue, handlers: [handler('handle')] }])
    await app.get(MessageBroker).publish(queue, 1)
    await waitFor(() => attempts.length === 1)
    expect(attempts).toEqual([2])
    await app.stop()
  })

  it('fails to publish to a queue that does not exist (mandatory)', async () => {
    const driver = rabbitmq({ url })
    await driver.connect({ logger: memoryLogger() })
    await expect(
      driver.publish('no-such-queue', {
        id: 'x',
        type: undefined,
        key: undefined,
        headers: {},
        body: '1',
        contentType: 'application/json',
        timestamp: Date.now(),
        delayMs: 0,
      }),
    ).rejects.toThrow('unroutable')
    await driver.close()
  })

  it('verifies queues exist when assertTopology is false', async () => {
    class Consumer {
      handle() {}
    }
    const driver = rabbitmq({ url, assertTopology: false })
    await expect(
      startApp(driver, [{ class: Consumer, queue: 'missing-queue', handlers: [handler('handle')] }]),
    ).rejects.toThrow('queue "missing-queue" of consumer Consumer does not exist')
  })

  it('reports queues declared with incompatible arguments', async () => {
    const queue = `rabbit-classic-${Date.now()}`
    const connection = await connect(url)
    const channel = await connection.createChannel()
    await channel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'classic' } })
    await connection.close()
    class Consumer {
      handle() {}
    }
    await expect(
      startApp(rabbitmq({ url }), [{ class: Consumer, queue, handlers: [handler('handle')] }]),
    ).rejects.toThrow('PRECONDITION_FAILED')
    // classic queues work with queueType: 'classic' (attempts from the redelivered flag)
    const received: number[] = []
    class ClassicConsumer {
      handle(payload: number) {
        received.push(payload)
      }
    }
    const app = await startApp(rabbitmq({ url, queueType: 'classic' }), [
      { class: ClassicConsumer, queue, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(queue, 7)
    await waitFor(() => received.length === 1)
    expect(received).toEqual([7])
  })

  it('reconnects and resumes consuming after a connection loss', async () => {
    const received: unknown[] = []
    class Consumer {
      handle(payload: unknown) {
        received.push(payload)
      }
    }
    const queue = `rabbit-reconnect-${Date.now()}`
    const driver = new RabbitMQDriver({
      url,
      reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
      connectionName: 'znight-reconnect',
    })
    const logger = memoryLogger()
    const app = await startApp(driver, [{ class: Consumer, queue, handlers: [handler('handle')] }], logger)
    const broker = app.get(MessageBroker)
    await broker.publish(queue, 'before')
    await waitFor(() => received.length === 1)
    const result = await container.exec(['rabbitmqctl', 'close_all_connections', 'test'])
    expect(result.exitCode).toBe(0)
    // publish until the connection is back
    let published = false
    const deadline = Date.now() + 20_000
    while (!published && Date.now() < deadline) {
      try {
        await broker.publish(queue, 'after')
        published = true
      } catch {
        await sleep(100)
      }
    }
    expect(published).toBe(true)
    await waitFor(() => received.includes('after'), 20_000, 'message after reconnection')
    expect(logger.entries.map(entry => entry.message)).toEqual(
      expect.arrayContaining(['RabbitMQ connection lost, reconnecting', 'RabbitMQ connection restored']),
    )
  })

  /** Runs `fn` on a channel of a separate connection (a failed operation closes only that channel). */
  async function withChannel<T>(
    fn: (channel: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>['createChannel']>>) => Promise<T>,
  ): Promise<T> {
    const connection = await connect(url)
    try {
      const channel = await connection.createChannel()
      channel.on('error', () => undefined)
      return await fn(channel)
    } finally {
      await connection.close().catch(() => undefined)
    }
  }

  it('keeps the type read from the routing key on retries through a delay queue', async () => {
    const seen: [number, string | undefined][] = []
    class Consumer {
      handle(_payload: unknown, message: InboundMessage) {
        seen.push([message.attempt, message.type])
        if (message.attempt < 3) throw new Error('transient')
      }
    }
    const queue = `rabbit-rk-${Date.now()}`
    const app = await startApp(rabbitmq({ url, typeFromRoutingKey: true, maxInProcessDelayMs: 0 }), [
      {
        class: Consumer,
        queue,
        handlers: [handler('handle', { type: 'order.created', retry: { attempts: 3, backoff: 'fixed', delay: 50 } })],
      },
    ])
    const connection = await connect(url)
    const channel = await connection.createConfirmChannel()
    await channel.assertExchange(`${queue}.events`, 'topic', { durable: false, autoDelete: true })
    await channel.bindQueue(queue, `${queue}.events`, 'order.*')
    channel.publish(`${queue}.events`, 'order.created', Buffer.from('{}'), {
      messageId: 'm1',
      contentType: 'application/json',
    })
    await channel.waitForConfirms()
    await connection.close()
    await waitFor(() => seen.length === 3, 20_000, 'three attempts')
    expect(seen).toEqual([
      [1, 'order.created'],
      [2, 'order.created'],
      [3, 'order.created'],
    ])
    await app.stop()
  })

  it('never lets the quorum delivery limit drop a message released many times', async () => {
    const queue = `rabbit-limit-${Date.now()}`
    class Consumer {
      handle() {
        throw new NonRetryableError('poison')
      }
    }
    const logger = memoryLogger()
    const app = await startApp(rabbitmq({ url }), [{ class: Consumer, queue, handlers: [handler('handle')] }], logger)
    // the dead-letter queue disappears: dead-lettering fails, the message is released again and again
    await withChannel(channel => channel.deleteQueue(`${queue}.dlq`))
    await app.get(MessageBroker).publish(queue, 1)
    const failures = () =>
      logger.entries.filter(entry => entry.message.includes('failed to dead-letter message')).length
    await waitFor(() => failures() >= 25, 30_000, '25 releases')
    // RabbitMQ 4 would have dropped it after 20 deliveries: it is still there, and dead-lettered once possible
    await withChannel(channel =>
      channel.assertQueue(`${queue}.dlq`, {
        durable: true,
        arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': -1 },
      }),
    )
    let dead = 0
    const deadline = Date.now() + 20_000
    while (dead === 0 && Date.now() < deadline) {
      dead = (await withChannel(channel => channel.checkQueue(`${queue}.dlq`))).messageCount
      if (dead === 0) await sleep(100)
    }
    expect(dead).toBe(1)
    await app.stop()
  })

  it('delays publications through the shared delay levels', async () => {
    const received: [string, number][] = []
    class Consumer {
      handle(payload: string) {
        received.push([payload, Date.now()])
      }
    }
    const queue = `rabbit-delayed-${Date.now()}`
    const app = await startApp(rabbitmq({ url }), [{ class: Consumer, queue, handlers: [handler('handle')] }])
    const broker = app.get(MessageBroker)
    const start = Date.now()
    await broker.publish(queue, 'late', { delay: 900 })
    await broker.publish(queue, 'early', { delay: 300 })
    await broker.publish(queue, 'now')
    await waitFor(() => received.length === 3, 20_000, 'three messages')
    expect(received.map(([payload]) => payload)).toEqual(['now', 'early', 'late'])
    expect((received[1]?.[1] ?? 0) - start).toBeGreaterThanOrEqual(300)
    expect((received[2]?.[1] ?? 0) - start).toBeGreaterThanOrEqual(900)
    // no queue per delay
    await withChannel(channel => channel.checkQueue('znight.delays.0'))
    await expect(withChannel(channel => channel.checkQueue(`${queue}.delay.900`))).rejects.toThrow('NOT_FOUND')
    await app.stop()
  })

  it('fails only the returned publication when concurrent publications share an id', async () => {
    const queue = `rabbit-return-${Date.now()}`
    await withChannel(channel => channel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } }))
    const driver = rabbitmq({ url })
    await driver.connect({ logger: memoryLogger() })
    const message = (id: string) => ({
      id,
      type: undefined,
      key: undefined,
      headers: {},
      body: '1',
      contentType: 'application/json',
      timestamp: Date.now(),
      delayMs: 0,
    })
    for (let run = 0; run < 10; run++) {
      const [existing, missing] = await Promise.allSettled([
        driver.publish(queue, message(`evt-${run}`)),
        driver.publish(`${queue}-missing`, message(`evt-${run}`)),
      ])
      expect([existing.status, missing.status]).toEqual(['fulfilled', 'rejected'])
    }
    await driver.close()
  })

  it('resumes consuming when the broker cancels the consumer (queue deleted)', async () => {
    const received: unknown[] = []
    class Consumer {
      handle(payload: unknown) {
        received.push(payload)
      }
    }
    const queue = `rabbit-cancel-${Date.now()}`
    const logger = memoryLogger()
    const app = await startApp(
      rabbitmq({ url, reconnect: { initialDelayMs: 50, maxDelayMs: 500 } }),
      [{ class: Consumer, queue, handlers: [handler('handle')] }],
      logger,
    )
    const broker = app.get(MessageBroker)
    await broker.publish(queue, 1)
    await waitFor(() => received.length === 1)
    await withChannel(channel => channel.deleteQueue(queue))
    // the driver declares the queue again (assertTopology) and consumes it
    let published = false
    const deadline = Date.now() + 20_000
    while (!published && Date.now() < deadline) {
      try {
        await broker.publish(queue, 2)
        published = true
      } catch {
        await sleep(100)
      }
    }
    expect(published).toBe(true)
    await waitFor(() => received.includes(2), 20_000, 'message after the cancellation')
    expect(logger.entries.map(entry => entry.message)).toContain(
      `RabbitMQ cancelled the consumer of "${queue}" (queue deleted?), consuming again`,
    )
    await app.stop()
  })
})
