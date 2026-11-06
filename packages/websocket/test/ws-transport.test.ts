/** The `ws` transport behind `HttpPlugin` upgrade routes, with a real client (on Node.js `node:http`). */
import type { Plugin, ZnightMetadata } from '@znight/core'
import type { HttpContext, PendingUpgrade, PluginHttpUpgrades } from '@znight/http'
import type { TransportSocket, WebSocketTransport } from '../src/index.ts'

import { Duplex } from 'node:stream'
import { Application, silentLogger } from '@znight/core'
import { HttpException, HttpPlugin } from '@znight/http'
import { nodeAdapter } from '@znight/http/node'

import { wsTransport } from '../src/transports/ws.ts'
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

/** A plugin echoing every frame through the transport. */
function echoPlugin(transport: WebSocketTransport, closes: string[]): Plugin & PluginHttpUpgrades {
  transport.configure({ maxPayload: 1024, backpressureLimit: 1024 * 1024, heartbeatMs: 0 })
  return {
    name: 'echo',
    httpUpgrades: () => ({
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
              {
                protocol: offered.includes('echo.v1') ? 'echo.v1' : '',
                headers: { 'x-gateway': 'echo' },
                maxPayload: 1024,
              },
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

describe('ws transport', () => {
  it('echoes text and binary frames, selects the subprotocol and reports the close', async () => {
    const closes: string[] = []
    const transport = wsTransport()
    const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter: nodeAdapter() })
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

  it('refuses upgrades that are not node upgrades', async () => {
    const transport = wsTransport()
    const events = { message: () => undefined, pong: () => undefined, drain: () => undefined, close: () => undefined }
    await expect(
      transport.accept({ kind: 'memory', peer: {} }, { protocol: '', headers: {}, maxPayload: 1 }, events),
    ).rejects.toThrow('ZNIGHT051')
  })

  describe('settles accept() when ws aborts the handshake', () => {
    const events = { message: () => undefined, pong: () => undefined, drain: () => undefined, close: () => undefined }

    function handshake(headers: Record<string, string> = {}) {
      const socket = Object.assign(
        new Duplex({
          read: () => undefined,
          write: (_chunk, _encoding, done) => done(),
        }),
        { setTimeout: () => undefined, setNoDelay: () => undefined },
      )
      const request = {
        method: 'GET',
        url: '/chat',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...headers,
        },
        socket,
      }
      return { socket, native: { kind: 'node' as const, request, socket, head: new Uint8Array(0) } }
    }

    /** `'pending'` when `task` is still unsettled after 500 ms. */
    function settled(accepted: unknown): Promise<unknown> {
      const task = Promise.resolve(accepted)
      return Promise.race([
        task.then(
          () => 'accepted',
          (error: unknown) => error,
        ),
        Bun.sleep(500).then(() => 'pending'),
      ])
    }

    it('completes a handshake whose Sec-WebSocket-Protocol header ws cannot parse', async () => {
      const transport = wsTransport()
      const { socket, native } = handshake({ 'sec-websocket-protocol': 'a b' })
      try {
        expect(await settled(transport.accept(native, { protocol: '', headers: {}, maxPayload: 64 }, events))).toBe(
          'accepted',
        )
      } finally {
        socket.destroy()
        await transport.close()
      }
    })

    it('rejects when the client left before the transport completes the handshake', async () => {
      const transport = wsTransport()
      const { socket, native } = handshake()
      socket.end()
      try {
        const result = await settled(transport.accept(native, { protocol: '', headers: {}, maxPayload: 64 }, events))
        expect(result).toBeInstanceOf(HttpException)
        expect((result as HttpException).status).toBe(400)
      } finally {
        socket.destroy()
        await transport.close()
      }
    })

    it('rejects when ws refuses a malformed Sec-WebSocket-Extensions header', async () => {
      const transport = wsTransport({ perMessageDeflate: true })
      const { socket, native } = handshake({ 'sec-websocket-extensions': 'permessage-deflate; =' })
      try {
        const result = await settled(transport.accept(native, { protocol: '', headers: {}, maxPayload: 64 }, events))
        expect(result).toBeInstanceOf(HttpException)
      } finally {
        socket.destroy()
        await transport.close()
      }
    })
  })
})
