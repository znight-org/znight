/**
 * WebSocketPlugin over real sockets with the `auto` transport: `ws` behind `nodeAdapter()` (Bun's
 * built-in `ws` when the tests run on Bun) and Bun's native WebSocket behind `honoAdapter()` on
 * `Bun.serve()`. Same behaviour on both: replies, subprotocol, heartbeat, close 1001 on stop.
 */
import type { ZnightMetadata } from '@znight/core'
import type { HttpAdapter } from '@znight/http'
import type { WsConnection, WsMessageContext } from '../src/index.ts'

import { Application, silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { nodeAdapter } from '@znight/http/node'

import { WebSocketPlugin } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

const ECHO = 'src/echo.gateway.ts#EchoGateway'

class EchoGateway {
  readonly closed: number[] = []
}

const metadata: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    [ECHO]: { scope: 'singleton', class: EchoGateway as never, deps: [], factory: () => new EchoGateway() },
  },
  resolutionOrder: [ECHO],
  externals: [
    { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
    { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
  ],
  extensions: {
    http: { controllers: [] },
    websocket: {
      gateways: [
        {
          token: ECHO,
          path: '/echo',
          protocol: 'events',
          protocols: ['echo.v1'],
          meta: {},
          handshakeGuards: [],
          messageGuards: [],
          onDisconnect: {
            method: 'gone',
            invoke: (g: EchoGateway, c: WsConnection) => g.closed.push(c.closeInfo?.code ?? 0),
          },
          handlers: [
            {
              method: 'echo',
              event: 'echo',
              meta: {},
              guards: [],
              params: [],
              invoke: (_g: EchoGateway, m: WsMessageContext) => m.data,
            },
          ],
        },
      ],
    },
  },
}

const adapters: [string, () => HttpAdapter, string][] = [
  ['node', () => nodeAdapter(), 'ws'],
  ['hono on Bun.serve()', () => honoAdapter(), 'bun'],
]

function open(url: string, protocols: string[]): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols)
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('handshake failed'))
  })
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise(resolve => {
    ws.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })
  })
}

describe.each(adapters)('WebSocketPlugin on %s', (_name, adapter, transport) => {
  it('serves a gateway, keeps it alive with heartbeats and closes it with 1001 on stop', async () => {
    const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter: adapter() })
    const websocket = WebSocketPlugin.configure({ heartbeat: { intervalMs: 40 } })
    const app = await Application.create({
      metadata,
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [http, websocket],
    })
    await app.start()
    let stopped = false
    try {
      expect(websocket.transport).toBe(transport)
      const ws = await open(`ws://127.0.0.1:${http.address?.port}/echo`, ['echo.v1'])
      expect(ws.protocol).toBe('echo.v1')
      const reply = nextMessage(ws)
      ws.send(JSON.stringify({ event: 'echo', data: { n: 1 }, id: 1 }))
      expect(await reply).toEqual({ id: 1, data: { n: 1 } })
      await Bun.sleep(150) // several heartbeat ticks: the client answers pings by itself
      expect(ws.readyState).toBe(WebSocket.OPEN)
      const gateway = app.container.get(ECHO) as EchoGateway
      const closed = new Promise<number>(resolve => {
        ws.onclose = event => resolve(event.code)
      })
      await app.stop()
      stopped = true
      expect(await closed).toBe(1001)
      expect(gateway.closed).toEqual([1001])
      expect(websocket.stats()).toMatchObject({ connections: 0, opened: 1, closed: 1, messagesIn: 1 })
    } finally {
      if (!stopped) await app.stop()
    }
  })

  it('refuses a handshake with an HTTP status', async () => {
    const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter: adapter() })
    const app = await Application.create({
      metadata,
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [http, WebSocketPlugin.configure()],
    })
    await app.start()
    try {
      const response = await fetch(`http://127.0.0.1:${http.address?.port}/echo`)
      expect(response.status).toBe(426)
      await expect(open(`ws://127.0.0.1:${http.address?.port}/echo`, ['v2'])).rejects.toThrow('handshake failed')
    } finally {
      await app.stop()
    }
  })
})
