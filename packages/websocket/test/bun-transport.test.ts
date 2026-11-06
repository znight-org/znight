/** The Bun transport behind `HttpPlugin` upgrade routes, on `honoAdapter()` served by `Bun.serve()`. */
import type { Plugin, ZnightMetadata } from '@znight/core'
import type { HttpContext, PendingUpgrade, PluginHttpUpgrades } from '@znight/http'
import type { TransportSocket, WebSocketTransport } from '../src/index.ts'

import { Application, silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'

import { bunTransport } from '../src/transports/bun.ts'
import { describe, expect, it } from 'bun:test'

const metadata: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {},
  resolutionOrder: [],
  externals: [
    { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
    { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
  ],
  extensions: { http: { controllers: [] } },
}

function echoPlugin(transport: WebSocketTransport, closes: string[]): Plugin & PluginHttpUpgrades {
  transport.configure({ maxPayload: 1024, backpressureLimit: 1024 * 1024, heartbeatMs: 0 })
  return {
    name: 'echo',
    httpUpgrades: () => ({
      ...(transport.bunWebSocket === undefined ? {} : { bunWebSocket: transport.bunWebSocket() }),
      routes: [
        {
          path: '/echo',
          name: 'EchoGateway',
          async accept(ctx: HttpContext, upgrade: PendingUpgrade): Promise<void> {
            const { promise, resolve } = Promise.withResolvers<void>()
            let socket: TransportSocket | undefined
            const offered = ctx.headers['sec-websocket-protocol'] ?? ''
            socket = await transport.accept(
              upgrade.native,
              { protocol: offered.includes('echo.v1') ? 'echo.v1' : '', headers: {}, maxPayload: 1024 },
              {
                message: (frame, binary) => socket?.send(frame, binary),
                pong: () => undefined,
                drain: () => undefined,
                close: (code, reason) => {
                  closes.push(`${code}:${reason}`)
                  resolve()
                },
              },
            )
            upgrade.hold(promise)
          },
        },
      ],
    }),
  }
}

describe('bun transport', () => {
  it('echoes frames, selects the subprotocol and reports the close', async () => {
    const closes: string[] = []
    const transport = bunTransport()
    const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter: honoAdapter() })
    const app = await Application.create({
      metadata,
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [http, echoPlugin(transport, closes)],
    })
    await app.start()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${http.address?.port}/echo`, ['echo.v1'])
      ws.binaryType = 'arraybuffer'
      const received: unknown[] = []
      const { promise: done, resolve } = Promise.withResolvers<void>()
      ws.onmessage = event => {
        received.push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data as ArrayBuffer)])
        if (received.length === 2) ws.close(4000, 'bye')
      }
      ws.onclose = () => resolve()
      await new Promise<void>(open => {
        ws.onopen = () => open()
      })
      expect(ws.protocol).toBe('echo.v1')
      ws.send('hello')
      ws.send(new Uint8Array([1, 2, 3]))
      await done
      expect(received).toEqual(['hello', [1, 2, 3]])
      await Bun.sleep(20)
      expect(closes).toEqual(['4000:bye'])
    } finally {
      await transport.close()
      await app.stop()
    }
  })

  it('refuses upgrades that are not Bun upgrades', () => {
    const events = { message: () => undefined, pong: () => undefined, drain: () => undefined, close: () => undefined }
    expect(() =>
      bunTransport().accept({ kind: 'memory', peer: {} }, { protocol: '', headers: {}, maxPayload: 1 }, events),
    ).toThrow('ZNIGHT051')
  })
})
