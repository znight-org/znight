/**
 * Handshake check executed by `test/handshake-abort-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: on every HTTP adapter, with the transport `auto`
 * selects, a client leaving while a handshake guard waits aborts `ctx.signal` (`kind: 'client'`),
 * no connection opens and the request scope of the handshake closes, also when the client sent a
 * frame after its handshake before ending its side; a frame sent before the handshake completed is
 * delivered once it did; a connection accepted then closed by its client aborts nothing. Prints the
 * results as JSON.
 */
import type { ZnightMetadata } from '@znight/core'
import type { CanActivate, HttpAdapter, HttpContext, RequestAbortedError } from '@znight/http'
import type { WsMessageContext } from '../../src/index.ts'

import { Buffer } from 'node:buffer'
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
  /** `@OnConnect` runs. */
  connected: number
  /** The frames the gateway received. */
  messages: string[]
}

let run: Run = fresh()

function fresh(): Run {
  return { entered: Promise.withResolvers(), reason: undefined, disposed: 0, connected: 0, messages: [] }
}

class LiveGateway {}

/**
 * A request-scoped handshake guard: waits on `ctx.signal` for `?slow`, `?wait` milliseconds for
 * `?wait`, then lets the handshake through.
 */
class LiveGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean | Promise<boolean> {
    const signal = ctx.signal
    signal.addEventListener('abort', () => {
      run.reason = (signal.reason as RequestAbortedError).kind
    })
    run.entered.resolve()
    const wait = ctx.query['wait']
    if (typeof wait === 'string') return sleep(Number(wait)).then(() => true)
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
          onConnect: {
            method: 'open',
            invoke: () => {
              run.connected++
            },
          },
          handlers: [
            {
              method: 'receive',
              meta: {},
              guards: [],
              params: [],
              invoke: (_gateway: LiveGateway, message: WsMessageContext) => {
                run.messages.push(String(message.data))
              },
            },
          ],
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

/** A masked text frame `hi` (zero mask). */
const FRAME = Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0x68, 0x69])

/** Opens a raw connection and writes a handshake of `path`. */
function handshake(port: number, path: string): net.Socket {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
  return socket
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
  const socket = handshake(port, '/live?slow=1')
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

  // the client sends a frame after its handshake (in its own segment), then ends its side
  run = fresh()
  const ending = handshake(port, '/live?slow=1')
  await run.entered.promise
  ending.write(FRAME)
  await sleep(50)
  ending.end()
  const ended = await until(() => http.inflight === 0)
  await sleep(50)
  ending.destroy()
  const sent = {
    reason: run.reason ?? null,
    settled: ended,
    connected: run.connected,
    messages: run.messages,
    opened: websocket.stats().opened,
    connections: websocket.connections,
  }

  // a frame sent while the guard waits is delivered once the handshake completed
  run = fresh()
  const early = handshake(port, '/live?wait=150')
  await run.entered.promise
  await sleep(20)
  early.write(FRAME)
  const delivered = await until(() => run.messages.length > 0)
  early.destroy()
  const gone = await until(() => http.inflight === 0 && websocket.connections === 0)
  await sleep(50)
  const buffered = { delivered, gone, reason: run.reason ?? null, connected: run.connected, messages: run.messages }

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
    connected: run.connected,
  }

  results[name] = { left, sent, buffered, accepted }
  await app.stop()
}

process.stdout.write(JSON.stringify(results))
process.exit(0)
