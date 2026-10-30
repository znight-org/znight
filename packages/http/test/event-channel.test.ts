/** `EventChannel` (RFC 0006 §4.10): bounded push-to-pull bridge. */
import { EventChannel } from '../src/index.ts'
import { caught } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

async function drain<T>(channel: EventChannel<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of channel) items.push(item)
  return items
}

describe('EventChannel', () => {
  it('buffers pushed items and ends after close()', async () => {
    const channel = new EventChannel<number>()
    expect(channel.push(1)).toBe(true)
    expect(channel.push(2)).toBe(true)
    expect(channel.size).toBe(2)
    channel.close()
    channel.close() // idempotent
    expect(channel.closed).toBe(true)
    expect(channel.push(3)).toBe(false)
    expect(await drain(channel)).toEqual([1, 2])
  })

  it('hands items to a waiting consumer', async () => {
    const channel = new EventChannel<string>()
    const iterator = channel[Symbol.asyncIterator]()
    const pending = iterator.next()
    channel.push('a')
    expect(await pending).toEqual({ done: false, value: 'a' })
    expect(channel.size).toBe(0)
  })

  it("'drop-oldest' (default) discards the oldest buffered item", async () => {
    const channel = new EventChannel<number>({ capacity: 2 })
    expect([channel.push(1), channel.push(2), channel.push(3)]).toEqual([true, true, true])
    channel.close()
    expect(await drain(channel)).toEqual([2, 3])
  })

  it("'drop-newest' refuses items when full", async () => {
    const channel = new EventChannel<number>({ capacity: 2, overflow: 'drop-newest' })
    expect([channel.push(1), channel.push(2), channel.push(3)]).toEqual([true, true, false])
    expect(channel.closed).toBe(false)
    channel.close()
    expect(await drain(channel)).toEqual([1, 2])
  })

  it("'close' closes the channel after the buffered items", async () => {
    const channel = new EventChannel<number>({ capacity: 2, overflow: 'close' })
    let closes = 0
    channel.onClose(() => closes++)
    expect([channel.push(1), channel.push(2), channel.push(3)]).toEqual([true, true, false])
    expect(channel.closed).toBe(true)
    expect(closes).toBe(1)
    expect(await drain(channel)).toEqual([1, 2])
  })

  it('closes when the signal aborts, flushing the buffer first', async () => {
    const controller = new AbortController()
    const channel = new EventChannel<number>({ signal: controller.signal })
    channel.push(1)
    const iterator = channel[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 1 })
    const pending = iterator.next()
    controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(channel.closed).toBe(true)
    // an aborted signal closes at once
    const aborted = new EventChannel<number>({ signal: AbortSignal.abort() })
    expect(aborted.closed).toBe(true)
    expect(aborted.push(1)).toBe(false)
  })

  it('return() closes the channel and resolves at once, even while next() waits', async () => {
    const channel = new EventChannel<number>()
    const iterator = channel[Symbol.asyncIterator]()
    const pending = iterator.next()
    expect(await iterator.return?.()).toEqual({ done: true, value: undefined })
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(channel.closed).toBe(true)
    expect(channel.push(1)).toBe(false)
  })

  it('leaving a for await loop closes the channel and drops its buffer', async () => {
    const channel = new EventChannel<number>()
    channel.push(1)
    channel.push(2)
    for await (const item of channel) {
      expect(item).toBe(1)
      break
    }
    expect(channel.closed).toBe(true)
    expect(channel.size).toBe(0)
  })

  it('fail() throws after the buffered items, then ends', async () => {
    const channel = new EventChannel<number>()
    channel.push(1)
    channel.fail(new Error('upstream down'))
    channel.fail(new Error('ignored'))
    const iterator = channel[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 1 })
    expect(((await caught(() => iterator.next())) as Error).message).toBe('upstream down')
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    // a waiting consumer receives the failure
    const waiting = new EventChannel<number>()
    const next = waiting[Symbol.asyncIterator]().next()
    waiting.fail(new Error('boom'))
    expect(((await caught(() => next)) as Error).message).toBe('boom')
  })

  it('has a single consumer', () => {
    const channel = new EventChannel<number>()
    channel[Symbol.asyncIterator]()
    expect(() => channel[Symbol.asyncIterator]()).toThrow('single consumer')
  })

  it('calls onClose listeners once, immediately when already closed', () => {
    const channel = new EventChannel<number>()
    const calls: string[] = []
    channel.onClose(() => calls.push('a'))
    channel.onClose(() => {
      throw new Error('listener failure is contained')
    })
    channel.onClose(() => calls.push('b'))
    channel.close()
    channel.close()
    channel.onClose(() => calls.push('late'))
    expect(calls).toEqual(['a', 'b', 'late'])
    expect(() => channel.onClose('x' as never)).toThrow(TypeError)
  })

  it('validates its options', () => {
    expect(() => new EventChannel({ capacity: 0 })).toThrow('capacity')
    expect(() => new EventChannel({ capacity: 1.5 })).toThrow('capacity')
    expect(() => new EventChannel({ overflow: 'block' as never })).toThrow('overflow')
    expect(() => new EventChannel(null as never)).toThrow(TypeError)
    expect(new EventChannel({ capacity: Infinity }).push(1)).toBe(true)
  })
})
