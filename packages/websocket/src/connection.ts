/**
 * A WebSocket connection (RFC 0003 §5.4, §8.4, §8.5): the inbound queue with its concurrency and
 * read pausing, the outbound backpressure policy, rooms, and the close sequence. What a message
 * means (decoding, handlers, guards, replies) is given by the plugin through {@link ConnectionDriver}.
 */
import type { HttpContext } from '@znight/http'
import type { TokenBucket } from './rate-limit.ts'
import type { Broadcast, ChannelMember, RoomRegistry } from './rooms.ts'
import type { SendStatus, SocketEvents, TransportSocket } from './transport.ts'

import { encodeEvent } from './envelope.ts'
import { WsCloseCode } from './exceptions.ts'

/** Who closed a connection. */
export type WsCloseInitiator = 'client' | 'server' | 'shutdown' | 'heartbeat' | 'backpressure' | 'error'

/** How a connection closed. */
export interface WsCloseInfo {
  readonly code: number
  readonly reason: string
  readonly initiator: WsCloseInitiator
}

/** The result of a send: written, buffered by the transport, or dropped. */
export type WsSendResult = SendStatus

/** `conn.drained()` rejects with it once the connection is closed. */
export class WsClosedError extends Error {
  constructor(message = 'The WebSocket connection is closed') {
    super(message)
    this.name = 'WsClosedError'
  }
}

/** A WebSocket connection, as handlers and services see it. */
export interface WsConnection<
  TData extends object = Record<string, unknown>,
  E extends object = Record<string, unknown>,
> {
  readonly id: string
  /** Path pattern of the gateway, prefix included (`/api/chat`). */
  readonly gateway: string
  /** The request id of the handshake. */
  readonly requestId: string
  /** The handshake, detached from its socket. */
  readonly handshake: HttpContext
  readonly params: Readonly<Record<string, string>>
  /** The negotiated subprotocol, `''` when none. */
  readonly protocol: string
  /** Per-connection state, an empty object at first. */
  readonly data: TData
  readonly rooms: ReadonlySet<string>
  readonly readyState: 'open' | 'closing' | 'closed'
  readonly bufferedAmount: number
  /** Aborted when the connection starts closing. */
  readonly signal: AbortSignal
  readonly closeInfo: WsCloseInfo | undefined
  emit<K extends keyof E & string>(event: K, data: E[K]): WsSendResult
  send(frame: string | Uint8Array): WsSendResult
  join(room: string | readonly string[]): void
  leave(room: string): void
  /** The other members of `room`. */
  to(room: string | readonly string[]): Broadcast<E>
  /** Resolves once the outbound buffer is below `limit / 4`; rejects with {@link WsClosedError} once closed. */
  drained(): Promise<void>
  close(code?: number, reason?: string): void
  terminate(): void
}

/** Limits of one connection, resolved from the gateway and the plugin options. */
export interface ConnectionLimits {
  readonly maxPayload: number
  readonly maxPendingMessages: number
  readonly concurrency: number
  readonly backpressureLimit: number
  readonly onBackpressure: 'close' | 'drop'
  readonly closeTimeoutMs: number
  readonly rateLimit?: { readonly bucket: TokenBucket; readonly onLimit: 'reject' | 'close' }
}

/** What the plugin does with a connection (the gateway semantics). */
export interface ConnectionDriver {
  /** Runs `@OnConnect`; a rejection closes the connection with the code it returns. */
  connect(conn: WsConnectionImpl): Promise<void>
  /** Handles one inbound message (decode, guards, handler, reply). Never rejects. */
  dispatch(conn: WsConnectionImpl, frame: string | Uint8Array, binary: boolean): Promise<void>
  /** A message refused by the rate limit with `onLimit: 'reject'`. */
  rateLimited(conn: WsConnectionImpl, frame: string | Uint8Array, binary: boolean): void
  /** The close code of an `@OnConnect` failure. */
  connectFailure(error: unknown): { readonly code: number; readonly reason: string }
  /** Runs `@OnDisconnect` (errors handled by the driver). */
  disconnect(conn: WsConnectionImpl): Promise<void>
  /** Once fully closed (rooms left): hooks, stats, scope release. */
  closed(conn: WsConnectionImpl, info: WsCloseInfo): void
}

/** What a connection is created with. */
export interface ConnectionInit {
  readonly id: string
  readonly gateway: string
  readonly handshake: HttpContext
  readonly protocol: string
  readonly limits: ConnectionLimits
  readonly rooms: RoomRegistry<WsConnectionImpl>
  readonly driver: ConnectionDriver
}

function sizeOf(frame: string | Uint8Array): number {
  return typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength
}

/** The implementation of {@link WsConnection} (internal to the package). */
export class WsConnectionImpl implements WsConnection, ChannelMember {
  readonly id: string
  readonly gateway: string
  readonly handshake: HttpContext
  readonly protocol: string
  readonly data: Record<string, unknown> = {}
  readonly roomSet: Set<string> = new Set()
  readonly #limits: ConnectionLimits
  readonly #registry: RoomRegistry<WsConnectionImpl>
  readonly #driver: ConnectionDriver
  readonly #abort = new AbortController()
  readonly #queue: { readonly frame: string | Uint8Array; readonly binary: boolean }[] = []
  readonly #running = new Set<Promise<void>>()
  readonly #drainWaiters: { resolve(): void; reject(error: Error): void }[] = []
  readonly #finished: PromiseWithResolvers<WsCloseInfo> = Promise.withResolvers()
  #socket: TransportSocket | undefined
  #state: 'open' | 'closing' | 'closed' = 'open'
  #connecting = true
  #connected = false
  #paused = false
  #closing: WsCloseInfo | undefined
  #closeInfo: WsCloseInfo | undefined
  #closeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(init: ConnectionInit) {
    this.id = init.id
    this.gateway = init.gateway
    this.handshake = init.handshake
    this.protocol = init.protocol
    this.#limits = init.limits
    this.#registry = init.rooms
    this.#driver = init.driver
  }

  get requestId(): string {
    return this.handshake.requestId
  }

  get params(): Readonly<Record<string, string>> {
    return this.handshake.params
  }

  get rooms(): ReadonlySet<string> {
    return this.roomSet
  }

  get readyState(): 'open' | 'closing' | 'closed' {
    return this.#state
  }

  get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0
  }

  get signal(): AbortSignal {
    return this.#abort.signal
  }

  get closeInfo(): WsCloseInfo | undefined {
    return this.#closeInfo
  }

  /** Resolves once the connection is fully closed. */
  get finished(): Promise<WsCloseInfo> {
    return this.#finished.promise
  }

  /** The socket events to give to the transport. */
  socketEvents(): SocketEvents {
    return {
      message: (frame, binary) => this.#receive(frame, binary),
      pong: () => undefined,
      drain: () => this.#drain(),
      close: (code, reason) => this.#socketClosed(code, reason),
    }
  }

  /** Binds the accepted socket, joins the gateway and runs `@OnConnect` as the first task. */
  start(socket: TransportSocket): void {
    this.#socket = socket
    this.#registry.add(this)
    const task = this.#driver.connect(this).then(
      () => {
        this.#connected = true
        this.#connecting = false
        this.#pump()
      },
      (error: unknown) => {
        this.#connecting = false
        const { code, reason } = this.#driver.connectFailure(error)
        this.#beginClose(code, reason, 'server', true)
      },
    )
    this.#track(task)
  }

  emit(event: string, data: unknown): WsSendResult {
    return this.sendFrame(encodeEvent(event, data))
  }

  send(frame: string | Uint8Array): WsSendResult {
    return this.sendFrame(frame)
  }

  /** Sends an encoded frame through the backpressure policy. */
  sendFrame(frame: string | Uint8Array): WsSendResult {
    const socket = this.#socket
    if (this.#state !== 'open' || socket === undefined) return 'dropped'
    if (socket.bufferedAmount + sizeOf(frame) > this.#limits.backpressureLimit) {
      if (this.#limits.onBackpressure === 'drop') return 'dropped'
      this.#beginClose(WsCloseCode.TryAgainLater, 'Slow consumer', 'backpressure', true)
      return 'dropped'
    }
    return socket.send(frame, typeof frame !== 'string')
  }

  join(room: string | readonly string[]): void {
    for (const name of typeof room === 'string' ? [room] : room) this.#registry.join(this, name)
  }

  leave(room: string): void {
    this.#registry.leave(this, room)
  }

  to(room: string | readonly string[]): Broadcast {
    return this.#registry.select(room, [this.id])
  }

  drained(): Promise<void> {
    if (this.#state !== 'open') return Promise.reject(new WsClosedError())
    if (this.bufferedAmount <= this.#limits.backpressureLimit / 4) return Promise.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.#drainWaiters.push({ resolve, reject })
    return promise
  }

  close(code: number = WsCloseCode.Normal, reason = ''): void {
    this.#beginClose(code, reason, 'server', true)
  }

  /** Closes with an initiator (shutdown, heartbeat...). */
  closeWith(code: number, reason: string, initiator: WsCloseInitiator): void {
    this.#beginClose(code, reason, initiator, true)
  }

  terminate(): void {
    this.#beginClose(1006, '', 'server', false)
    this.#socket?.terminate()
  }

  #receive(frame: string | Uint8Array, binary: boolean): void {
    if (this.#state !== 'open') return
    if (sizeOf(frame) > this.#limits.maxPayload) {
      this.#beginClose(WsCloseCode.MessageTooBig, 'Message too big', 'server', true)
      return
    }
    const rate = this.#limits.rateLimit
    if (rate !== undefined && !rate.bucket.take()) {
      if (rate.onLimit === 'close') this.#beginClose(4429, 'Rate limited', 'server', true)
      else this.#driver.rateLimited(this, frame, binary)
      return
    }
    this.#queue.push({ frame, binary })
    const max = this.#limits.maxPendingMessages
    if (this.#queue.length >= max && !this.#paused) {
      this.#paused = this.#socket?.pause() ?? false
      if (!this.#paused && this.#queue.length >= max * 2) {
        this.#beginClose(WsCloseCode.PolicyViolation, 'Too many pending messages', 'server', true)
        return
      }
    }
    this.#pump()
  }

  #pump(): void {
    while (
      this.#state === 'open' &&
      !this.#connecting &&
      this.#running.size < this.#limits.concurrency &&
      this.#queue.length > 0
    ) {
      const next = this.#queue.shift() as { readonly frame: string | Uint8Array; readonly binary: boolean }
      this.#track(this.#driver.dispatch(this, next.frame, next.binary))
    }
    if (this.#paused && this.#queue.length <= this.#limits.maxPendingMessages / 2) {
      this.#paused = false
      this.#socket?.resume()
    }
  }

  /** Counts a running task until it settles, then dispatches the next messages. */
  #track(task: Promise<void>): void {
    const tracked: Promise<void> = task
      .catch(() => undefined)
      .then(() => {
        this.#running.delete(tracked)
        this.#pump()
      })
    this.#running.add(tracked)
  }

  #drain(): void {
    if (this.bufferedAmount > this.#limits.backpressureLimit / 4) return
    for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve()
  }

  #beginClose(code: number, reason: string, initiator: WsCloseInitiator, frame: boolean): void {
    if (this.#state !== 'open') return
    this.#state = 'closing'
    this.#closing = { code, reason, initiator }
    this.#abort.abort(new WsClosedError())
    this.#queue.length = 0
    if (!frame) return
    this.#socket?.close(code, reason)
    this.#closeTimer = setTimeout(() => this.#socket?.terminate(), this.#limits.closeTimeoutMs)
    this.#closeTimer.unref?.()
  }

  #socketClosed(code: number, reason: string): void {
    if (this.#state === 'closed') return
    if (this.#state === 'open') this.#beginClose(code, reason, 'client', false)
    if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer)
    void this.#finish()
  }

  async #finish(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running])
    if (this.#connected) await this.#driver.disconnect(this).catch(() => undefined)
    this.#registry.remove(this)
    const info = this.#closing ?? { code: 1006, reason: '', initiator: 'error' as const }
    this.#closeInfo = info
    this.#state = 'closed'
    for (const waiter of this.#drainWaiters.splice(0)) waiter.reject(new WsClosedError())
    this.#driver.closed(this, info)
    this.#finished.resolve(info)
  }
}
