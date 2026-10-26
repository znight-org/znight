import type { InboundMessage } from '../../src/index.ts'

import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import { connect } from 'amqplib'

import { RabbitMQDriver, rabbitmq } from '../../src/drivers/rabbitmq.ts'
import { MessageBroker } from '../../src/index.ts'
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
})
