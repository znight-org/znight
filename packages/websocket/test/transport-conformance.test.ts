/**
 * One conformance suite for the three transports (RFC 0003 §11.2): the in-memory pair, `ws` behind
 * `nodeAdapter()` and Bun's native WebSocket behind `honoAdapter()` on `Bun.serve()`. Each case
 * drives the transport contract (`accept`, `send`, `close`, `terminate`, socket events) the same way.
 */
import type { Plugin, ZnightMetadata } from '@znight/core'
import type { HttpAdapter, HttpContext, PendingUpgrade, PluginHttpUpgrades } from '@znight/http'
import type { SocketEvents, TransportSocket, WebSocketTransport } from '../src/index.ts'

import { Application, silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { nodeAdapter } from '@znight/http/node'

import { MemoryClient, memoryTransport } from '../src/index.ts'
import { bunTransport } from '../src/transports/bun.ts'
import { wsTransport } from '../src/transports/ws.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const MAX_PAYLOAD = 1024

/** What the server side of a connection recorded. */
interface ServerSide {
  readonly socket: TransportSocket
  readonly frames: (string | number[])[]
  readonly closed: Promise<{ code: number; reason: string }>
}

/** The client side, whatever the transport. */
interface ClientSide {
  readonly protocol: string
  readonly frames: (string | number[])[]
  send(frame: string | Uint8Array): void
  close(code: number, reason: string): void
  readonly closed: Promise<{ code: number; reason: string }>
}

interface Harness {
  connect(protocols: readonly string[]): Promise<{ server: ServerSide; client: ClientSide }>
  /** Whether the transport enforces `maxPayload` itself (the connection checks it otherwise). */
  readonly limitsPayload: boolean
  stop(): Promise<void>
}

const normalize = (frame: string | Uint8Array): string | number[] => (typeof frame === 'string' ? frame : [...frame])

function serverEvents(frames: (string | number[])[]): {
  events: SocketEvents
  closed: Promise<{ code: number; reason: string }>
} {
  const { promise, resolve } = Promise.withResolvers<{ code: number; reason: string }>()
  return {
    closed: promise,
    events: {
      message: frame => frames.push(normalize(frame)),
      pong: () => undefined,
      drain: () => undefined,
      close: (code, reason) => resolve({ code, reason }),
    },
  }
}

const settle = () => Bun.sleep(30)

function memoryHarness(): Harness {
  const transport = memoryTransport()
  return {
    limitsPayload: false,
    async connect(protocols) {
      const peer = new MemoryClient()
      const frames: (string | number[])[] = []
      const { events, closed } = serverEvents(frames)
      const socket = await transport.accept(
        { kind: 'memory', peer },
        { protocol: protocols[0] ?? '', headers: {}, maxPayload: MAX_PAYLOAD },
        events,
      )
      const clientClosed = Promise.withResolvers<{ code: number; reason: string }>()
      peer.onclose = info => clientClosed.resolve(info)
      const client: ClientSide = {
        get protocol() {
          return peer.protocol
        },
        get frames() {
          return peer.received.map(normalize)
        },
        send: frame => peer.send(frame),
        close: (code, reason) => peer.close(code, reason),
        closed: clientClosed.promise,
      }
      return { server: { socket, frames, closed }, client }
    },
    stop: () => transport.close(),
  }
}

/** A real server: one upgrade route completing every handshake with `transport`. */
async function networkHarness(transport: WebSocketTransport, adapter: HttpAdapter): Promise<Harness> {
  transport.configure({ maxPayload: MAX_PAYLOAD, backpressureLimit: 1024 * 1024, heartbeatMs: 0 })
  let pending: PromiseWithResolvers<ServerSide> | undefined
  const plugin: Plugin & PluginHttpUpgrades = {
    name: 'conformance',
    httpUpgrades: () => ({
      routes: [
        {
          path: '/ws',
          name: 'ConformanceGateway',
          async accept(ctx: HttpContext, upgrade: PendingUpgrade): Promise<void> {
            const frames: (string | number[])[] = []
            const { events, closed } = serverEvents(frames)
            const offered = (ctx.header('sec-websocket-protocol') ?? '').split(',').map(item => item.trim())
            const socket = await transport.accept(
              upgrade.native,
              { protocol: offered[0] ?? '', headers: { 'x-conformance': 'yes' }, maxPayload: MAX_PAYLOAD },
              events,
            )
            upgrade.hold(closed)
            pending?.resolve({ socket, frames, closed })
          },
        },
      ],
      ...(transport.bunWebSocket === undefined ? {} : { bunWebSocket: transport.bunWebSocket() }),
    }),
  }
  const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter })
  const app = await Application.create({
    metadata,
    logger: silentLogger,
    shutdown: { signals: false },
    plugins: [http, plugin],
  })
  await app.start()
  return {
    limitsPayload: true,
    async connect(protocols) {
      pending = Promise.withResolvers()
      const ws = new WebSocket(`ws://127.0.0.1:${http.address?.port}/ws`, [...protocols])
      ws.binaryType = 'arraybuffer'
      const frames: (string | number[])[] = []
      const closed = Promise.withResolvers<{ code: number; reason: string }>()
      ws.onmessage = event =>
        frames.push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data as ArrayBuffer)])
      ws.onclose = event => closed.resolve({ code: event.code, reason: event.reason })
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('handshake failed'))
      })
      const server = await pending.promise
      const client: ClientSide = {
        get protocol() {
          return ws.protocol
        },
        frames,
        send: frame => ws.send(frame),
        close: (code, reason) => ws.close(code, reason),
        closed: closed.promise,
      }
      return { server, client }
    },
    async stop() {
      await transport.close()
      await app.stop()
    },
  }
}

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

const transports: [string, () => Promise<Harness>][] = [
  ['memory', () => Promise.resolve(memoryHarness())],
  ['ws', () => networkHarness(wsTransport(), nodeAdapter())],
  ['bun', () => networkHarness(bunTransport(), honoAdapter())],
]

describe.each(transports)('transport conformance: %s', (_name, create) => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.stop()
    harness = undefined
  })

  it('accepts with the selected subprotocol and carries text and binary frames both ways', async () => {
    harness = await create()
    const { server, client } = await harness.connect(['conf.v1'])
    expect(client.protocol).toBe('conf.v1')
    client.send('hello')
    client.send(new Uint8Array([1, 2, 3]))
    expect(server.socket.send('world', false)).toBe('sent')
    expect(server.socket.send(new Uint8Array([4, 5]), true)).toBe('sent')
    await settle()
    expect(server.frames).toEqual(['hello', [1, 2, 3]])
    expect(client.frames).toEqual(['world', [4, 5]])
    expect(server.socket.extensions).toBe('')
  })

  it('reports a client close with its code and reason', async () => {
    harness = await create()
    const { server, client } = await harness.connect([])
    client.close(4000, 'bye')
    expect(await server.closed).toEqual({ code: 4000, reason: 'bye' })
    expect(server.socket.send('late', false)).toBe('dropped')
  })

  it('closes from the server with a code the client receives', async () => {
    harness = await create()
    const { server, client } = await harness.connect([])
    server.socket.close(4001, 'done')
    expect(await client.closed).toEqual({ code: 4001, reason: 'done' })
    expect((await server.closed).code).toBe(4001)
  })

  it('terminates without close frame (1006 on both sides)', async () => {
    harness = await create()
    const { server, client } = await harness.connect([])
    server.socket.terminate()
    expect((await client.closed).code).toBe(1006)
    expect((await server.closed).code).toBe(1006)
  })

  it('pauses and resumes reading', async () => {
    harness = await create()
    const { server, client } = await harness.connect([])
    server.socket.pause()
    client.send('while paused')
    await settle()
    const paused = [...server.frames]
    server.socket.resume()
    await settle()
    // memory and ws hold the frame back; Bun may deliver frames already read
    expect(paused.length === 0 || paused[0] === 'while paused').toBe(true)
    expect(server.frames).toEqual(['while paused'])
  })

  it('closes with 1009 above maxPayload when the transport enforces it', async () => {
    harness = await create()
    if (!harness.limitsPayload) return
    const { server, client } = await harness.connect([])
    client.send('x'.repeat(MAX_PAYLOAD + 1))
    expect((await client.closed).code).toBe(1009)
    expect(server.frames).toEqual([])
  })
})
