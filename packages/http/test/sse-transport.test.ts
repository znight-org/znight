/**
 * Event streams and the transport (RFC 0006 §4.9, §10.3): compression middleware leaves them alone
 * (`no-transform`, Fastify `reply.hijack()`), and quiet streams survive idle timeouts (Bun.serve()
 * `idleTimeout` lifted by `honoAdapter().listen()` or covered by heartbeats in a user-managed
 * server; Node.js socket timeouts lifted by `eventStream`).
 */
import type { HttpAdapter, HttpContext, SseEvent } from '../src/index.ts'

import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import Fastify from 'fastify'
import { Hono } from 'hono'
import { compress } from 'hono/compress'

import { expressAdapter } from '../src/adapters/express.ts'
import { fastifyAdapter } from '../src/adapters/fastify.ts'
import { honoAdapter } from '../src/adapters/hono.ts'
import { nodeAdapter } from '../src/adapters/node.ts'
import { HttpResponse, parseSseStream } from '../src/index.ts'
import { controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class StreamController {
  /** Three events 100 ms apart, then the end. */
  async *ticks(): AsyncGenerator<SseEvent> {
    for (let index = 1; index <= 3; index++) {
      yield { data: `tick ${index}` }
      await delay(100)
    }
  }
  /** One event, a pause of `ms`, one event. */
  async *pause(ctx: HttpContext): AsyncGenerator<SseEvent> {
    yield { data: 'before' }
    await delay(Number(ctx.query['ms'] ?? 1_500))
    yield { data: 'after' }
  }
  text(): string {
    return 'x'.repeat(4_096)
  }
  /** A hand-written event stream (what `return fetch(upstream)` gives): one event, a pause of `ms`, one event. */
  proxied(ctx: HttpContext): Response {
    const ms = Number(ctx.query['ms'] ?? 1_500)
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: before\n\n'))
        await delay(ms)
        controller.enqueue(encoder.encode('data: after\n\n'))
        controller.close()
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
}

const meta = metadata({ [t('StreamController')]: provider(StreamController) }, [
  controller(t('StreamController'), '/', [
    route('ticks', '/ticks', (c: StreamController) => c.ticks(), { sse: { heartbeat: 0 } }),
    route('pause', '/pause', (c: StreamController, ctx) => c.pause(ctx), { sse: { heartbeat: 0 } }),
    route('beat', '/beat', (c: StreamController, ctx) => c.pause(ctx), { sse: { heartbeat: 1_000 } }),
    route('text', '/text', (c: StreamController) => c.text()),
    route('plain', '/plain', () => HttpResponse.stream([new TextEncoder().encode('plain')].values() as never)),
    route('proxied', '/proxied', (c: StreamController, ctx) => c.proxied(ctx)),
  ]),
])

/** The events of a stream with the time each arrived at (ms since the request). */
async function timedEvents(url: string): Promise<{ data: string; at: number }[]> {
  const started = performance.now()
  const response = await fetch(url, { headers: { 'accept-encoding': 'gzip, br' } })
  expect(response.headers.get('content-encoding')).toBeNull()
  const events: { data: string; at: number }[] = []
  for await (const item of parseSseStream(response.body as ReadableStream<Uint8Array>)) {
    if (item.type === 'event') events.push({ data: item.data, at: performance.now() - started })
  }
  return events
}

function expectOneByOne(events: readonly { data: string; at: number }[]): void {
  expect(events.map(event => event.data)).toEqual(['tick 1', 'tick 2', 'tick 3'])
  // each event arrives when it is produced, not buffered until the end
  expect((events[1]?.at ?? 0) - (events[0]?.at ?? 0)).toBeGreaterThan(50)
  expect((events[2]?.at ?? 0) - (events[1]?.at ?? 0)).toBeGreaterThan(50)
}

describe('compression middleware', () => {
  it('hono/compress leaves event streams alone', async () => {
    const hono = new Hono()
    hono.use(compress())
    const app = await createApp(meta, { adapter: honoAdapter({ app: hono }) })
    const compressed = await fetch(`${String(app.http.address)}/text`, { headers: { 'accept-encoding': 'gzip' } })
    expect(compressed.headers.get('content-encoding')).toBe('gzip') // the middleware is active
    expectOneByOne(await timedEvents(`${String(app.http.address)}/ticks`))
    await app.stop()
  })

  it('Fastify onSend hooks never see an event stream (hijack), onRequest headers are kept', async () => {
    const instance = Fastify()
    instance.addHook('onRequest', (_request, reply, done) => {
      reply.header('x-from-hook', 'yes')
      done()
    })
    // what a compression or ETag plugin does: rewrite every payload in onSend
    instance.addHook('onSend', (_request, reply, payload, done) => {
      reply.header('x-on-send', 'rewritten')
      done(null, typeof payload === 'string' ? `rewritten:${payload.length}` : payload)
    })
    const app = await createApp(meta, { adapter: fastifyAdapter({ instance }) })
    const text = await fetch(`${String(app.http.address)}/text`)
    expect(text.headers.get('x-on-send')).toBe('rewritten')
    const response = await fetch(`${String(app.http.address)}/ticks`)
    expect(response.headers.get('x-on-send')).toBeNull()
    expect(response.headers.get('x-from-hook')).toBe('yes')
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(await response.text()).toBe(':\n\ndata: tick 1\n\ndata: tick 2\n\ndata: tick 3\n\n')
    expectOneByOne(await timedEvents(`${String(app.http.address)}/ticks`))
    // a hand-written event stream (a proxied upstream) too: no onSend hook may buffer or rewrite it
    const proxied = await fetch(`${String(app.http.address)}/proxied?ms=10`)
    expect(proxied.headers.get('x-on-send')).toBeNull()
    expect(proxied.headers.get('x-from-hook')).toBe('yes')
    expect(await proxied.text()).toBe('data: before\n\ndata: after\n\n')
    await app.stop()
  })
})

describe('idle timeouts', () => {
  it('honoAdapter on Bun.serve(): the idle timeout is lifted while the stream is sent', async () => {
    const app = await createApp(meta, { adapter: honoAdapter({ serveOptions: { idleTimeout: 1 } }) })
    const events = await timedEvents(`${String(app.http.address)}/pause?ms=1500`)
    expect(events.map(event => event.data)).toEqual(['before', 'after'])
    await app.stop()
  }, 10_000)

  it('a user-managed Bun.serve(): heartbeats keep a quiet stream alive', async () => {
    const adapter = honoAdapter()
    const app = await createApp(meta, { adapter }, { start: false })
    // Bun checks idle timeouts every 4 s: an idleTimeout of 4 s or less closes the connection at the
    // next check whatever is written, 5 s closes it 4 to 8 s after the last write. A 9 s pause would
    // be cut without the heartbeats
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 5, fetch: adapter.fetch })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/beat?ms=9000`)
      const items: unknown[] = []
      for await (const item of parseSseStream(response.body as ReadableStream<Uint8Array>)) {
        items.push(item.type === 'event' ? item.data : item.type)
      }
      expect(items[0]).toBe('comment')
      expect(items[1]).toBe('before')
      expect(items.filter(item => item === 'comment').length).toBeGreaterThanOrEqual(5)
      expect(items.at(-1)).toBe('after')
    } finally {
      await server.stop(true)
      await app.stop()
    }
  }, 15_000)

  const timed: readonly { name: string; create: () => HttpAdapter }[] = [
    {
      name: 'node',
      create: () => {
        const server = createServer()
        server.setTimeout(1_000)
        return nodeAdapter({ server })
      },
    },
    {
      name: 'express',
      create: () => {
        const server = createServer()
        server.setTimeout(1_000)
        return expressAdapter({ app: express(), server })
      },
    },
    { name: 'fastify', create: () => fastifyAdapter({ options: { connectionTimeout: 1_000 } }) },
  ]
  for (const adapter of timed) {
    it(`${adapter.name}: a socket timeout does not cut a quiet event stream`, async () => {
      const app = await createApp(meta, { adapter: adapter.create() })
      const [events, proxied] = await Promise.all([
        timedEvents(`${String(app.http.address)}/pause?ms=1500`),
        // a hand-written event stream is an event stream too (it was cut after 1 s)
        timedEvents(`${String(app.http.address)}/proxied?ms=1500`),
      ])
      expect(events.map(event => event.data)).toEqual(['before', 'after'])
      expect(proxied.map(event => event.data)).toEqual(['before', 'after'])
      await app.stop()
    }, 10_000)
  }

  it.skipIf(process.env['ZNIGHT_E2E'] !== '1')(
    'a 12 s quiet stream without heartbeats survives on every adapter (ZNIGHT_E2E=1)',
    async () => {
      for (const create of [nodeAdapter, fastifyAdapter, expressAdapter, honoAdapter]) {
        const app = await createApp(meta, { adapter: create() })
        const events = await timedEvents(`${String(app.http.address)}/pause?ms=12000`)
        expect(events.map(event => event.data)).toEqual(['before', 'after'])
        await app.stop()
      }
    },
    80_000,
  )
})
