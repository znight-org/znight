/**
 * Handshake check executed by `test/handshake-abort-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: on every HTTP adapter, with the transport `auto`
 * selects, a client leaving while a handshake guard waits aborts `ctx.signal` (`kind: 'client'`),
 * no connection opens and the request scope of the handshake closes; a connection accepted then
 * closed by its client aborts nothing. Prints the results as JSON.
 */
import type { ZnightMetadata } from '@znight/core'
import type { CanActivate, HttpAdapter, HttpContext, RequestAbortedError } from '@znight/http'

import net from 'node:net'
import { Application, silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { expressAdapter } from '@znight/http/express'
import { fastifyAdapter } from '@znight/http/fastify'
import { honoAdapter } from '@znight/http/hono'
import { nodeAdapter } from '@znight/http/node'

import { WebSocketPlugin } from '../../src/index.ts'

const LIVE = 'src/live.gateway.ts#LiveGateway'
const GUARD = 'src/live.guard.ts#LiveGuard'
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

interface Run {
  entered: PromiseWithResolvers<void>
  reason: string | undefined
  disposed: number
}

let run: Run = fresh()

function fresh(): Run {
  return { entered: Promise.withResolvers(), reason: undefined, disposed: 0 }
}

class LiveGateway {}

/** A request-scoped handshake guard: waits on `ctx.signal` for `?slow`, then lets the handshake through. */
class LiveGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean | Promise<boolean> {
    const signal = ctx.signal
    signal.addEventListener('abort', () => {
      run.reason = (signal.reason as RequestAbortedError).kind
    })
    run.entered.resolve()
    if (ctx.query['slow'] === undefined) return true
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(true), 3000)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  release(): void {
    run.disposed++
  }
}

const metadata: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    [LIVE]: { scope: 'singleton', class: LiveGateway as never, deps: [], factory: () => new LiveGateway() },
    [GUARD]: {
      scope: 'request',
      class: LiveGuard as never,
      deps: [],
      factory: () => new LiveGuard(),
      dispose: 'release',
    },
  },
  resolutionOrder: [LIVE],
  externals: [
    { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
    { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
  ],
  extensions: {
    http: { controllers: [] },
    websocket: {
      gateways: [
        {
          token: LIVE,
          path: '/live',
          protocol: 'raw',
          meta: {},
          handshakeGuards: [GUARD],
          messageGuards: [],
          handlers: [],
        },
      ],
    },
  },
}

const ADAPTERS: readonly (readonly [string, () => HttpAdapter])[] = [
  ['node', () => nodeAdapter()],
  ['fastify', () => fastifyAdapter()],
  ['express', () => expressAdapter()],
  ['hono', () => honoAdapter()],
]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function until(condition: () => boolean, timeout = 3000): Promise<boolean> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) return false
    await sleep(10)
  }
  return true
}

const results: Record<string, unknown> = {}

for (const [name, adapter] of ADAPTERS) {
  const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter: adapter() })
  const websocket = WebSocketPlugin.configure()
  const app = await Application.create({
    metadata,
    logger: silentLogger,
    shutdown: { signals: false },
    plugins: [http, websocket],
  })
  await app.start()
  const port = http.address?.port as number

  // the client leaves while the handshake guard waits
  run = fresh()
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  socket.write(
    'GET /live?slow=1 HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
  await run.entered.promise
  const waiting = http.inflight
  socket.destroy()
  const settled = await until(() => http.inflight === 0)
  await sleep(50)
  const left = {
    waiting,
    reason: run.reason ?? null,
    settled,
    disposed: run.disposed,
    opened: websocket.stats().opened,
    connections: websocket.connections,
  }

  // accepted, then closed by the client
  run = fresh()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`)
  const opened = await new Promise<boolean>(resolve => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
  })
  const open = { inflight: http.inflight, connections: websocket.connections }
  const closed = new Promise<number>(resolve => {
    ws.onclose = event => resolve(event.code)
  })
  ws.close(1000)
  const code = await closed
  const released = await until(() => http.inflight === 0 && websocket.connections === 0)
  await sleep(50)
  const accepted = {
    opened,
    open,
    code,
    released,
    reason: run.reason ?? null,
    disposed: run.disposed,
    stats: { opened: websocket.stats().opened, closed: websocket.stats().closed },
  }

  results[name] = { left, accepted }
  await app.stop()
}

process.stdout.write(JSON.stringify(results))
process.exit(0)
