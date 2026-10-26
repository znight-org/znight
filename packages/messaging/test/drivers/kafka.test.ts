/**
 * Kafka driver against a fake `@platformatic/kafka`: what the subscription does with the records its
 * streams emit (rebalances re-fetching from the committed offset, revoked partitions, back-pressure
 * of the main and retry streams, long retry delays). The behaviour of a real cluster is covered by
 * `test/integration/kafka.test.ts`.
 */
import type { GroupAssignment } from '@platformatic/kafka'
import type { DriverDelivery, SubscribeOptions } from '../../src/driver.ts'

import { EventEmitter } from 'node:events'
import * as realKafka from '@platformatic/kafka'

import { MAX_TIMER_DELAY_MS } from '../../src/internal/async.ts'
import { deferred, memoryLogger } from '../helpers.ts'
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

/** A `MessagesStream`: emits the records the test pushes. */
class FakeStream extends EventEmitter {
  paused = false
  readonly topic: string

  constructor(topic: string) {
    super()
    this.topic = topic
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

const streams: FakeStream[] = []
const consumers: FakeConsumer[] = []
/** `topic:partition@offset` of every commit, in order. */
const commits: string[] = []

/** A group consumer: `assignments` is what the last join assigned (set by the test before emitting it). */
class FakeConsumer extends EventEmitter {
  assignments: GroupAssignment[] | null = null
  readonly groupId: string

  constructor(options: { groupId: string }) {
    super()
    this.groupId = options.groupId
    consumers.push(this)
  }

  consume(options: { topics: string[] }): Promise<FakeStream> {
    const stream = new FakeStream(options.topics[0] as string)
    streams.push(stream)
    return Promise.resolve(stream)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  /** A (re)join of the group with a new assignment. */
  join(topic: string, partitions: number[]): void {
    this.assignments = [{ topic, partitions }]
    this.emit('consumer:group:join', { groupId: this.groupId, assignments: this.assignments })
  }
}

class FakeProducer {
  metadata(): Promise<object> {
    return Promise.resolve({})
  }
  send(): Promise<object> {
    return Promise.resolve({})
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeAdmin {
  listTopics(): Promise<string[]> {
    return Promise.resolve(['orders', 'znight.orders.retry'])
  }
  createTopics(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const originalKafka = { ...realKafka }
mock.module('@platformatic/kafka', () => ({
  ...originalKafka,
  Admin: FakeAdmin,
  Producer: FakeProducer,
  Consumer: FakeConsumer,
}))
afterAll(() => {
  mock.module('@platformatic/kafka', () => originalKafka)
})

const { kafka } = await import('../../src/drivers/kafka.ts')

const options: SubscribeOptions = {
  consumer: 'OrderConsumer',
  concurrency: 1,
  deadLetterQueue: undefined,
  maxAttempts: 1,
  retryDelays: [],
  options: {},
}

function record(topic: string, partition: number, offset: number, headers: [string, string][] = []) {
  return {
    topic,
    partition,
    offset: BigInt(offset),
    key: null,
    value: Buffer.from(`${partition}:${offset}`),
    timestamp: BigInt(Date.now()),
    headers: new Map(headers),
    commit: (): Promise<void> => {
      commits.push(`${topic}:${partition}@${offset + 1}`)
      return Promise.resolve()
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

beforeEach(() => {
  streams.length = 0
  consumers.length = 0
  commits.length = 0
})

describe('rebalances', () => {
  it('skips the records a kept partition fetches again from its committed offset', async () => {
    const driver = kafka({ bootstrapBrokers: ['kafka:9092'] })
    await driver.connect({ logger: memoryLogger() })
    const handled: string[] = []
    const first = deferred()
    const subscription = await driver.subscribe(
      'orders',
      async (delivery: DriverDelivery) => {
        handled.push(String(delivery.body))
        if (handled.length === 1) await first.promise
        await delivery.ack()
      },
      options,
    )
    const [main] = streams as [FakeStream]
    const [consumer] = consumers as [FakeConsumer]
    consumer.join('orders', [0])
    for (let offset = 0; offset < 5; offset++) main.emit('data', record('orders', 0, offset))
    await waitFor(() => handled.length === 1)
    // a rebalance keeps partition 0: the stream fetches it again from the committed offset (0)
    consumer.join('orders', [0])
    for (let offset = 0; offset < 5; offset++) main.emit('data', record('orders', 0, offset))
    first.resolve()
    await waitFor(() => commits.length === 5)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handled).toEqual(['0:0', '0:1', '0:2', '0:3', '0:4'])
    expect(commits).toEqual(['orders:0@1', 'orders:0@2', 'orders:0@3', 'orders:0@4', 'orders:0@5'])
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('drops the buffered records of a revoked partition, and handles them again once reassigned', async () => {
    const driver = kafka({ bootstrapBrokers: ['kafka:9092'] })
    await driver.connect({ logger: memoryLogger() })
    const handled: string[] = []
    const first = deferred()
    const subscription = await driver.subscribe(
      'orders',
      async (delivery: DriverDelivery) => {
        handled.push(String(delivery.body))
        if (handled.length === 1) await first.promise
        await delivery.ack()
      },
      options,
    )
    const [main] = streams as [FakeStream]
    const [consumer] = consumers as [FakeConsumer]
    consumer.join('orders', [0, 1])
    for (let offset = 0; offset < 3; offset++) main.emit('data', record('orders', 0, offset))
    for (let offset = 0; offset < 3; offset++) main.emit('data', record('orders', 1, offset))
    await waitFor(() => handled.length === 1)
    consumer.join('orders', [0]) // partition 1 now belongs to another member
    main.emit('data', record('orders', 1, 3)) // late record of a fetch made before the rebalance
    first.resolve()
    await waitFor(() => commits.length === 3)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handled).toEqual(['0:0', '0:1', '0:2'])

    // assigned back: fetched again from its committed offset, nothing is skipped
    consumer.join('orders', [0, 1])
    for (let offset = 0; offset < 3; offset++) main.emit('data', record('orders', 1, offset))
    await waitFor(() => handled.length === 6)
    expect(handled.slice(3)).toEqual(['1:0', '1:1', '1:2'])
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })
})

describe('back-pressure', () => {
  it('pauses only the retry stream while its records wait for their not-before', async () => {
    const driver = kafka({ bootstrapBrokers: ['kafka:9092'] })
    await driver.connect({ logger: memoryLogger() })
    const handled: string[] = []
    const subscription = await driver.subscribe(
      'orders',
      async (delivery: DriverDelivery) => {
        handled.push(String(delivery.body))
        await delivery.ack()
      },
      { ...options, maxAttempts: 3 },
    )
    const [main, retry] = streams as [FakeStream, FakeStream]
    expect(retry.topic).toBe('znight.orders.retry')
    const notBefore = String(Date.now() + 60_000)
    for (let offset = 0; offset < 64; offset++) {
      retry.emit(
        'data',
        record('znight.orders.retry', 0, offset, [
          ['x-znight-not-before', notBefore],
          ['x-znight-attempt', '2'],
        ]),
      )
    }
    expect(retry.paused).toBe(true)
    expect(main.paused).toBe(false)
    main.emit('data', record('orders', 0, 0))
    await waitFor(() => handled.length === 1)
    expect(handled).toEqual(['0:0'])
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })

  it('pauses and resumes the main stream around its own high-water mark', async () => {
    const driver = kafka({ bootstrapBrokers: ['kafka:9092'] })
    await driver.connect({ logger: memoryLogger() })
    const gate = deferred()
    const subscription = await driver.subscribe(
      'orders',
      async (delivery: DriverDelivery) => {
        await gate.promise
        await delivery.ack()
      },
      options,
    )
    const [main] = streams as [FakeStream]
    for (let offset = 0; offset < 64; offset++) main.emit('data', record('orders', 0, offset))
    expect(main.paused).toBe(true)
    gate.resolve()
    await waitFor(() => !main.paused)
    expect(commits.length).toBeGreaterThanOrEqual(32)
    await waitFor(() => commits.length === 64)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })
})

describe('retry delays', () => {
  let timeouts: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>> | undefined

  afterEach(() => {
    timeouts?.mockRestore()
    timeouts = undefined
  })

  it('never arms a timer longer than 2^31 - 1 ms for a retry that is not due', async () => {
    const driver = kafka({ bootstrapBrokers: ['kafka:9092'], maxRetryDelayMs: 40 * 24 * 3_600_000 })
    await driver.connect({ logger: memoryLogger() })
    const handled: string[] = []
    const subscription = await driver.subscribe(
      'orders',
      async (delivery: DriverDelivery) => {
        handled.push(String(delivery.body))
        await delivery.ack()
      },
      { ...options, maxAttempts: 3 },
    )
    const [, retry] = streams as [FakeStream, FakeStream]
    timeouts = spyOn(globalThis, 'setTimeout')
    const notBefore = String(Date.now() + 30 * 24 * 3_600_000)
    retry.emit('data', record('znight.orders.retry', 0, 0, [['x-znight-not-before', notBefore]]))
    await new Promise(resolve => setTimeout(resolve, 20))
    const delays = timeouts.mock.calls.map(call => Number(call[1] ?? 0))
    expect(delays.some(delay => delay === MAX_TIMER_DELAY_MS)).toBe(true)
    expect(delays.every(delay => delay <= MAX_TIMER_DELAY_MS)).toBe(true)
    expect(handled).toEqual([])
    await subscription.cancel()
    await subscription.close()
    await driver.close()
  })
})
