/** The Hono adapter on `Bun.serve()`: body size and idle timeout defaults of Bun do not apply to Znight. */
import type { HttpContext } from '../src/index.ts'

import net from 'node:net'

import { honoAdapter } from '../src/adapters/hono.ts'
import { HttpResponse } from '../src/index.ts'
import { controller, createApp, metadata, provider, route, sleep, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class BigController {
  async count(ctx: HttpContext) {
    let size = 0
    for await (const chunk of ctx.bodyStream()) size += chunk.byteLength
    return { size }
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
}

const meta = metadata({ [t('BigController')]: provider(BigController) }, [
  controller(t('BigController'), '/', [
    route('count', '/count', (c: BigController, ctx) => c.count(ctx), {
      method: 'PUT',
      bodyLimit: Number.POSITIVE_INFINITY,
    }),
    route('slow', '/slow', (c: BigController) => c.slow()),
  ]),
])

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

  it('passes serveOptions and lifts the idle timeout while a stream is sent', async () => {
    const app = await createApp(meta, { adapter: honoAdapter({ serveOptions: { idleTimeout: 1 } }) })
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
    expect(performance.now() - started).toBeGreaterThan(2_900)
    // then the idle timeout applies again to the keep-alive connection
    expect(outcome.closedAfterMs).toBeGreaterThan(0)
    expect(outcome.closedAfterMs).toBeLessThan(5_000)
    await app.stop()
  }, 20_000)
})
