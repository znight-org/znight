/**
 * The Bun transport (RFC 0003 §8.3): completes the upgrades of `Bun.serve()` (`honoAdapter()` on
 * Bun) with Bun's built-in WebSocket server. No import: it only uses the server it is given.
 *
 * ```ts
 * import { bunTransport } from '@znight/websocket/bun'
 * ```
 */
import type { BunSocketHandlers, BunUpgrade, MemoryUpgrade, NodeUpgrade } from '@znight/http'
import type {
  AcceptInit,
  SendStatus,
  SocketEvents,
  TransportSettings,
  TransportSocket,
  WebSocketTransport,
} from '../transport.ts'

import { ErrorCode, ZnightError } from '@znight/core'

/** The part of Bun's `ServerWebSocket` the transport uses. */
interface BunSocket {
  send(data: string | Uint8Array): number
  getBufferedAmount(): number
  readonly extensions?: string
  ping(): void
  pause?(): void
  resume?(): void
  close(code: number, reason: string): void
  terminate(): void
}

/** The part of Bun's `Server` the transport uses. */
interface BunServer {
  upgrade(request: Request, options: { data: BunSocketHandlers; headers?: Record<string, string> }): boolean
}

/** One Bun connection; bound before `server.upgrade()`, since `open` may run inside it. */
class BunTransportSocket implements TransportSocket {
  readonly #events: SocketEvents
  readonly #registry: Set<BunTransportSocket>
  #ws: BunSocket | undefined
  #closed = false

  constructor(events: SocketEvents, registry: Set<BunTransportSocket>) {
    this.#events = events
    this.#registry = registry
  }

  get bufferedAmount(): number {
    return this.#ws?.getBufferedAmount() ?? 0
  }

  get extensions(): string {
    return this.#ws?.extensions ?? ''
  }

  send(frame: string | Uint8Array, _binary: boolean): SendStatus {
    if (this.#ws === undefined || this.#closed) return 'dropped'
    const result = this.#ws.send(frame)
    if (result > 0) return 'sent'
    return result === -1 ? 'queued' : 'dropped'
  }

  ping(): void {
    this.#ws?.ping()
  }

  pause(): boolean {
    if (this.#ws?.pause === undefined) return false
    this.#ws.pause()
    return true
  }

  resume(): void {
    this.#ws?.resume?.()
  }

  close(code: number, reason: string): void {
    this.#ws?.close(code, reason)
  }

  terminate(): void {
    this.#ws?.terminate()
  }

  onOpen(ws: unknown): void {
    this.#ws = ws as BunSocket
    this.#registry.add(this)
  }

  onMessage(message: string | Uint8Array): void {
    this.#events.message(message, typeof message !== 'string')
  }

  onClose(code: number, reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#registry.delete(this)
    this.#events.close(code, reason)
  }

  onDrain(): void {
    this.#events.drain()
  }

  onPong(): void {
    this.#events.pong()
  }
}

/** The Bun transport: completes the `bun` upgrades of `Bun.serve()`. */
export function bunTransport(): WebSocketTransport {
  let settings: TransportSettings = { maxPayload: 1024 * 1024, backpressureLimit: 1024 * 1024, heartbeatMs: 0 }
  const sockets = new Set<BunTransportSocket>()
  return {
    name: 'bun',
    accepts: 'bun',
    configure(next: TransportSettings): void {
      settings = next
    },
    bunWebSocket(): Readonly<Record<string, unknown>> {
      return {
        maxPayloadLength: settings.maxPayload,
        backpressureLimit: settings.backpressureLimit,
        closeOnBackpressureLimit: false,
        sendPings: settings.heartbeatMs > 0,
        idleTimeout: settings.heartbeatMs > 0 ? Math.max(1, Math.ceil((settings.heartbeatMs * 2) / 1000)) : 0,
      }
    },
    accept(native: NodeUpgrade | BunUpgrade | MemoryUpgrade, init: AcceptInit, events: SocketEvents): TransportSocket {
      if (native.kind !== 'bun') {
        throw new ZnightError(
          ErrorCode.WebSocketTransportUnavailable,
          `bunTransport() completes Bun.serve() upgrades, not ${native.kind} upgrades`,
          { hints: ['Use wsTransport() with the node:http adapters'] },
        )
      }
      const socket = new BunTransportSocket(events, sockets)
      const handlers: BunSocketHandlers = {
        open: ws => socket.onOpen(ws),
        message: (_ws, message) => socket.onMessage(message),
        close: (_ws, code, reason) => socket.onClose(code, reason),
        drain: () => socket.onDrain(),
        pong: () => socket.onPong(),
      }
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(init.headers)) {
        headers[name] = typeof value === 'string' ? value : value.join(', ')
      }
      if (init.protocol !== '') headers['sec-websocket-protocol'] = init.protocol
      const server = native.server as BunServer
      if (!server.upgrade(native.request, { data: handlers, headers })) {
        throw new Error('Bun.serve() refused the WebSocket upgrade')
      }
      return socket
    },
    close(): Promise<void> {
      for (const socket of [...sockets]) socket.terminate()
      return Promise.resolve()
    },
  }
}
