/**
 * The client of `WebSocketPlugin.connect()` (RFC 0003 §5.10): an in-memory connection that speaks
 * the `events` protocol (requests, replies, server events) or sends raw frames, with every received
 * frame buffered from the start so that tests never race the server.
 */
import type { InjectResponse } from '@znight/http'
import type { MemoryClient, MemoryCloseInfo } from './transports/memory.ts'

/** Options of `WebSocketPlugin.connect()`. */
export interface WsConnectOptions {
  /** Query parameters appended to the path. */
  readonly query?: Readonly<Record<string, string | readonly string[]>>
  /** Request headers of the handshake. */
  readonly headers?: Readonly<Record<string, string>>
  /** Offered subprotocols (`sec-websocket-protocol`), in preference order. */
  readonly protocols?: readonly string[]
  /** The `origin` header (a browser's). Default: none, like a non-browser client. */
  readonly origin?: string
  /** Cookies of the handshake. */
  readonly cookies?: Readonly<Record<string, string>>
  /**
   * Aborting it before the connection opens disconnects the client: `ctx.signal` of the handshake
   * aborts (`kind: 'client'`), the handshake is not completed and `connect()` rejects with the
   * signal's reason. Ignored once the connection is open (close the client instead).
   */
  readonly signal?: AbortSignal
}

/** Options of the waiting methods of {@link WsClient}. */
export interface WsWaitOptions {
  /** Default: 1 000 ms (`request()`: 5 000 ms). */
  readonly timeoutMs?: number
}

/** A refused handshake: the HTTP response the server answered. */
export class WsHandshakeError extends Error {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[]>>
  readonly body: string
  readonly #response: InjectResponse

  constructor(response: InjectResponse) {
    super(`The WebSocket handshake was refused with ${response.status}: ${response.body}`)
    this.name = 'WsHandshakeError'
    this.status = response.status
    this.headers = response.headers
    this.body = response.body
    this.#response = response
  }

  /** The body parsed as JSON. */
  json<T = unknown>(): T {
    return this.#response.json<T>()
  }
}

/** The failure reply of a request (`{ id, error }`). */
export class WsRequestError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(
    event: string,
    error: { readonly code?: unknown; readonly message?: unknown; readonly details?: unknown },
  ) {
    super(typeof error.message === 'string' ? error.message : `The request "${event}" failed`)
    this.name = 'WsRequestError'
    this.code = typeof error.code === 'string' ? error.code : 'INTERNAL'
    this.details = error.details
  }
}

interface Entry {
  readonly frame: string | Uint8Array
  /** The decoded envelope, `undefined` for a binary or non-JSON frame. */
  readonly envelope: Readonly<Record<string, unknown>> | undefined
  /** Taken by `next()` or a request. */
  consumed: boolean
  /** Taken by `nextRaw()`. */
  rawConsumed: boolean
}

interface Waiter {
  readonly match: (entry: Entry) => boolean
  readonly take: (entry: Entry) => void
}

function decode(frame: string | Uint8Array): Readonly<Record<string, unknown>> | undefined {
  if (typeof frame !== 'string') return undefined
  try {
    const value: unknown = JSON.parse(frame)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** An in-memory WebSocket client (`WebSocketPlugin.connect()`, `TestApp.connect()`). */
export class WsClient implements AsyncDisposable {
  readonly #peer: MemoryClient
  readonly #entries: Entry[] = []
  readonly #waiters = new Set<Waiter>()
  readonly #closed: PromiseWithResolvers<MemoryCloseInfo> = Promise.withResolvers()
  #nextId = 1

  /** @internal Created by `WebSocketPlugin.connect()` once the handshake succeeded. */
  constructor(peer: MemoryClient) {
    this.#peer = peer
    for (const frame of peer.received) this.#receive(frame)
    peer.onmessage = frame => this.#receive(frame)
    const ended = peer.closed
    if (ended === undefined) {
      peer.onclose = info => this.#closed.resolve(info)
    } else {
      this.#closed.resolve(ended)
    }
  }

  /** The negotiated subprotocol, `''` when none. */
  get protocol(): string {
    return this.#peer.protocol
  }

  /** Every frame received, in order: JSON objects decoded, other text frames as strings, binary frames as bytes. */
  get frames(): readonly unknown[] {
    return this.#entries.map(entry => entry.envelope ?? entry.frame)
  }

  /** Resolves once the connection closed (by either side). */
  get closed(): Promise<MemoryCloseInfo> {
    return this.#closed.promise
  }

  /** Sends an event without id (fire and forget). */
  send(event: string, data?: unknown): void {
    this.#peer.send(JSON.stringify(data === undefined ? { event } : { event, data }))
  }

  /** Sends a request and resolves with the `data` of its reply; rejects with {@link WsRequestError}. */
  request<T = unknown>(event: string, data?: unknown, options: WsWaitOptions = {}): Promise<T> {
    const id = this.#nextId++
    const reply = this.#wait<T>(
      entry => !entry.consumed && entry.envelope?.['id'] === id && entry.envelope['event'] === undefined,
      (entry, resolve, reject) => {
        entry.consumed = true
        const envelope = entry.envelope as Record<string, unknown>
        if (envelope['error'] === undefined) {
          resolve(envelope['data'] as T)
        } else {
          reject(new WsRequestError(event, envelope['error'] as object))
        }
      },
      options.timeoutMs ?? 5_000,
      `the reply to "${event}" (id ${id})`,
    )
    this.#peer.send(JSON.stringify(data === undefined ? { event, id } : { event, data, id }))
    return reply
  }

  /** The `data` of the oldest server event (matching `event`) not taken yet. */
  next<T = unknown>(event?: string, options: WsWaitOptions = {}): Promise<T> {
    return this.#wait<T>(
      entry =>
        !entry.consumed &&
        typeof entry.envelope?.['event'] === 'string' &&
        (event === undefined || entry.envelope['event'] === event),
      (entry, resolve) => {
        entry.consumed = true
        resolve((entry.envelope as Record<string, unknown>)['data'] as T)
      },
      options.timeoutMs ?? 1_000,
      event === undefined ? 'a server event' : `the event "${event}"`,
    )
  }

  /** Sends a frame as is (a string is a text frame). */
  sendRaw(frame: string | Uint8Array): void {
    this.#peer.send(frame)
  }

  /** The oldest frame not taken by `nextRaw()` yet, as received. */
  nextRaw(options: WsWaitOptions = {}): Promise<string | Uint8Array> {
    return this.#wait<string | Uint8Array>(
      entry => !entry.rawConsumed,
      (entry, resolve) => {
        entry.rawConsumed = true
        resolve(entry.frame)
      },
      options.timeoutMs ?? 1_000,
      'a frame',
    )
  }

  /** Closes the connection and resolves with how it closed. */
  close(code = 1000, reason = ''): Promise<MemoryCloseInfo> {
    this.#peer.close(code, reason)
    return this.#closed.promise
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  #wait<T>(
    match: (entry: Entry) => boolean,
    take: (entry: Entry, resolve: (value: T) => void, reject: (error: Error) => void) => void,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const found = this.#entries.find(match)
    if (found !== undefined) {
      take(found, resolve, reject)
      return promise
    }
    if (this.#peer.closed !== undefined) {
      reject(new Error(`The WebSocket connection is closed: no ${what} will arrive`))
      return promise
    }
    const timer = setTimeout(() => {
      this.#waiters.delete(waiter)
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`))
    }, timeoutMs)
    const waiter: Waiter = {
      match,
      take: entry => {
        clearTimeout(timer)
        take(entry, resolve, reject)
      },
    }
    this.#waiters.add(waiter)
    void this.#closed.promise.then(() => {
      if (!this.#waiters.delete(waiter)) return
      clearTimeout(timer)
      reject(new Error(`The WebSocket connection closed while waiting for ${what}`))
    })
    return promise
  }

  #receive(frame: string | Uint8Array): void {
    const entry: Entry = { frame, envelope: decode(frame), consumed: false, rawConsumed: false }
    this.#entries.push(entry)
    // waiters in arrival order; each re-checks the entry, which an earlier waiter may have taken
    for (const waiter of this.#waiters) {
      if (!waiter.match(entry)) continue
      this.#waiters.delete(waiter)
      waiter.take(entry)
    }
  }
}
