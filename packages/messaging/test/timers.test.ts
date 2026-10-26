import type { InboundMessage } from '../src/index.ts'

import { createTestApp, handler, type TestApp } from './helpers.ts'
import { afterEach, describe, expect, it, jest } from 'bun:test'

let current: TestApp | undefined

afterEach(async () => {
  jest.useRealTimers()
  await current?.app.stop()
  current = undefined
})

/** Advances the fake clock, letting promise chains settle between timers. */
async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    jest.advanceTimersByTime(100)
    for (let tick = 0; tick < 50; tick++) await Promise.resolve()
  }
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) await Promise.resolve()
}

describe('backoff timings (fake timers)', () => {
  it('waits 1 s, 2 s, then 4 s between native retries', async () => {
    const times: number[] = []
    class FlakyConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        times.push(Date.now())
        if (message.attempt < 4) throw new Error('transient')
      }
    }
    current = await createTestApp(
      [
        {
          class: FlakyConsumer,
          queue: 'q',
          handlers: [handler('handle', { retry: { attempts: 4, backoff: 'exponential', delay: 1000 } })],
        },
      ],
      { driverOptions: { maxInProcessDelayMs: 0 } },
    )
    jest.useFakeTimers()
    const start = Date.now()
    await current.broker.publish('q', 1)
    await flush()
    expect(times).toHaveLength(1)
    await advance(900) // t = 900
    expect(times).toHaveLength(1)
    await advance(200) // t = 1100
    expect(times).toHaveLength(2)
    await advance(1700) // t = 2800
    expect(times).toHaveLength(2)
    await advance(300) // t = 3100
    expect(times).toHaveLength(3)
    await advance(3800) // t = 6900
    expect(times).toHaveLength(3)
    await advance(200) // t = 7100
    expect(times).toHaveLength(4)
    expect(times.map(time => time - start)).toEqual([0, 1000, 3000, 7000])
    expect(current.driver.settlements('q').map(s => [s.action, s.delayMs])).toEqual([
      ['retry', 1000],
      ['retry', 2000],
      ['retry', 4000],
      ['ack', undefined],
    ])
  })
})
