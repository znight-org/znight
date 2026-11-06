/**
 * The in-memory transport (RFC 0003 §8.3): an in-process pair used by `WebSocketPlugin.connect()`
 * and the tests. Frames are delivered synchronously, nothing is buffered, reading pauses with a
 * queue, and there is no heartbeat.
 */
import type { BunUpgrade, MemoryUpgrade, NodeUpgrade } from '@znight/http'
import type { AcceptInit, SendStatus, SocketEvents, TransportSocket, WebSocketTransport } from '../transport.ts'

/** How a memory connection closed. */
export interface MemoryCloseInfo {
  readonly code: number
  readonly reason: string
}

/**
 * The client side of an in-memory connection: pass it as the `peer` of a memory upgrade
 * (`{ kind: 'memory', peer: client }`), then read `received` and send frames.
 */
export class MemoryClient {
  /** Frames received from the server, in order. */
  readonly received: (string | Uint8Array)[] = []
  /** Called for each frame received from the server. */
  onmessage: ((frame: string | Uint8Array) => void) | undefined
  /** Called once when the connection closes. */
  onclose: ((info: MemoryCloseInfo) => void) | undefined
  #protocol = ''
  #closed: MemoryCloseInfo | undefined
  #server: MemorySocket | undefined

  /** The subprotocol the server selected, `''` when none. */
  get protocol(): string {
    return this.#protocol
  }

  /** How the connection closed, `undefined` while open. */
  get closed(): MemoryCloseInfo | undefined {
    return this.#closed
  }

  /** Whether the server accepted the connection. */
  get open(): boolean {
    return this.#server !== undefined && this.#closed === undefined
  }

  /** Sends a frame to the server (a string is a text frame). */
  send(frame: string | Uint8Array): void {
    if (this.#server === undefined || this.#closed !== undefined) throw new Error('The connection is not open')
    this.#server.receive(frame)
  }

  /** Closes the connection from the client side. */
  close(code = 1000, reason = ''): void {
    if (this.#server === undefined || this.#closed !== undefined) return
    this.#server.closeFromPeer(code, reason)
  }

  /** @internal Bound by the memory transport. */
  attach(server: MemorySocket, protocol: string): void {
    if (this.#server !== undefined) throw new Error('This MemoryClient is already connected')
    this.#server = server
    this.#protocol = protocol
  }

  /** @internal */
  deliver(frame: string | Uint8Array): void {
    this.received.push(frame)
    this.onmessage?.(frame)
  }

  /** @internal */
  closedWith(info: MemoryCloseInfo): void {
    if (this.#closed !== undefined) return
    this.#closed = info
    this.onclose?.(info)
  }
}

/** The server side of an in-memory connection. */
class MemorySocket implements TransportSocket {
  readonly bufferedAmount = 0
  readonly extensions = ''
  readonly #client: MemoryClient
  readonly #events: SocketEvents
  readonly #queue: (string | Uint8Array)[] = []
  #paused = false
  #closed = false

  constructor(client: MemoryClient, events: SocketEvents) {
    this.#client = client
    this.#events = events
  }

  send(frame: string | Uint8Array, _binary: boolean): SendStatus {
    if (this.#closed) return 'dropped'
    this.#client.deliver(frame)
    return 'sent'
  }

  ping(): void {
    if (!this.#closed) this.#events.pong()
  }

  pause(): boolean {
    this.#paused = true
    return true
  }

  resume(): void {
    this.#paused = false
    while (!this.#paused && !this.#closed && this.#queue.length > 0) this.#dispatch(this.#queue.shift() as string)
  }

  close(code: number, reason: string): void {
    this.#finish(code, reason)
  }

  terminate(): void {
    this.#finish(1006, '')
  }

  receive(frame: string | Uint8Array): void {
    if (this.#closed) return
    if (this.#paused) this.#queue.push(frame)
    else this.#dispatch(frame)
  }

  closeFromPeer(code: number, reason: string): void {
    this.#finish(code, reason)
  }

  #dispatch(frame: string | Uint8Array): void {
    this.#events.message(frame, typeof frame !== 'string')
  }

  #finish(code: number, reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#queue.length = 0
    this.#client.closedWith({ code, reason })
    this.#events.close(code, reason)
  }
}

/** The in-memory transport: completes `{ kind: 'memory', peer }` upgrades whose peer is a {@link MemoryClient}. */
export function memoryTransport(): WebSocketTransport {
  const sockets = new Set<MemorySocket>()
  return {
    name: 'memory',
    accepts: 'memory',
    configure: () => undefined,
    accept(native: NodeUpgrade | BunUpgrade | MemoryUpgrade, init: AcceptInit, events: SocketEvents): TransportSocket {
      if (native.kind !== 'memory' || !(native.peer instanceof MemoryClient)) {
        throw new Error('The memory transport only completes memory upgrades whose peer is a MemoryClient')
      }
      const tracked: SocketEvents = {
        message: (frame, binary) => events.message(frame, binary),
        pong: () => events.pong(),
        drain: () => events.drain(),
        close: (code, reason) => {
          sockets.delete(socket)
          events.close(code, reason)
        },
      }
      const socket = new MemorySocket(native.peer, tracked)
      sockets.add(socket)
      native.peer.attach(socket, init.protocol)
      return socket
    },
    close(): Promise<void> {
      for (const socket of [...sockets]) socket.terminate()
      return Promise.resolve()
    },
  }
}
