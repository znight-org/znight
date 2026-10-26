import type { MessagePublishEvent } from '../src/index.ts'

import { DriverMessageBroker } from '../src/broker.ts'
import { MemoryDriver } from '../src/drivers/memory.ts'
import { jsonCodec, MessageBroker } from '../src/index.ts'
import { caught, createTestApp, handler, sleep } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('MessageBroker.publish', () => {
  it('encodes the payload and publishes with type, headers, key and id', async () => {
    const { app, broker, driver } = await createTestApp([])
    expect(broker).toBeInstanceOf(MessageBroker)
    const result = await broker.publish(
      'orders',
      { id: 1 },
      { type: 'order.created', headers: { 'x-a': '1' }, key: 'k1' },
    )
    const [message] = driver.published('orders')
    expect(message).toMatchObject({
      id: result.id,
      queue: 'orders',
      type: 'order.created',
      key: 'k1',
      headers: { 'x-a': '1' },
      body: '{"id":1}',
      contentType: 'application/json',
      payload: { id: 1 },
    })
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
    await app.stop()
  })

  it('keeps a caller-provided id and content type', async () => {
    const { app, broker, driver } = await createTestApp([])
    const bytes = new Uint8Array([1, 2, 3])
    await broker.publish('blobs', bytes, { id: 'fixed-id' })
    await broker.publish('texts', 'hello', { contentType: 'text/plain' })
    expect(driver.published('blobs')[0]).toMatchObject({
      id: 'fixed-id',
      contentType: 'application/octet-stream',
      body: bytes,
    })
    expect(driver.published('texts')[0]).toMatchObject({ body: 'hello', contentType: 'text/plain', payload: 'hello' })
    await app.stop()
  })

  it('delays deliveries', async () => {
    const received: number[] = []
    class Consumer {
      handle(payload: number) {
        received.push(payload)
      }
    }
    const { app, broker, driver } = await createTestApp([
      { class: Consumer, queue: 'q', handlers: [handler('handle')] },
    ])
    await broker.publish('q', 1, { delay: 30 })
    await broker.publish('q', 2)
    await sleep(10)
    expect(received).toEqual([2])
    await driver.idle()
    expect(received).toEqual([2, 1])
    await app.stop()
  })

  it.each([
    ['', {}, 'the queue must be a non-empty string'],
    ['q', { delay: -1 }, '"delay" must be a number of milliseconds >= 0'],
    ['q', { delay: Number.NaN }, '"delay" must be a number of milliseconds >= 0'],
    ['q', { headers: { 'bad name': 'x' } }, 'invalid header name "bad name"'],
    ['q', { headers: { h: 1 as never } }, 'header "h" must be a string'],
  ])('validates its arguments (%#)', async (queue, options, message) => {
    const { app, broker } = await createTestApp([])
    const error = await caught(broker.publish(queue, 1, options))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toContain(message)
    await app.stop()
  })

  it('rejects delays the driver cannot honour', async () => {
    const { app, broker } = await createTestApp([], { driverOptions: { maxPublishDelayMs: 100 } })
    expect(((await caught(broker.publish('q', 1, { delay: 101 }))) as Error).message).toContain(
      'supports delays up to 100 ms',
    )
    await app.stop()
    const other = await createTestApp([], { driverOptions: { maxPublishDelayMs: 0 } })
    expect(((await caught(other.broker.publish('q', 1, { delay: 1 }))) as Error).message).toContain(
      'does not support delayed publishing',
    )
    await other.app.stop()
  })

  it('rejects payloads JSON cannot encode', async () => {
    const { app, broker } = await createTestApp([])
    expect(await caught(broker.publish('q', 10n))).toBeInstanceOf(TypeError)
    expect(((await caught(broker.publish('q', () => 1))) as Error).message).toContain(
      'Cannot encode a function payload',
    )
    await app.stop()
  })

  it('propagates driver failures', async () => {
    const { app, broker, driver } = await createTestApp([])
    driver.fail('publish', { queue: 'q', times: 1, error: new Error('nack from broker') })
    expect(((await caught(broker.publish('q', 1))) as Error).message).toBe('nack from broker')
    await broker.publish('q', 2)
    expect(driver.published('q').map(m => m.payload)).toEqual([2])
    await app.stop()
  })

  it('fails before the plugin is bootstrapped and after it is disposed', async () => {
    const broker = new DriverMessageBroker()
    expect(((await caught(broker.publish('q', 1))) as Error).message).toContain('not bootstrapped yet')
    const { app, broker: live } = await createTestApp([])
    await app.stop()
    expect(((await caught(live.publish('q', 1))) as Error).message).toContain('has been disposed')
  })

  it('runs hooks.run("messaging:publish") and sends headers added by wrappers', async () => {
    const { app, broker, driver } = await createTestApp([])
    const events: MessagePublishEvent[] = []
    app.hooks.wrap('messaging:publish', async (event, next) => {
      event.headers['traceparent'] = '00-abc-def-01'
      await next()
      events.push(event)
    })
    const { id } = await broker.publish('q', 1, { type: 't', headers: { a: 'b' } })
    expect(driver.published('q')[0]?.headers).toEqual({ a: 'b', traceparent: '00-abc-def-01' })
    expect(events[0]).toMatchObject({ queue: 'q', type: 't', messageId: id })
    expect(events[0]?.startTime).toBeGreaterThan(0)
    driver.fail('publish', { times: 1 })
    let seen: unknown
    app.hooks.wrap('messaging:publish', async (event, next) => {
      try {
        await next()
      } finally {
        seen = event.error
      }
    })
    await caught(broker.publish('q', 2))
    expect((seen as Error).message).toBe('[memory] injected publish failure')
    await app.stop()
  })

  it('emits the publication to hooks.on() listeners', async () => {
    const { app, broker, driver } = await createTestApp([])
    const events: MessagePublishEvent[] = []
    app.hooks.on('messaging:publish', event => {
      events.push(event)
    })
    const { id } = await broker.publish('q', 1, { type: 't' })
    driver.fail('publish', { times: 1 })
    await caught(broker.publish('q', 2))
    expect(events.map(event => [event.queue, event.type, event.error === undefined])).toEqual([
      ['q', 't', true],
      ['q', undefined, false],
    ])
    expect(events[0]?.messageId).toBe(id)
    await app.stop()
  })

  it('can be bound manually (custom setups)', async () => {
    const driver = new MemoryDriver()
    await driver.connect({ logger: console })
    const broker = new DriverMessageBroker()
    const { Hooks } = await import('@znight/core')
    broker.bind(driver, jsonCodec, new Hooks())
    await broker.publish('q', { a: 1 })
    expect(driver.published('q')[0]?.payload).toEqual({ a: 1 })
    broker.unbind()
    await driver.close()
  })
})
