/**
 * The Hono adapter on `Bun.serve()`: body size and idle timeout defaults of Bun do not apply to
 * Znight; bodies of a declared length are read at once; streamed replies (idle timeout, native
 * files) with and without Hono middleware.
 */
import type { HttpContext } from '../src/index.ts'

import net from 'node:net'
import { Hono } from 'hono'

import { honoAdapter } from '../src/adapters/hono.ts'
import { BadRequestException, HttpResponse } from '../src/index.ts'
import { controller, createApp, metadata, provider, route, sleep, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

/** Errors met while reading request bodies (see `BigController.echo`). */
const failures: unknown[] = []

class BigController {
  async count(ctx: HttpContext) {
    let size = 0
    for await (const chunk of ctx.bodyStream()) size += chunk.byteLength
    return { size }
  }
  async echo(ctx: HttpContext) {
    try {
      return { text: new TextDecoder().decode(await ctx.rawBody()) }
    } catch (error) {
      failures.push(error)
      throw error
    }
  }
  slow() {
    return HttpResponse.stream(
      (async function* () {
        yield 'a'
        await sleep(3_000)
        yield 'b'
      })(),
    )
  }
  blob() {
    return new Blob(['file content'], { type: 'text/plain' })
  }
}

const meta = metadata({ [t('BigController')]: provider(BigController) }, [
  controller(t('BigController'), '/', [
    route('count', '/count', (c: BigController, ctx) => c.count(ctx), {
      method: 'PUT',
      bodyLimit: Number.POSITIVE_INFINITY,
    }),
    route('echo', '/echo', (c: BigController, ctx) => c.echo(ctx), {
      method: 'POST',
      bodyLimit: 1024,
      params: [{ index: 0, source: 'context' }],
    }),
    route('slow', '/slow', (c: BigController) => c.slow()),
    route('blob', '/blob', (c: BigController) => c.blob()),
  ]),
])

/** A Hono application with a middleware (Znight routes are then served through `#bunFetch`). */
function withMiddleware(): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    await next()
    c.header('x-middleware', '1')
  })
  return app
}

/** Writes raw bytes on a new connection; resolves with what the server sent before closing (or `wait` ms). */
function exchange(port: number, request: string, wait = 2_000): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', data => {
      received += data.toString('latin1')
    })
    const done = (): void => {
      socket.destroy()
      resolve(received)
    }
    socket.on('close', done)
    socket.on('error', done)
    setTimeout(done, wait)
  })
}

describe('honoAdapter() on Bun.serve()', () => {
  it('lets Znight enforce body limits: uploads above the 128 MiB of Bun are accepted', async () => {
    const app = await createApp(meta, { adapter: honoAdapter() })
    const chunk = new Uint8Array(1024 * 1024)
    const chunks = 140
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ === chunks) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const response = await fetch(`${String(app.http.address)}/count`, { method: 'PUT', body })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ size: chunks * chunk.byteLength })
    await app.stop()
  }, 30_000)

  for (const middleware of [false, true]) {
    const variant = middleware ? 'with middleware' : 'without middleware'
    const adapter = (options: Parameters<typeof honoAdapter>[0] = {}) =>
      honoAdapter(middleware ? { ...options, app: withMiddleware() } : options)

    it(`passes serveOptions and lifts the idle timeout while a stream is sent (${variant})`, async () => {
      const app = await createApp(meta, { adapter: adapter({ serveOptions: { idleTimeout: 1 } }) })
      const port = app.http.address?.port as number
      const started = performance.now()
      const outcome = await new Promise<{ received: string; closedAfterMs: number }>(resolve => {
        const socket = net.connect(port, '127.0.0.1')
        let received = ''
        let completedAt = 0
        socket.on('connect', () => socket.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n'))
        socket.on('data', data => {
          received += data.toString('latin1')
          if (received.endsWith('0\r\n\r\n')) completedAt = performance.now()
        })
        const done = (): void => {
          socket.destroy()
          resolve({ received, closedAfterMs: completedAt === 0 ? -1 : performance.now() - completedAt })
        }
        socket.on('close', done)
        setTimeout(done, 10_000)
      })
      // the 3 s pause of the stream is longer than the idle timeout: the response is complete
      expect(outcome.received).toContain('\r\n1\r\na\r\n1\r\nb\r\n0\r\n\r\n')
      expect(outcome.received.toLowerCase().includes('x-middleware: 1')).toBe(middleware)
      expect(performance.now() - started).toBeGreaterThan(2_900)
      // then the idle timeout applies again to the keep-alive connection
      expect(outcome.closedAfterMs).toBeGreaterThan(0)
      expect(outcome.closedAfterMs).toBeLessThan(5_000)
      await app.stop()
    }, 20_000)

    it(`sends a Blob natively, with its length (${variant})`, async () => {
      const app = await createApp(meta, { adapter: adapter() })
      const port = app.http.address?.port as number
      const received = await exchange(port, 'GET /blob HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      const [head, body] = received.split('\r\n\r\n') as [string, string]
      expect(head).toStartWith('HTTP/1.1 200')
      expect(head.toLowerCase()).toContain('content-length: 12')
      expect(head.toLowerCase()).not.toContain('transfer-encoding')
      expect(head.toLowerCase().includes('x-middleware: 1')).toBe(middleware)
      expect(body).toBe('file content')
      // then text replies again
      const text = await fetch(`${String(app.http.address)}/echo`, { method: 'POST', body: 'after' })
      expect(await text.json()).toEqual({ text: 'after' })
      await app.stop()
    })

    it(`reads a body of declared length at once, within the body limit (${variant})`, async () => {
      failures.length = 0
      const app = await createApp(meta, { adapter: adapter() })
      const url = `${String(app.http.address)}/echo`
      const port = app.http.address?.port as number
      const ok = await fetch(url, { method: 'POST', body: 'hello' })
      expect(ok.status).toBe(201)
      expect(await ok.json()).toEqual({ text: 'hello' })
      expect((await fetch(url, { method: 'POST', body: 'x'.repeat(1024) })).status).toBe(201)
      // above the limit: refused on the declared length, before the body is sent
      expect((await fetch(url, { method: 'POST', body: 'x'.repeat(1025) })).status).toBe(413)
      const early = await exchange(port, 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 4096\r\n\r\n')
      expect(early).toStartWith('HTTP/1.1 413')
      // bytes after the declared length are not part of the body
      const pipelined = await exchange(
        port,
        'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nabPOST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nConnection: close\r\n\r\nc',
      )
      expect(pipelined).toContain('{"text":"ab"}')
      expect(pipelined).toContain('{"text":"c"}')
      // the client leaves before the end of the body: 400 (nobody receives it)
      await exchange(port, 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n0123456789', 100)
      for (let attempt = 0; attempt < 50 && failures.length < 3; attempt++) await sleep(20)
      expect(failures).toHaveLength(3)
      expect((failures[0] as Error).message).toBe('Request body exceeds the limit of 1024 bytes')
      expect((failures[1] as Error).message).toBe('Request body exceeds the limit of 1024 bytes')
      expect(failures[2]).toBeInstanceOf(BadRequestException)
      expect((failures[2] as Error).message).toBe('Failed to read the request body')
      await app.stop()
    })

    it(`reads a chunked body as a stream, within the body limit (${variant})`, async () => {
      const app = await createApp(meta, { adapter: adapter() })
      const send = (size: number) =>
        fetch(`${String(app.http.address)}/echo`, {
          method: 'POST',
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('x'.repeat(size)))
              controller.close()
            },
          }),
          duplex: 'half',
        } as RequestInit)
      const ok = await send(1000)
      expect(ok.status).toBe(201)
      expect(await ok.json()).toEqual({ text: 'x'.repeat(1000) })
      expect((await send(2000)).status).toBe(413)
      await app.stop()
    })
  }

  it('reads a body Hono middleware already read like before (no second read)', async () => {
    const native = new Hono()
    native.use('*', async (c, next) => {
      await c.req.raw.text()
      await next()
    })
    const app = await createApp(meta, { adapter: honoAdapter({ app: native }) })
    const response = await fetch(`${String(app.http.address)}/echo`, { method: 'POST', body: 'hello' })
    expect(response.status).toBe(500)
    await app.stop()
  })
})
