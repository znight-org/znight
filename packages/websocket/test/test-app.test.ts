/** `TestApp.connect()` and `connectWebSocket()` of `@znight/testing` against `WebSocketPlugin`. */
import type { ZnightMetadata } from '@znight/core'
import type { WsMessageContext } from '../src/index.ts'

import { Application, silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { nodeAdapter } from '@znight/http/node'
import { connectWebSocket, TestApp, WsHandshakeError, WsRequestError } from '@znight/testing'

import { WebSocketPlugin } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

const ECHO = 'src/echo.gateway.ts#EchoGateway'

class EchoGateway {}

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
          meta: {},
          handshakeGuards: [],
          messageGuards: [],
          handlers: [
            {
              method: 'echo',
              event: 'echo',
              meta: {},
              guards: [],
              params: [],
              invoke: (_g: EchoGateway, m: WsMessageContext) => {
                if (m.data === 'fail') throw new Error('boom')
                m.connection.emit('echoed', m.data)
                return m.data
              },
            },
          ],
        },
      ],
    },
  },
}

describe('@znight/testing WebSocket clients', () => {
  it('TestApp.connect() delegates to WebSocketPlugin and errors match structurally', async () => {
    await using app = await TestApp.create({
      metadata,
      logger: silentLogger,
      plugins: [HttpPlugin.configure({ port: 0 }), WebSocketPlugin.configure()],
    })
    await using client = await app.connect('/echo')
    expect(await client.request('echo', 'hi')).toBe('hi')
    expect(await client.next('echoed')).toBe('hi')
    const failed = await client.request('echo', 'fail').catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(WsRequestError)
    expect(failed).toMatchObject({ code: 'INTERNAL', message: 'Internal error' })
    const refused = app.connect('/echo', { origin: 'https://evil.example' })
    await expect(refused).rejects.toBeInstanceOf(WsHandshakeError)
    await expect(refused).rejects.toMatchObject({ status: 403 })
  })

  it('connectWebSocket() speaks the same protocol over the network', async () => {
    const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter: nodeAdapter() })
    const application = await Application.create({
      metadata,
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [http, WebSocketPlugin.configure()],
    })
    await application.start()
    try {
      const client = await connectWebSocket(`ws://127.0.0.1:${http.address?.port}/echo`, {
        headers: { 'x-test': '1' },
      })
      expect(await client.request('echo', { n: 1 })).toEqual({ n: 1 })
      expect(await client.next('echoed')).toEqual({ n: 1 })
      expect(client.frames).toEqual([
        { event: 'echoed', data: { n: 1 } },
        { id: 1, data: { n: 1 } },
      ])
      expect(await client.close(4000, 'bye')).toEqual({ code: 4000, reason: 'bye' })
      await expect(connectWebSocket(`ws://127.0.0.1:${http.address?.port}/nope`)).rejects.toBeInstanceOf(
        WsHandshakeError,
      )
    } finally {
      await application.stop()
    }
  })
})
