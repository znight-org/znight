import type { InboundMessage } from '../../src/index.ts'

import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka'

import { kafka } from '../../src/drivers/kafka.ts'
import { MessageBroker } from '../../src/index.ts'
import { handler, sleep } from '../helpers.ts'
import { driverConformance, integration, startApp, waitFor } from './conformance.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe.skipIf(!integration)('Kafka (testcontainers)', () => {
  let container: StartedKafkaContainer
  let brokers: string[]

  beforeAll(async () => {
    container = await new KafkaContainer('confluentinc/cp-kafka:8.0.0').start()
    brokers = [`${container.getHost()}:${container.getMappedPort(9093)}`]
  }, 240_000)

  afterAll(async () => {
    await container?.stop()
  })

  const fast = { sessionTimeout: 10_000, rebalanceTimeout: 15_000, heartbeatInterval: 500, maxWaitTime: 200 }

  driverConformance(
    'kafka',
    () => ({
      createDriver: overrides =>
        kafka({
          bootstrapBrokers: brokers,
          createTopics: { partitions: 3 },
          fromBeginning: true,
          consumer: fast,
          ...overrides,
        }),
      prepareQueue: async () => {},
      nativeDelayMs: 1000,
    }),
    { delayedPublish: false },
  )

  it('keeps the order of a partition and handles partitions concurrently', async () => {
    const topic = `kafka-order-${Date.now()}`
    const received: [string | undefined, number][] = []
    let active = 0
    let max = 0
    class Consumer {
      async handle(payload: number, message: InboundMessage) {
        active++
        max = Math.max(max, active)
        await sleep(30)
        received.push([message.key, payload])
        active--
      }
    }
    const app = await startApp(
      kafka({ bootstrapBrokers: brokers, createTopics: { partitions: 4 }, fromBeginning: true, consumer: fast }),
      [{ class: Consumer, queue: topic, options: { concurrency: 4 }, handlers: [handler('handle')] }],
    )
    const broker = app.get(MessageBroker)
    const keys = ['a', 'b', 'c', 'd']
    for (let index = 0; index < 20; index++) await broker.publish(topic, index, { key: keys[index % 4] })
    await waitFor(() => received.length === 20, 60_000, 'twenty records')
    for (const key of keys) {
      const values = received.filter(([k]) => k === key).map(([, value]) => value)
      expect(values).toEqual([...values].sort((a, b) => a - b))
    }
    expect(max).toBeLessThanOrEqual(4)
  })

  it('refuses missing topics unless createTopics is set, and shared consumer groups', async () => {
    class Consumer {
      handle() {}
    }
    const topic = `kafka-missing-${Date.now()}`
    await expect(
      startApp(kafka({ bootstrapBrokers: brokers }), [
        { class: Consumer, queue: topic, handlers: [handler('handle')] },
      ]),
    ).rejects.toThrow('do not exist')
    class Other {
      handle() {}
    }
    await expect(
      startApp(kafka({ bootstrapBrokers: brokers, createTopics: true }), [
        { class: Consumer, queue: `${topic}-a`, options: { groupId: 'shared' }, handlers: [handler('handle')] },
        { class: Other, queue: `${topic}-b`, options: { groupId: 'shared' }, handlers: [handler('handle')] },
      ]),
    ).rejects.toThrow('consumer group "shared" is used for')
  })

  it('does not block the main topic while retries wait', async () => {
    const topic = `kafka-nonblocking-${Date.now()}`
    const events: string[] = []
    class Consumer {
      handle(payload: string, message: InboundMessage) {
        events.push(`${payload}#${message.attempt}`)
        if (payload === 'slow' && message.attempt === 1) throw new Error('retry me later')
      }
    }
    const app = await startApp(
      kafka({ bootstrapBrokers: brokers, createTopics: true, fromBeginning: true, consumer: fast }),
      [
        {
          class: Consumer,
          queue: topic,
          handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 3000 } })],
        },
      ],
    )
    const broker = app.get(MessageBroker)
    await broker.publish(topic, 'slow')
    await waitFor(() => events.length === 1, 30_000)
    await broker.publish(topic, 'fast')
    await waitFor(() => events.includes('fast#1'), 30_000, 'fast message')
    expect(events).toEqual(['slow#1', 'fast#1'])
    await waitFor(() => events.includes('slow#2'), 30_000, 'retry')
  })
})
