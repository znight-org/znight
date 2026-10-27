/**
 * Server-Sent Events on every adapter (RFC 0006 §10.3), in memory (`injectSse`, `injectStream`) and
 * over real sockets (`fetch` + `parseSseStream`, raw `net`): headers, preamble, framing, heartbeats,
 * reconnection, client disconnect, backpressure, failures, pre-flight answers, POST streaming, HEAD,
 * `maxDuration`, graceful shutdown and the `inject()` guard.
 */
import type { SseItem, SseMessage } from '../src/index.ts'

import net from 'node:net'

import { parseSseStream } from '../src/index.ts'
import {
  cookiesSseMetadata,
  cookiesSseOptions,
  holdGate,
  type OrderHub,
  resetSseState,
  signalProbe,
  sseState,
} from './cookies-sse-app.ts'
import { ADAPTERS, createApp, sleep, type TestApp, t } from './helpers.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

/** Polls `condition` every 10 ms (fails after `timeout` ms). */
async function until(condition: () => boolean, timeout = 3_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error('condition not met in time')
    await sleep(10)
  }
}

const DECODER = new TextDecoder()

/** Reads a whole body as text. */
async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  let result = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>)
    result += DECODER.decode(chunk, { stream: true })
  return result
}

/** Comparable view of parsed items (without `json`). */
function plain(item: SseItem): unknown {
  return item.type === 'event' ? { type: 'event', event: item.event, data: item.data, id: item.id } : item
}

const message = (event: SseMessage): unknown => ({ event: event.event, data: event.data, id: event.id })

/** Response headers the plugin sets on an event stream. */
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
}

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter`, () => {
    let app: TestApp
    let hub: OrderHub

    beforeAll(async () => {
      app = await createApp(cookiesSseMetadata(), { ...cookiesSseOptions(), adapter: adapter.create() })
      hub = app.app.container.get(t('OrderHub')) as OrderHub
    })

    afterAll(async () => {
      await app.stop()
    })

    beforeEach(() => {
      resetSseState()
    })

    const url = (path: string): string => `${String(app.http.address)}${path}`

    it('sends the event stream headers, then the preamble at once (injectSse)', async () => {
      const started = performance.now()
      await using stream = await app.http.injectSse({ url: '/events/quiet' })
      expect(performance.now() - started).toBeLessThan(500)
      expect(stream.status).toBe(200)
      expect(stream.headers).toMatchObject(SSE_HEADERS)
      expect(stream.headers['x-request-id']).toEqual(expect.any(String))
      expect(stream.headers['content-length']).toBeUndefined()
      expect(stream.body).toBe('')
      expect(stream.comments).toEqual([''])
    })

    it('sends the headers and the preamble before the first event (real socket)', async () => {
      const started = performance.now()
      const response = await fetch(url('/events/quiet'))
      const items = parseSseStream(response.body as ReadableStream<Uint8Array>)
      expect((await items.next()).value).toEqual({ type: 'comment', text: '' })
      expect(performance.now() - started).toBeLessThan(500)
      expect(response.status).toBe(200)
      expect(Object.fromEntries(response.headers)).toMatchObject(SSE_HEADERS)
      expect(response.headers.get('content-length')).toBeNull()
      expect(response.headers.get('content-encoding')).toBeNull()
      await items.return?.()
      await until(() => sseState.signals.includes('client'))
    })

    it('frames events byte for byte', async () => {
      const response = await app.http.injectStream({ method: 'GET', url: '/events/framing' })
      expect(await text(response.body)).toBe(
        ':\n\n' +
          'id: 41\nevent: status\ndata: {"orderId":"o-1","status":"paid"}\n\n' +
          'data: line 1\ndata: line 2\n\n' +
          ': note\n\n' +
          'event: done\ndata: \n\n' +
          'data:  leading space\n\n',
      )
      const socket = await fetch(url('/events/framing'))
      expect(await socket.text()).toBe(
        ':\n\nid: 41\nevent: status\ndata: {"orderId":"o-1","status":"paid"}\n\ndata: line 1\ndata: line 2\n\n: note\n\nevent: done\ndata: \n\ndata:  leading space\n\n',
      )
    })

    it('reads events, the retry and the last event id; reconnects with Last-Event-ID', async () => {
      await using stream = await app.http.injectSse({ url: '/events/orders/o-1' })
      expect(stream.retry).toBe(5_000)
      expect((await stream.take(2)).map(message)).toEqual([
        { event: 'status', data: '{"status":"created"}', id: '1' },
        { event: 'status', data: '{"status":"paid"}', id: '2' },
      ])
      expect(stream.lastEventId).toBe('2')
      hub.publish('shipped')
      const event = await stream.next()
      expect(event.json()).toEqual({ status: 'shipped' })
      const lastId = event.id
      await using resumed = await stream.reconnect()
      hub.publish('delivered')
      // only the events after Last-Event-ID
      expect(message(await resumed.next())).toEqual({
        event: 'status',
        data: '{"status":"delivered"}',
        id: String(Number(lastId) + 1),
      })
      await until(() => hub.subscribers === 1)
    })

    it('stops the source on client disconnect: signal, finally, scope, counters', async () => {
      const stream = await app.http.injectSse({ url: '/scoped' })
      expect((await stream.next()).data).toBe('alive')
      expect(app.http.streams).toBe(1)
      expect(app.http.inflight).toBe(1)
      await stream.close()
      await stream.close() // idempotent
      await until(() => sseState.finallyRan === 1 && sseState.disposed === 1 && app.http.inflight === 0)
      expect(sseState.signals).toEqual(['client'])
      expect(app.http.streams).toBe(0)
      await expect(stream.next()).rejects.toThrow('ended')
    })

    it('stops the source when a real client disconnects', async () => {
      const controller = new AbortController()
      const response = await fetch(url('/scoped'), { signal: controller.signal })
      const items = parseSseStream(response.body as ReadableStream<Uint8Array>)
      await items.next() // preamble
      expect(plain((await items.next()).value as SseItem)).toMatchObject({ data: 'alive' })
      controller.abort()
      await until(() => sseState.finallyRan === 1 && sseState.disposed === 1 && app.http.inflight === 0)
      expect(sseState.signals).toEqual(['client'])
      expect(app.http.streams).toBe(0)
    })

    it('disconnects when the injectStream() signal aborts', async () => {
      const controller = new AbortController()
      const response = await app.http.injectStream({ method: 'GET', url: '/scoped', signal: controller.signal })
      const reader = response.body.getReader()
      expect(DECODER.decode((await reader.read()).value)).toBe(':\n\n')
      expect(DECODER.decode((await reader.read()).value)).toBe('data: alive\n\n') // the generator runs
      controller.abort()
      await until(() => sseState.finallyRan === 1 && sseState.disposed === 1 && app.http.inflight === 0)
      expect(sseState.signals).toEqual(['client'])
    })

    it('aborts ctx.signal of a plain route when the client disconnects (real socket)', async () => {
      const controller = new AbortController()
      const pending = fetch(url('/events/wait'), { signal: controller.signal }).catch(() => undefined)
      await until(() => signalProbe.signal !== undefined && app.http.inflight === 1)
      await sleep(50)
      controller.abort()
      await pending
      await until(() => sseState.signals.length === 1)
      expect(sseState.signals).toEqual(['client'])
      await until(() => app.http.inflight === 0)
      signalProbe.signal = undefined
    })

    it('never aborts ctx.signal after a normal completion', async () => {
      const response = await fetch(url('/events/quick'))
      expect(await response.text()).toBe('quick')
      const signal = signalProbe.signal as AbortSignal
      await until(() => app.http.inflight === 0)
      await sleep(100)
      expect(signal.aborted).toBe(false)
      expect((await app.http.inject({ method: 'GET', url: '/events/quick' })).body).toBe('quick')
      await sleep(50)
      expect(signalProbe.signal?.aborted).toBe(false)
      signalProbe.signal = undefined
    })

    it('honours @HttpCode for HttpResponse.sse() on a plain route', async () => {
      await using stream = await app.http.injectSse({ method: 'POST', url: '/events/status' })
      expect(stream.status).toBe(202)
      expect((await stream.next()).data).toBe('accepted')
    })

    it('applies backpressure: a client that does not read stops the source', async () => {
      const port = app.http.address?.port as number
      const socket = net.connect(port, '127.0.0.1')
      await new Promise<void>(resolve => socket.on('connect', resolve))
      socket.write('GET /events/firehose HTTP/1.1\r\nHost: x\r\n\r\n')
      socket.once('data', () => socket.pause()) // a slow client: stop reading
      await until(() => sseState.generated > 0)
      await sleep(300)
      const generated = sseState.generated
      // bounded by socket buffers (16 KiB events), not by the endless source
      expect(generated).toBeLessThan(2_000)
      await sleep(150)
      expect(sseState.generated - generated).toBeLessThanOrEqual(2)
      socket.destroy()
      await until(() => sseState.finallyRan === 1 && app.http.inflight === 0)
    })

    it('closes a slow subscriber of a bounded channel on overflow', async () => {
      const response = await app.http.injectStream({ method: 'GET', url: '/events/overflow' })
      await until(() => hub.subscribers >= 1)
      const before = hub.subscribers
      const big = 'x'.repeat(64 * 1024)
      for (let index = 0; index < 400 && hub.subscribers === before; index++) {
        hub.publish(big)
        await sleep(1)
      }
      // nobody reads the body: the channel fills (capacity 2) and closes
      expect(hub.subscribers).toBe(before - 1)
      await response.body.cancel()
      await until(() => app.http.inflight === 0)
    })

    it('ends cleanly and logs when the source fails mid-stream', async () => {
      const before = app.logger.entries.length
      const response = await app.http.injectStream({ method: 'GET', url: '/events/failing' })
      expect(await text(response.body)).toBe(':\n\ndata: before\n\n')
      const logged = app.logger.entries.slice(before).find(entry => entry.message === 'The SSE stream failed')
      expect(logged?.context?.['err']).toMatchObject({ message: 'upstream down' })
      expect(logged?.context).toMatchObject({ path: '/events/failing', requestId: expect.any(String) })
    })

    it('answers pre-flight errors and statuses as usual', async () => {
      const missing = await app.http.injectSse({ url: '/events/orders/missing' })
      expect(missing.status).toBe(404)
      expect(missing.json()).toMatchObject({ message: 'Order missing not found' })
      expect(missing.headers['content-type']).toBe('application/json; charset=utf-8')
      await expect(missing.next()).rejects.toThrow('ended')
      const closed = await app.http.injectSse({ url: '/events/orders/closed' })
      expect(closed.status).toBe(204)
      expect(closed.body).toBe('')
      const denied = await fetch(url('/events/guarded'))
      expect(denied.status).toBe(401)
      const bad = await app.http.injectSse({ url: '/events/bad' })
      expect(bad.status).toBe(500)
      expect(app.logger.entries.at(-1)?.context?.['err']).toMatchObject({
        message:
          '@Sse handler EventsController.bad must return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (received undefined)',
      })
    })

    it('streams a POST with HttpResponse.sse() (200, its headers and cookies)', async () => {
      await using stream = await app.http.injectSse({ method: 'POST', url: '/events/assistant', body: 'hello world' })
      expect(stream.status).toBe(200)
      expect(stream.headers).toMatchObject({ ...SSE_HEADERS, 'x-model': 'test' })
      expect(Object.keys(stream.cookies)).toEqual(['conversation', 'turn'])
      expect((await stream.take(3)).map(message)).toEqual([
        { event: 'token', data: 'hello', id: '' },
        { event: 'token', data: 'world', id: '' },
        { event: 'complete', data: '', id: '' },
      ])
      await stream.done
      await expect(stream.next({ timeoutMs: 10 })).rejects.toThrow('ended')
    })

    it('answers HEAD with the headers only: the generator body never runs', async () => {
      const res = await app.http.inject({ method: 'HEAD', url: '/events/clock' })
      expect(res.status).toBe(200)
      expect(res.headers).toMatchObject(SSE_HEADERS)
      expect(res.body).toBe('')
      const socket = await fetch(url('/events/clock'), { method: 'HEAD' })
      expect(socket.status).toBe(200)
      expect(sseState.bodyRan).toBe(false)
      await until(() => app.http.inflight === 0)
    })

    it('refuses inject() on an event stream instead of hanging', async () => {
      await expect(app.http.inject({ method: 'GET', url: '/events/clock' })).rejects.toThrow(
        'inject(): GET /events/clock answered an event stream (text/event-stream): use injectSse() or injectStream()',
      )
      // the body is cancelled: the server sees a disconnect
      await until(() => app.http.inflight === 0 && app.http.streams === 0)
    })

    it('ends a stream after maxDuration (expired): final event, then a jittered retry', async () => {
      await using stream = await app.http.injectSse({ url: '/events/expiring' })
      expect(stream.retry).toBe(100)
      expect((await stream.next()).data).toBe('start')
      expect(message(await stream.next({ timeoutMs: 3_000 }))).toEqual({ event: 'bye', data: 'expired', id: '' })
      await stream.done
      expect(stream.retry).toBeGreaterThanOrEqual(100)
      expect(stream.retry).toBeLessThanOrEqual(200)
      expect(sseState.signals).toEqual(['expired'])
    })

    it('sends heartbeats on a quiet stream', async () => {
      await using stream = await app.http.injectSse({ url: '/events/quiet' })
      await expect(stream.next({ timeoutMs: 1_300 })).rejects.toThrow('no event received within 1300 ms')
      expect(stream.comments).toEqual(['', ''])
    })
  })

  describe(`${adapter.name} adapter, graceful shutdown`, () => {
    it('lets the source finish, sends a jittered retry and stops well before the drain timeout', async () => {
      resetSseState()
      const app = await createApp(cookiesSseMetadata(), { ...cookiesSseOptions(), adapter: adapter.create() })
      const response = await fetch(`${String(app.http.address)}/events/expiring`)
      const items = parseSseStream(response.body as ReadableStream<Uint8Array>)
      expect((await items.next()).value).toEqual({ type: 'retry', retry: 100 })
      expect(plain((await items.next()).value as SseItem)).toMatchObject({ data: 'start' })
      const started = performance.now()
      const stopping = app.stop()
      const rest: unknown[] = []
      for await (const item of items) rest.push(plain(item))
      const ended = performance.now() - started
      expect(rest).toEqual([
        { type: 'event', event: 'bye', data: 'shutdown', id: '' },
        { type: 'retry', retry: expect.any(Number) },
      ])
      const retry = (rest[1] as { retry: number }).retry
      expect(retry).toBeGreaterThanOrEqual(100)
      expect(retry).toBeLessThanOrEqual(200)
      expect(ended).toBeLessThan(300 + 200)
      await stopping
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(sseState.signals).toEqual(['shutdown'])
    }, 10_000)

    it.skipIf(adapter.name === 'fastify')(
      'serves an event stream requested while draining with its signal aborted (retry at once)',
      async () => {
        resetSseState()
        const app = await createApp(cookiesSseMetadata(), { ...cookiesSseOptions(), adapter: adapter.create() })
        const held = app.http.inject({ method: 'GET', url: '/events/hold' }) // an in-flight request holds the drain
        await until(() => app.http.inflight === 1)
        const stopping = app.stop()
        await sleep(20)
        const late = await app.http.injectSse({ url: '/events/clock' })
        expect(late.status).toBe(200)
        expect(late.headers['connection']).toBe('close')
        await late.done
        expect(late.retry).toBeGreaterThanOrEqual(3_000)
        expect(late.retry).toBeLessThanOrEqual(6_000)
        expect(sseState.generated).toBe(0) // the generator saw an aborted signal at once
        holdGate.release()
        expect((await held).body).toBe('released')
        await stopping
      },
      10_000,
    )
  })
}

describe('a source ignoring its signal', () => {
  it('is released after the bound, with a warning', async () => {
    resetSseState()
    const app = await createApp(cookiesSseMetadata(), cookiesSseOptions())
    const stream = await app.http.injectSse({ url: '/events/blocked' })
    expect((await stream.next()).data).toBe('first')
    const started = performance.now()
    await stream.close()
    await until(() => app.http.inflight === 0, 8_000)
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_900)
    expect(
      app.logger.entries.some(entry => entry.message.startsWith('The SSE source did not stop within 5000 ms')),
    ).toBe(true)
    expect(sseState.finallyRan).toBe(0) // still blocked: the scope was released anyway
    await app.stop()
  }, 15_000)
})
