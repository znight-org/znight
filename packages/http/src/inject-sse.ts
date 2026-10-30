/**
 * `injectSse()`: an in-memory `EventSource` for tests, on top of `injectStream()`. Events are read
 * only when asked for (`next()`, `take()`, iteration, `done`), so a test controls the pace of the
 * client. Opening never waits forever ({@link OPEN_TIMEOUT_MS} per step): without response headers
 * it fails (the request is aborted); without a first chunk (an `@Sse` stream sends `retry` or a
 * comment at once, a hand-written or proxied one may stay quiet) the stream is open anyway, and the
 * read goes on in the background.
 */
import type { InjectStreamOptions, InjectStreamRequest, InjectStreamResponse } from './adapter.ts'
import type { SetCookieInfo } from './cookies.ts'

import { isEventStreamType } from './adapters/shared.ts'
import { parseWith, type SseItem, type SseMessage, SseParser } from './sse-parse.ts'

/** Options of {@link InjectSseResponse.next} and {@link InjectSseResponse.take}. */
export interface InjectSseWaitOptions {
  /** Maximum wait for each event (ms). Default: 2 000. */
  readonly timeoutMs?: number
}

/** The response of `injectSse()`: an event stream read in memory, like `EventSource` would. */
export interface InjectSseResponse extends AsyncIterable<SseMessage>, AsyncDisposable {
  readonly status: number
  readonly headers: Record<string, string | string[]>
  readonly cookies: Readonly<Record<string, SetCookieInfo>>
  /** `''` for an event stream; otherwise the whole body, read to its end (an error, a 204...). */
  readonly body: string
  /** `JSON.parse(body)`. */
  json<T = unknown>(): T
  /** The next event (comments skipped). Rejects on timeout (default 2 000 ms) or when the stream ended. */
  next(options?: InjectSseWaitOptions): Promise<SseMessage>
  /** The next `count` events (the timeout applies to each). */
  take(count: number, options?: InjectSseWaitOptions): Promise<SseMessage[]>
  /** Comments received so far (heartbeats are `''`). */
  readonly comments: readonly string[]
  /** What a browser would send as `Last-Event-ID` on reconnection. */
  readonly lastEventId: string
  /** The last `retry` received (ms). */
  readonly retry: number | undefined
  /** Resolves when the server ends the stream (reading the remaining events, which stay available to `next()`). */
  readonly done: Promise<void>
  /** Disconnects (cancels the body): the server sees a client disconnect. Idempotent. */
  close(): Promise<void>
  /** Reconnects like `EventSource`: closes this stream and sends the same request plus `last-event-id`. */
  reconnect(): Promise<InjectSseResponse>
}

const DEFAULT_TIMEOUT_MS = 2_000
/** How long opening waits for the response headers, then for the first chunk of an event stream (ms). */
const OPEN_TIMEOUT_MS = 2_000
const DECODER = new TextDecoder()

type InjectStream = (request: InjectStreamOptions) => Promise<InjectStreamResponse>

/**
 * Opens an event stream with `injectStream` (adds `accept: text/event-stream` when absent), waiting
 * at most `openTimeoutMs` for the response headers, then at most `openTimeoutMs` for the first chunk.
 */
export async function openInjectSse(
  injectStream: InjectStream,
  request: InjectStreamOptions,
  openTimeoutMs: number = OPEN_TIMEOUT_MS,
): Promise<InjectSseResponse> {
  if (request === null || typeof request !== 'object') throw new TypeError('injectSse() expects a request object')
  const headers: Record<string, string> = { ...request.headers }
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'accept')) headers['accept'] = 'text/event-stream'
  const sent: InjectStreamRequest = { ...request, method: request.method ?? 'GET', headers }
  const response = await answered(injectStream, sent, openTimeoutMs)
  if (!isEventStreamType(response.headers['content-type'])) {
    const body = await readText(response.body)
    return new SseClient(injectStream, sent, response, body, openTimeoutMs)
  }
  const client = new SseClient(injectStream, sent, response, '', openTimeoutMs)
  // the first chunk makes `retry` and `comments` known at once; a quiet stream must not hang the test
  await client.ready()
  return client
}

/**
 * `injectStream(request)`, waiting at most `ms` for the response headers. Past it, the request is
 * aborted (a late response is cancelled: the server sees a client disconnect) and opening fails
 * with an error naming the request, instead of hanging the test.
 */
async function answered(
  injectStream: InjectStream,
  request: InjectStreamRequest,
  ms: number,
): Promise<InjectStreamResponse> {
  const abort = new AbortController()
  const signal = request.signal === undefined ? abort.signal : AbortSignal.any([request.signal, abort.signal])
  const pending = injectStream({ ...request, signal })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  const response = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer))
  if (response !== undefined) return response
  const message = `injectSse(): no response from ${describe(request)} within ${ms} ms`
  abort.abort(new Error(message))
  void pending.then(
    late => late.body.cancel().catch(() => undefined),
    () => undefined,
  )
  throw new Error(
    `${message}: the handler has not answered, or the adapter holds the response headers until the first byte of the body`,
  )
}

/** `GET /orders/o-1/events`. */
function describe(request: InjectStreamRequest): string {
  return `${(request.method ?? 'GET').toUpperCase()} ${request.url}`
}

async function readText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + DECODER.decode()
    text += DECODER.decode(value, { stream: true })
  }
}

class SseClient implements InjectSseResponse {
  readonly status: number
  readonly headers: Record<string, string | string[]>
  readonly cookies: Readonly<Record<string, SetCookieInfo>>
  readonly body: string
  readonly #injectStream: InjectStream
  readonly #request: InjectStreamRequest
  readonly #openTimeoutMs: number
  readonly #parser = new SseParser()
  readonly #items: AsyncIterableIterator<SseItem> | undefined
  readonly #events: SseMessage[] = []
  readonly #comments: string[] = []
  #retry: number | undefined
  /** Whether an item (event, comment, `retry`) was read since the stream opened. */
  #received = false
  #ended: boolean
  #failure: unknown
  #reading: Promise<void> | undefined
  #closing: Promise<void> | undefined
  #draining: Promise<void> | undefined

  constructor(
    injectStream: InjectStream,
    request: InjectStreamRequest,
    response: InjectStreamResponse,
    body: string,
    openTimeoutMs: number,
  ) {
    this.#injectStream = injectStream
    this.#request = request
    this.#openTimeoutMs = openTimeoutMs
    this.status = response.status
    this.headers = response.headers
    this.cookies = response.cookies
    this.body = body
    const stream = isEventStreamType(response.headers['content-type'])
    this.#ended = !stream
    this.#items = stream ? parseWith(this.#parser, response.body) : undefined
  }

  get comments(): readonly string[] {
    return [...this.#comments]
  }

  get lastEventId(): string {
    return this.#parser.lastEventId
  }

  get retry(): number | undefined {
    return this.#retry
  }

  get done(): Promise<void> {
    this.#draining ??= (async (): Promise<void> => {
      while (!this.#ended) await this.#read()
    })()
    return this.#draining
  }

  json<T = unknown>(): T {
    return JSON.parse(this.body) as T
  }

  /**
   * Reads the first item (the preamble every `@Sse` stream starts with, so that `retry` is known),
   * waiting at most the open timeout: the read of a quiet stream goes on in the background.
   */
  async ready(): Promise<void> {
    await this.#readWithin(this.#openTimeoutMs)
  }

  async next(options: InjectSseWaitOptions = {}): Promise<SseMessage> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!(timeoutMs >= 0)) throw new TypeError('injectSse(): timeoutMs must be a number ≥ 0')
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const event = this.#events.shift()
      if (event !== undefined) return event
      if (this.#ended) {
        throw new Error(`injectSse(): the event stream of ${this.#describe()} ended`, {
          ...(this.#failure === undefined ? {} : { cause: this.#failure }),
        })
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0 || !(await this.#readWithin(remaining))) {
        const quiet = this.#received ? '' : ' (the stream has sent nothing since it opened)'
        throw new Error(`injectSse(): no event received within ${timeoutMs} ms from ${this.#describe()}${quiet}`)
      }
    }
  }

  async take(count: number, options?: InjectSseWaitOptions): Promise<SseMessage[]> {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('injectSse(): take() expects an integer ≥ 0')
    const events: SseMessage[] = []
    while (events.length < count) events.push(await this.next(options))
    return events
  }

  close(): Promise<void> {
    if (this.#closing === undefined) {
      this.#ended = true
      this.#closing =
        this.#items === undefined
          ? Promise.resolve()
          : (this.#items.return?.().then(() => undefined) ?? Promise.resolve())
    }
    return this.#closing
  }

  async reconnect(): Promise<InjectSseResponse> {
    await this.close()
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(this.#request.headers ?? {})) {
      if (name.toLowerCase() !== 'last-event-id') headers[name] = value
    }
    // EventSource only sends a non-empty last event id
    if (this.lastEventId !== '') headers['last-event-id'] = this.lastEventId
    return openInjectSse(this.#injectStream, { ...this.#request, headers }, this.#openTimeoutMs)
  }

  [Symbol.asyncIterator](): AsyncIterator<SseMessage> {
    return {
      next: async (): Promise<IteratorResult<SseMessage>> => {
        for (;;) {
          const event = this.#events.shift()
          if (event !== undefined) return { done: false, value: event }
          if (this.#ended) return { done: true, value: undefined }
          await this.#read()
        }
      },
      return: async (): Promise<IteratorResult<SseMessage>> => {
        await this.close()
        return { done: true, value: undefined }
      },
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /** Waits for the next item at most `ms` (the read goes on in the background); `false` on timeout. */
  async #readWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), ms)
    })
    const outcome = await Promise.race([this.#read().then(() => true as const), timeout])
    clearTimeout(timer)
    return outcome
  }

  /** Reads one item (one read at a time, shared by concurrent callers). */
  #read(): Promise<void> {
    this.#reading ??= this.#readItem().finally(() => {
      this.#reading = undefined
    })
    return this.#reading
  }

  async #readItem(): Promise<void> {
    const items = this.#items
    if (items === undefined || this.#ended) return
    let result: IteratorResult<SseItem>
    try {
      result = await items.next()
    } catch (error) {
      this.#failure = error
      this.#ended = true
      return
    }
    if (result.done === true) {
      this.#ended = true
      return
    }
    const item = result.value
    this.#received = true
    if (item.type === 'comment') this.#comments.push(item.text)
    else if (item.type === 'retry') this.#retry = item.retry
    else this.#events.push({ event: item.event, data: item.data, id: item.id, json: item.json })
  }

  #describe(): string {
    return describe(this.#request)
  }
}
