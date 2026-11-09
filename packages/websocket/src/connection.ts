/**
 * A WebSocket connection (RFC 0003 §5.4, §8.4, §8.5): the inbound queue with its concurrency and
 * read pausing, the outbound backpressure policy, rooms, and the close sequence. What a message
 * means (decoding, handlers, guards, replies) is given by the plugin through {@link ConnectionDriver}.
 */
import type { HttpContext } from '@znight/http'
import type { TokenBucket } from './rate-limit.ts'
import type { Broadcast, ChannelMember, RoomRegistry } from './rooms.ts'
import type { SendStatus, SocketEvents, TransportSocket } from './transport.ts'

import { closeReason, isCloseCode, WsCloseCode } from './exceptions.ts'

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

/** How often a pending `conn.drained()` re-reads the outbound buffer (ms). */
const DRAIN_POLL_MS = 10
/** Heartbeat ticks a paused connection may spend without any handler progress before it is terminated. */
const MAX_STALLED_TICKS = 2

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
  /** How the connection closed: set once the socket closed, before `@OnDisconnect`. */
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

/** Totals of the plugin (`WebSocketPlugin.stats()`), updated by the connections. */
export interface WsStats {
  /** Open connections. */
  readonly connections: number
  readonly opened: number
  readonly closed: number
  readonly messagesIn: number
  readonly messagesOut: number
  readonly bytesIn: number
  readonly bytesOut: number
  /** Outbound frames dropped by a `drop` backpressure policy or refused by the transport. */
  readonly dropped: number
  /** Connections closed with `1013` (slow consumer). */
  readonly slowConsumerCloses: number
}

/** The mutable counters behind {@link WsStats} (internal). */
export class StatsCounter {
  opened = 0
  closed = 0
  messagesIn = 0
  messagesOut = 0
  bytesIn = 0
  bytesOut = 0
  dropped = 0
  slowConsumerCloses = 0

  /** A frozen snapshot, with the number of open connections. */
  snapshot(connections: number): WsStats {
    return Object.freeze({
      connections,
      opened: this.opened,
      closed: this.closed,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      dropped: this.dropped,
      slowConsumerCloses: this.slowConsumerCloses,
    })
  }
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
  /** Counters shared by the connections of a plugin. */
  readonly stats?: StatsCounter
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
  readonly #stats: StatsCounter | undefined
  readonly #abort = new AbortController()
  readonly #queue: { readonly frame: string | Uint8Array; readonly binary: boolean }[] = []
  readonly #running = new Set<Promise<void>>()
  readonly #drainWaiters: { resolve(): void; reject(error: Error): void }[] = []
  readonly #finished: PromiseWithResolvers<WsCloseInfo> = Promise.withResolvers()
  #socket: TransportSocket | undefined
  /** Polls the buffer while `drained()` waits: a transport may only report a drain at its own limit. */
  #drainPoll: ReturnType<typeof setInterval> | undefined
  #state: 'open' | 'closing' | 'closed' = 'open'
  #connecting = true
  #connected = false
  #paused = false
  #closing: WsCloseInfo | undefined
  #closeInfo: WsCloseInfo | undefined
  #closeTimer: ReturnType<typeof setTimeout> | undefined
  /** Seen alive (a frame or a pong) since the last heartbeat tick. */
  #alive = true
  /** A queued message was dispatched or a handler settled since the last heartbeat tick. */
  #progressed = false
  /** Consecutive heartbeat ticks spent paused without progress. */
  #stalledTicks = 0

  constructor(init: ConnectionInit) {
    this.id = init.id
    this.gateway = init.gateway
    this.handshake = init.handshake
    this.protocol = init.protocol
    this.#limits = init.limits
    this.#registry = init.rooms
    this.#driver = init.driver
    this.#stats = init.stats
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
      pong: () => {
        this.#alive = true
      },
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
    return this.sendFrame(this.#registry.codec.encode({ kind: 'event', event, data }))
  }

  send(frame: string | Uint8Array): WsSendResult {
    return this.sendFrame(frame)
  }

  /** Sends an encoded frame through the backpressure policy. */
  sendFrame(frame: string | Uint8Array): WsSendResult {
    const socket = this.#socket
    if (this.#state !== 'open' || socket === undefined) return 'dropped'
    const size = sizeOf(frame)
    const stats = this.#stats
    if (socket.bufferedAmount + size > this.#limits.backpressureLimit) {
      if (stats !== undefined) stats.dropped++
      if (this.#limits.onBackpressure === 'drop') return 'dropped'
      if (stats !== undefined) stats.slowConsumerCloses++
      this.#beginClose(WsCloseCode.TryAgainLater, 'Slow consumer', 'backpressure', true)
      return 'dropped'
    }
    const status = socket.send(frame, typeof frame !== 'string')
    if (stats !== undefined) {
      if (status === 'dropped') stats.dropped++
      else {
        stats.messagesOut++
        stats.bytesOut += size
      }
    }
    // the transport's threshold is process-wide: 'queued' is decided against this gateway's limit
    if (status === 'sent' && socket.bufferedAmount > this.#limits.backpressureLimit / 2) return 'queued'
    return status
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
    if (this.#drainPoll === undefined) {
      this.#drainPoll = setInterval(() => this.#drain(), DRAIN_POLL_MS)
      this.#drainPoll.unref?.()
    }
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
    this.terminateWith('server')
  }

  /** Terminates without close frame (heartbeat timeout, shutdown deadline...): local code `1006`. */
  terminateWith(initiator: WsCloseInitiator): void {
    this.#beginClose(1006, '', initiator, false)
    this.#socket?.terminate()
  }

  /**
   * One heartbeat tick (RFC 0003 §8.7): a connection not seen alive since the previous tick is
   * terminated, the others are marked and pinged. A connection whose reading the server paused
   * (`maxPendingMessages`) counts as alive while its handlers make progress (its pongs cannot be
   * read until reading resumes); paused without progress for more than {@link MAX_STALLED_TICKS}
   * ticks (handlers stuck, e.g. on `drained()` for a client that stopped reading), it is terminated.
   */
  heartbeat(): void {
    if (this.#state !== 'open' || this.#socket === undefined) return
    const progressed = this.#progressed
    this.#progressed = false
    if (this.#paused) {
      this.#stalledTicks = progressed ? 0 : this.#stalledTicks + 1
      if (this.#stalledTicks > MAX_STALLED_TICKS) {
        this.terminateWith('heartbeat')
        return
      }
      this.#alive = true
      return
    }
    this.#stalledTicks = 0
    if (!this.#alive) {
      this.terminateWith('heartbeat')
      return
    }
    this.#alive = false
    this.#socket.ping()
  }

  #receive(frame: string | Uint8Array, binary: boolean): void {
    if (this.#state !== 'open') return
    this.#alive = true
    const size = sizeOf(frame)
    const stats = this.#stats
    if (stats !== undefined) {
      stats.messagesIn++
      stats.bytesIn += size
    }
    if (size > this.#limits.maxPayload) {
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
      this.#progressed = true
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
        this.#progressed = true
        this.#pump()
      })
    this.#running.add(tracked)
  }

  #drain(): void {
    if (this.bufferedAmount > this.#limits.backpressureLimit / 4) return
    this.#stopDrainPoll()
    for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve()
  }

  #stopDrainPoll(): void {
    if (this.#drainPoll !== undefined) clearInterval(this.#drainPoll)
    this.#drainPoll = undefined
  }

  /**
   * Starts closing. A close frame carries a code a server may send (`1011` otherwise) and a reason
   * of at most 123 bytes (cut otherwise): reasons often come from exception messages, which may
   * hold client input. A transport refusing the frame terminates the socket.
   */
  #beginClose(code: number, reason: string, initiator: WsCloseInitiator, frame: boolean): void {
    if (this.#state !== 'open') return
    const info: WsCloseInfo = frame
      ? { code: isCloseCode(code) ? code : WsCloseCode.InternalError, reason: closeReason(reason), initiator }
      : { code, reason, initiator }
    this.#state = 'closing'
    this.#closing = info
    this.#abort.abort(new WsClosedError())
    this.#queue.length = 0
    if (!frame) return
    this.#closeTimer = setTimeout(() => this.#socket?.terminate(), this.#limits.closeTimeoutMs)
    this.#closeTimer.unref?.()
    try {
      this.#socket?.close(info.code, info.reason)
    } catch {
      this.#socket?.terminate()
    }
  }

  #socketClosed(code: number, reason: string): void {
    if (this.#state === 'closed') return
    if (this.#state === 'open') this.#beginClose(code, reason, 'client', false)
    if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer)
    void this.#finish()
  }

  async #finish(): Promise<void> {
    // known from now on: @OnDisconnect reads it
    const info = this.#closing ?? { code: 1006, reason: '', initiator: 'error' as const }
    this.#closeInfo = info
    while (this.#running.size > 0) await Promise.all([...this.#running])
    if (this.#connected) await this.#driver.disconnect(this).catch(() => undefined)
    this.#registry.remove(this)
    this.#state = 'closed'
    this.#stopDrainPoll()
    for (const waiter of this.#drainWaiters.splice(0)) waiter.reject(new WsClosedError())
    this.#driver.closed(this, info)
    this.#finished.resolve(info)
  }
}
