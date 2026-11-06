/**
 * The `ws` transport (RFC 0003 §8.3): completes the upgrades of every `node:http` adapter, on
 * Node.js and on Bun. `ws` is an optional peer dependency, loaded lazily on the first connection.
 *
 * ```ts
 * import { wsTransport } from '@znight/websocket/ws'
 * ```
 */
import type { BunUpgrade, HeaderValue, MemoryUpgrade, NodeUpgrade } from '@znight/http'
import type {
  AcceptInit,
  SendStatus,
  SocketEvents,
  TransportSettings,
  TransportSocket,
  WebSocketTransport,
} from '../transport.ts'

import { ErrorCode, ZnightError } from '@znight/core'

/** The part of a `ws` `WebSocket` the transport uses (no `@types/ws`). */
interface WsSocket {
  readonly bufferedAmount: number
  readonly extensions: string
  send(data: string | Uint8Array, options: { binary: boolean }, callback: (error?: Error) => void): void
  ping(): void
  pause(): void
  resume(): void
  close(code: number, reason: string): void
  terminate(): void
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => void): void
  on(event: 'pong', listener: () => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** The part of a `ws` `WebSocketServer` the transport uses. */
interface WsServer {
  handleUpgrade(request: unknown, socket: unknown, head: Uint8Array, callback: (ws: WsSocket) => void): void
  on(event: 'headers', listener: (headers: string[], request: unknown) => void): void
  close(): void
}

interface WsModule {
  readonly WebSocketServer: new (options: Record<string, unknown>) => WsServer
}

/** Options of {@link wsTransport}. */
export interface WsTransportOptions {
  /** `permessage-deflate` (`ws` option). Default: `false`. */
  readonly perMessageDeflate?: boolean | Record<string, unknown>
}

let loading: Promise<WsModule> | undefined

function loadWs(): Promise<WsModule> {
  const name = 'ws'
  loading ??= (import(name) as Promise<WsModule & { default?: WsModule }>).then(
    module => (module.WebSocketServer === undefined && module.default !== undefined ? module.default : module),
    (cause: unknown) => {
      loading = undefined
      throw new ZnightError(
        ErrorCode.WebSocketTransportUnavailable,
        'The "ws" package is required to serve WebSocket gateways on Node.js',
        { hints: ['Install it: npm install ws'], cause },
      )
    },
  )
  return loading
}

function toFrame(data: Buffer | ArrayBuffer | Buffer[], binary: boolean): string | Uint8Array {
  let bytes: Uint8Array
  if (Array.isArray(data)) bytes = Buffer.concat(data)
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
  else bytes = data
  return binary ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.from(bytes).toString('utf8')
}

/** One `ws` connection. */
class WsTransportSocket implements TransportSocket {
  readonly #ws: WsSocket
  readonly #limit: number
  readonly #events: SocketEvents
  #waitingDrain = false

  constructor(ws: WsSocket, limit: number, events: SocketEvents) {
    this.#ws = ws
    this.#limit = limit
    this.#events = events
  }

  get bufferedAmount(): number {
    return this.#ws.bufferedAmount
  }

  get extensions(): string {
    return this.#ws.extensions
  }

  send(frame: string | Uint8Array, binary: boolean): SendStatus {
    this.#ws.send(frame, { binary }, () => this.#flushed())
    if (this.#ws.bufferedAmount <= this.#limit) return 'sent'
    this.#waitingDrain = true
    return 'queued'
  }

  ping(): void {
    this.#ws.ping()
  }

  pause(): boolean {
    this.#ws.pause()
    return true
  }

  resume(): void {
    this.#ws.resume()
  }

  close(code: number, reason: string): void {
    this.#ws.close(code, reason)
  }

  terminate(): void {
    this.#ws.terminate()
  }

  #flushed(): void {
    if (this.#waitingDrain && this.#ws.bufferedAmount <= this.#limit) {
      this.#waitingDrain = false
      this.#events.drain()
    }
  }
}

/** The `ws` transport: completes the `node` upgrades of `node:http` servers. */
export function wsTransport(options: WsTransportOptions = {}): WebSocketTransport {
  let settings: TransportSettings = { maxPayload: 1024 * 1024, backpressureLimit: 1024 * 1024, heartbeatMs: 0 }
  let server: WsServer | undefined
  const pendingHeaders = new WeakMap<object, Readonly<Record<string, HeaderValue>>>()
  const sockets = new Set<WsSocket>()

  async function serverOf(): Promise<WsServer> {
    if (server !== undefined) return server
    const { WebSocketServer } = await loadWs()
    server ??= new WebSocketServer({
      noServer: true,
      maxPayload: settings.maxPayload,
      perMessageDeflate: options.perMessageDeflate ?? false,
      clientTracking: false,
      handleProtocols: (protocols: Set<string>, request: object) => {
        const selected = (request as { znightProtocol?: string }).znightProtocol ?? ''
        return selected !== '' && protocols.has(selected) ? selected : false
      },
    })
    server.on('headers', (lines, request) => {
      const extra = pendingHeaders.get(request as object)
      if (extra === undefined) return
      for (const [name, value] of Object.entries(extra)) {
        for (const item of typeof value === 'string' ? [value] : value) lines.push(`${name}: ${item}`)
      }
    })
    return server
  }

  return {
    name: 'ws',
    accepts: 'node',
    configure(next: TransportSettings): void {
      settings = next
    },
    async ready(): Promise<void> {
      await serverOf()
    },
    async accept(
      native: NodeUpgrade | BunUpgrade | MemoryUpgrade,
      init: AcceptInit,
      events: SocketEvents,
    ): Promise<TransportSocket> {
      if (native.kind !== 'node') {
        throw new ZnightError(
          ErrorCode.WebSocketTransportUnavailable,
          `wsTransport() completes node:http upgrades, not ${native.kind} upgrades`,
          { hints: ['Use bunTransport() with honoAdapter() on Bun'] },
        )
      }
      const wss = await serverOf()
      const request = native.request as { znightProtocol?: string }
      request.znightProtocol = init.protocol
      pendingHeaders.set(request, init.headers)
      const ws = await new Promise<WsSocket>(resolve => wss.handleUpgrade(request, native.socket, native.head, resolve))
      pendingHeaders.delete(request)
      sockets.add(ws)
      const socket = new WsTransportSocket(ws, settings.backpressureLimit, events)
      ws.on('error', () => undefined) // reported through 'close'; an unhandled 'error' would kill the process
      ws.on('message', (data, binary) => events.message(toFrame(data, binary), binary))
      ws.on('pong', () => events.pong())
      ws.on('close', (code, reason) => {
        sockets.delete(ws)
        events.close(code, reason.toString('utf8'))
      })
      return socket
    },
    close(): Promise<void> {
      for (const ws of sockets) ws.terminate()
      sockets.clear()
      server?.close()
      server = undefined
      return Promise.resolve()
    },
  }
}
