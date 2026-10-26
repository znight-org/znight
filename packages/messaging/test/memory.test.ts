import type { DriverDelivery, OutboundMessage, SubscribeOptions } from '../src/index.ts'

import { MemoryDriver, memory } from '../src/drivers/memory.ts'
import { MessagingHeaders } from '../src/index.ts'
import { caught, deferred, sleep } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

function subscribeOptions(overrides: Partial<SubscribeOptions> = {}): SubscribeOptions {
  return {
    consumer: 'Test',
    concurrency: 1,
    deadLetterQueue: undefined,
    maxAttempts: 1,
    retryDelays: [],
    options: {},
    ...overrides,
  }
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: crypto.randomUUID(),
    type: undefined,
    key: undefined,
    headers: {},
    body: '{}',
    contentType: 'application/json',
    timestamp: Date.now(),
    delayMs: 0,
    ...overrides,
  }
}

async function connected(options?: ConstructorParameters<typeof MemoryDriver>[0]): Promise<MemoryDriver> {
  const driver = memory(options)
  await driver.connect({ logger })
  return driver
}

describe('MemoryDriver', () => {
  it('declares its capabilities', () => {
    expect(new MemoryDriver().capabilities).toEqual({
      nativeDelay: true,
      maxNativeDelayMs: Number.POSITIVE_INFINITY,
      maxInProcessDelayMs: 1000,
      deliveryCount: 'native',
      maxPublishDelayMs: Number.POSITIVE_INFINITY,
    })
    expect(new MemoryDriver({ nativeDelay: false, maxInProcessDelayMs: 5 }).capabilities).toMatchObject({
      nativeDelay: false,
      maxNativeDelayMs: 0,
      maxInProcessDelayMs: 5,
    })
    expect(() => new MemoryDriver({ maxInProcessDelayMs: -1 })).toThrow('maxInProcessDelayMs must be')
    expect(new MemoryDriver().deadLetterName('q')).toBe('q.dlq')
    expect(new MemoryDriver({ deadLetterName: q => `${q}-dead` }).deadLetterName('q')).toBe('q-dead')
  })

  it('delivers in FIFO order and counts deliveries', async () => {
    const driver = await connected()
    const seen: [unknown, number][] = []
    await driver.subscribe(
      'q',
      async delivery => {
        seen.push([delivery.body, delivery.attempt])
        if (delivery.body === '"b"' && delivery.attempt === 1) await delivery.release()
        else await delivery.ack()
      },
      subscribeOptions(),
    )
    for (const body of ['"a"', '"b"', '"c"']) await driver.publish('q', outbound({ body }))
    await driver.idle()
    expect(seen).toEqual([
      ['"a"', 1],
      ['"b"', 1],
      ['"b"', 2],
      ['"c"', 1],
    ])
  })

  it('round-robins between competing subscribers', async () => {
    const driver = await connected()
    const owners: string[] = []
    for (const name of ['one', 'two']) {
      await driver.subscribe(
        'q',
        async delivery => {
          owners.push(name)
          await delivery.ack()
        },
        subscribeOptions(),
      )
    }
    for (let index = 0; index < 4; index++) await driver.publish('q', outbound())
    await driver.idle()
    expect(owners.sort()).toEqual(['one', 'one', 'two', 'two'])
  })

  it('keeps messages until a subscriber arrives and stops delivering after cancel', async () => {
    const driver = await connected()
    await driver.publish('q', outbound({ body: '1' }))
    expect(driver.pending('q').map(m => m.payload)).toEqual([1])
    const received: unknown[] = []
    const subscription = await driver.subscribe(
      'q',
      async delivery => {
        received.push(delivery.body)
        await delivery.ack()
      },
      subscribeOptions(),
    )
    await driver.idle()
    await subscription.cancel()
    await driver.publish('q', outbound({ body: '2' }))
    await driver.idle()
    expect(received).toEqual(['1'])
    expect(driver.pending('q').map(m => m.payload)).toEqual([2])
    await subscription.close()
  })

  it('delays publications and retries', async () => {
    const driver = await connected()
    const times: number[] = []
    const start = performance.now()
    await driver.subscribe(
      'q',
      async delivery => {
        times.push(Math.round(performance.now() - start))
        if (delivery.attempt === 1) await delivery.retry({ attempt: 2, delayMs: 20, error: new Error('x') })
        else await delivery.ack()
      },
      subscribeOptions(),
    )
    await driver.publish('q', outbound({ delayMs: 20 }))
    expect(driver.isIdle()).toBe(false)
    await driver.idle()
    expect(times).toHaveLength(2)
    expect(times[0]).toBeGreaterThanOrEqual(15)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(15)
    expect(driver.settlements('q').map(s => [s.action, s.attempt, s.delayMs])).toEqual([
      ['retry', 1, 20],
      ['ack', 2, undefined],
    ])
  })

  it('dead-letters with diagnostic headers, or discards without dead-letter queue', async () => {
    const driver = await connected()
    await driver.subscribe(
      'q',
      async delivery => {
        await delivery.deadLetter({
          queue: delivery.attempt === 1 && delivery.body === '1' ? 'q.dlq' : undefined,
          reason: 'non-retryable',
          error: new Error('bad'),
          attempt: 1,
        })
      },
      subscribeOptions(),
    )
    await driver.publish('q', outbound({ body: '1', headers: { [MessagingHeaders.Attempt]: '1', h: 'v' } }))
    await driver.publish('q', outbound({ body: '2' }))
    await driver.idle()
    const [dead] = driver.pending('q.dlq')
    expect(dead?.headers).toMatchObject({
      h: 'v',
      [MessagingHeaders.DeadLetterReason]: 'non-retryable',
      [MessagingHeaders.Error]: 'bad',
      [MessagingHeaders.OriginalQueue]: 'q',
    })
    expect(dead?.headers[MessagingHeaders.Attempt]).toBeUndefined()
    expect(driver.settlements('q').map(s => s.action)).toEqual(['dead-letter', 'reject'])
    expect(driver.deadLetters('q').map(d => d.queue)).toEqual(['q.dlq', undefined])
  })

  it('refuses double settlements and gives unsettled messages back', async () => {
    const driver = await connected()
    const errors: unknown[] = []
    let calls = 0
    await driver.subscribe(
      'q',
      async delivery => {
        calls++
        if (calls === 1) return // returns without settling
        await delivery.ack()
        errors.push(await caught(delivery.ack()))
        errors.push(await caught(delivery.release()))
      },
      subscribeOptions(),
    )
    await driver.publish('q', outbound())
    await driver.idle()
    expect(calls).toBe(2)
    expect(errors.map(error => (error as Error).message)).toEqual([
      expect.stringContaining('already settled (ack)'),
      expect.stringContaining('already settled (release)'),
    ])
    expect(driver.settlements('q').map(s => s.action)).toEqual(['release', 'ack'])
  })

  it('gives the message back when the handler throws synchronously', async () => {
    const driver = await connected()
    let calls = 0
    await driver.subscribe(
      'q',
      ((delivery: DriverDelivery) => {
        calls++
        if (calls === 1) throw new Error('sync')
        return delivery.ack()
      }) as never,
      subscribeOptions(),
    )
    await driver.publish('q', outbound())
    await driver.idle()
    expect(calls).toBe(2)
  })

  it('injects failures', async () => {
    const driver = await connected()
    const remove = driver.fail('publish', { queue: 'a', times: 2 })
    expect(await caught(driver.publish('a', outbound()))).toBeInstanceOf(Error)
    await driver.publish('b', outbound())
    expect(await caught(driver.publish('a', outbound()))).toBeInstanceOf(Error)
    await driver.publish('a', outbound())
    driver.fail('publish', { queue: 'a', error: new Error('custom') })
    expect(((await caught(driver.publish('a', outbound()))) as Error).message).toBe('custom')
    remove()
    driver.reset()
    await driver.publish('a', outbound())
    expect(driver.published()).toHaveLength(1)
    const failing = memory()
    failing.fail('connect')
    expect(await caught(failing.connect({ logger }))).toBeInstanceOf(Error)
  })

  it('injects external messages with send()', async () => {
    const driver = await connected()
    const received: DriverDelivery[] = []
    await driver.subscribe(
      'q',
      async delivery => {
        received.push(delivery)
        await delivery.ack()
      },
      subscribeOptions({ concurrency: 2 }),
    )
    const id = driver.send('q', { payload: { a: 1 }, type: 't', key: 'k', headers: { h: '1' }, deliveries: 2 })
    driver.send('q', { body: 'raw', contentType: 'text/plain' })
    await driver.idle()
    expect(received[0]).toMatchObject({
      id,
      type: 't',
      key: 'k',
      headers: { h: '1' },
      attempt: 3,
      redelivered: true,
      body: '{"a":1}',
    })
    expect(received[1]).toMatchObject({ body: 'raw', contentType: 'text/plain', attempt: 1, redelivered: false })
  })

  it('times out idle() and waitFor()', async () => {
    const driver = await connected()
    const gate = deferred()
    await driver.subscribe(
      'q',
      async delivery => {
        await gate.promise
        await delivery.ack()
      },
      subscribeOptions(),
    )
    await driver.publish('q', outbound())
    expect(((await caught(driver.idle(20))) as Error).message).toContain('still busy after 20 ms (1 in flight)')
    expect(((await caught(driver.waitFor(() => false, 10))) as Error).message).toContain('condition not met')
    gate.resolve()
    await driver.waitFor(() => driver.settlements().length === 1)
    await driver.idle()
  })

  it('refuses operations once closed and drops pending timers', async () => {
    const driver = await connected()
    await driver.publish('q', outbound({ delayMs: 10_000 }))
    expect(driver.isIdle()).toBe(false)
    await driver.close()
    expect(driver.isIdle()).toBe(true)
    expect(driver.connected).toBe(false)
    expect(((await caught(driver.publish('q', outbound()))) as Error).message).toContain('the driver is closed')
    expect(await caught(driver.subscribe('q', async () => {}, subscribeOptions()))).toBeInstanceOf(Error)
    expect(() => driver.send('q')).toThrow('the driver is closed')
    await sleep(1)
  })
})
