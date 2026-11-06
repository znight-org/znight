/**
 * WebSocket test clients (RFC 0003 §5.10). `TestApp.connect()` delegates to the plugin named
 * `websocket` (`WebSocketPlugin` of `@znight/websocket`, an in-memory connection);
 * `connectWebSocket(url)` wraps the global `WebSocket` (Node.js and Bun) with the same interface.
 * `@znight/testing` depends on no feature package: the errors match structurally.
 */

/** How a connection closed. */
export interface TestWsCloseInfo {
  readonly code: number
  readonly reason: string
}

/** Options of the waiting methods of {@link TestWsClient}. */
export interface TestWsWaitOptions {
  /** Default: 1 000 ms (`request()`: 5 000 ms). */
  readonly timeoutMs?: number
}

/** A WebSocket client speaking the `events` protocol of `@znight/websocket`, or raw frames. */
export interface TestWsClient extends AsyncDisposable {
  /** The negotiated subprotocol, `''` when none. */
  readonly protocol: string
  /** Every frame received, in order: JSON objects decoded, other text frames as strings, binary frames as bytes. */
  readonly frames: readonly unknown[]
  /** Sends an event without id. */
  send(event: string, data?: unknown): void
  /** Sends a request; resolves with the `data` of its reply, rejects with a {@link WsRequestError}. */
  request<T = unknown>(event: string, data?: unknown, options?: TestWsWaitOptions): Promise<T>
  /** The `data` of the oldest server event (matching `event`) not taken yet: frames are buffered from the start. */
  next<T = unknown>(event?: string, options?: TestWsWaitOptions): Promise<T>
  sendRaw(frame: string | Uint8Array): void
  nextRaw(options?: TestWsWaitOptions): Promise<string | Uint8Array>
  close(code?: number, reason?: string): Promise<TestWsCloseInfo>
  readonly closed: Promise<TestWsCloseInfo>
}

/** Options of `TestApp.connect()`. */
export interface TestWsConnectOptions {
  readonly query?: Readonly<Record<string, string | readonly string[]>>
  readonly headers?: Readonly<Record<string, string>>
  readonly protocols?: readonly string[]
  /** The `origin` header (a browser's). Default: none. */
  readonly origin?: string
  readonly cookies?: Readonly<Record<string, string>>
}

/** Options of {@link connectWebSocket}. */
export interface ConnectWebSocketOptions {
  /** Handshake headers (Node.js and Bun clients accept them; browsers cannot set any). */
  readonly headers?: Readonly<Record<string, string>>
  readonly protocols?: readonly string[]
  /** Default: 2 000 ms. */
  readonly timeoutMs?: number
}

/** What `TestApp.connect()` expects from the plugin named `'websocket'`. */
export interface WebSocketConnector {
  connect(path: string, options?: TestWsConnectOptions): Promise<TestWsClient>
}

/**
 * A refused handshake (`status`, `headers`, `body`, `json()`). `instanceof` also matches the
 * `WsHandshakeError` of `@znight/websocket` (what `TestApp.connect()` rejects with).
 */
export class WsHandshakeError extends Error {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[]>>
  readonly body: string

  constructor(status: number, headers: Readonly<Record<string, string | string[]>> = {}, body = '') {
    super(`The WebSocket handshake was refused with ${status}: ${body}`)
    this.name = 'WsHandshakeError'
    this.status = status
    this.headers = headers
    this.body = body
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      value instanceof Error &&
      value.name === 'WsHandshakeError' &&
      typeof (value as { status?: unknown }).status === 'number'
    )
  }

  /** The body parsed as JSON. */
  json<T = unknown>(): T {
    return JSON.parse(this.body) as T
  }
}

/** The failure reply of a request (`code`, `message`, `details`); matches `@znight/websocket`'s too. */
export class WsRequestError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'WsRequestError'
    this.code = code
    this.details = details
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      value instanceof Error &&
      value.name === 'WsRequestError' &&
      typeof (value as { code?: unknown }).code === 'string'
    )
  }
}

interface Entry {
  readonly frame: string | Uint8Array
  readonly envelope: Readonly<Record<string, unknown>> | undefined
  consumed: boolean
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

/** A {@link TestWsClient} over a global `WebSocket`. */
class NetworkClient implements TestWsClient {
  readonly #ws: WebSocket
  readonly #entries: Entry[] = []
  readonly #waiters = new Set<Waiter>()
  readonly #closed = Promise.withResolvers<TestWsCloseInfo>()
  #ended = false
  #nextId = 1

  constructor(ws: WebSocket) {
    this.#ws = ws
    ws.addEventListener('message', event => {
      const data: unknown = event.data
      this.#receive(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer))
    })
    ws.addEventListener('close', event => {
      this.#ended = true
      this.#closed.resolve({ code: event.code, reason: event.reason })
    })
  }

  get protocol(): string {
    return this.#ws.protocol
  }

  get frames(): readonly unknown[] {
    return this.#entries.map(entry => entry.envelope ?? entry.frame)
  }

  get closed(): Promise<TestWsCloseInfo> {
    return this.#closed.promise
  }

  send(event: string, data?: unknown): void {
    this.#ws.send(JSON.stringify(data === undefined ? { event } : { event, data }))
  }

  request<T = unknown>(event: string, data?: unknown, options: TestWsWaitOptions = {}): Promise<T> {
    const id = this.#nextId++
    const reply = this.#wait<T>(
      entry => !entry.consumed && entry.envelope?.['id'] === id && entry.envelope['event'] === undefined,
      (entry, resolve, reject) => {
        entry.consumed = true
        const envelope = entry.envelope as Record<string, unknown>
        const error = envelope['error'] as Record<string, unknown> | undefined
        if (error === undefined) {
          resolve(envelope['data'] as T)
        } else {
          reject(
            new WsRequestError(
              typeof error['code'] === 'string' ? error['code'] : 'INTERNAL',
              typeof error['message'] === 'string' ? error['message'] : `The request "${event}" failed`,
              error['details'],
            ),
          )
        }
      },
      options.timeoutMs ?? 5_000,
      `the reply to "${event}" (id ${id})`,
    )
    this.#ws.send(JSON.stringify(data === undefined ? { event, id } : { event, data, id }))
    return reply
  }

  next<T = unknown>(event?: string, options: TestWsWaitOptions = {}): Promise<T> {
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

  sendRaw(frame: string | Uint8Array): void {
    this.#ws.send(frame)
  }

  nextRaw(options: TestWsWaitOptions = {}): Promise<string | Uint8Array> {
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

  close(code = 1000, reason = ''): Promise<TestWsCloseInfo> {
    if (!this.#ended) this.#ws.close(code, reason)
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
    if (this.#ended) {
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
    for (const waiter of this.#waiters) {
      if (!waiter.match(entry)) continue
      this.#waiters.delete(waiter)
      waiter.take(entry)
    }
  }
}

/**
 * Connects to a WebSocket server over the network (end-to-end tests, Node.js and Bun) and returns
 * a {@link TestWsClient}. Rejects with a {@link WsHandshakeError} (`status: 0`: the client cannot
 * read the status of a refused handshake) when the connection fails.
 *
 * ```ts
 * await using client = await connectWebSocket(`ws://127.0.0.1:${port}/chat`, { headers: { 'x-api-key': KEY } })
 * ```
 */
export function connectWebSocket(url: string, options: ConnectWebSocketOptions = {}): Promise<TestWsClient> {
  const Socket = WebSocket as unknown as new (
    url: string,
    init: { readonly headers?: Readonly<Record<string, string>>; readonly protocols?: readonly string[] },
  ) => WebSocket
  const ws = new Socket(url, {
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
  })
  ws.binaryType = 'arraybuffer'
  const client = new NetworkClient(ws)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`connectWebSocket(${url}): no handshake after ${options.timeoutMs ?? 2_000} ms`))
    }, options.timeoutMs ?? 2_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(client)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new WsHandshakeError(0, {}, `connectWebSocket(${url}) failed`))
    })
  })
}
