/**
 * `injectSse()`: an in-memory `EventSource` for tests, on top of `injectStream()`. Events are read
 * only when asked for (`next()`, `take()`, iteration, `done`), so a test controls the pace of the
 * client.
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
const DECODER = new TextDecoder()

type InjectStream = (request: InjectStreamOptions) => Promise<InjectStreamResponse>

/** Opens an event stream with `injectStream` (adds `accept: text/event-stream` when absent). */
export async function openInjectSse(
  injectStream: InjectStream,
  request: InjectStreamOptions,
): Promise<InjectSseResponse> {
  if (request === null || typeof request !== 'object') throw new TypeError('injectSse() expects a request object')
  const headers: Record<string, string> = { ...request.headers }
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'accept')) headers['accept'] = 'text/event-stream'
  const sent: InjectStreamRequest = { ...request, method: request.method ?? 'GET', headers }
  const response = await injectStream(sent)
  if (!isEventStreamType(response.headers['content-type'])) {
    const body = await readText(response.body)
    return new SseClient(injectStream, sent, response, body)
  }
  const client = new SseClient(injectStream, sent, response, '')
  await client.ready()
  return client
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
  readonly #parser = new SseParser()
  readonly #items: AsyncIterableIterator<SseItem> | undefined
  readonly #events: SseMessage[] = []
  readonly #comments: string[] = []
  #retry: number | undefined
  #ended: boolean
  #failure: unknown
  #reading: Promise<void> | undefined
  #closing: Promise<void> | undefined
  #draining: Promise<void> | undefined

  constructor(injectStream: InjectStream, request: InjectStreamRequest, response: InjectStreamResponse, body: string) {
    this.#injectStream = injectStream
    this.#request = request
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

  /** Reads the first item (the preamble every Znight event stream starts with): headers and `retry` are known. */
  async ready(): Promise<void> {
    await this.#read()
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
        throw new Error(`injectSse(): no event received within ${timeoutMs} ms from ${this.#describe()}`)
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
    return openInjectSse(this.#injectStream, { ...this.#request, headers })
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
    if (item.type === 'comment') this.#comments.push(item.text)
    else if (item.type === 'retry') this.#retry = item.retry
    else this.#events.push({ event: item.event, data: item.data, id: item.id, json: item.json })
  }

  #describe(): string {
    return `${(this.#request.method ?? 'GET').toUpperCase()} ${this.#request.url}`
  }
}
