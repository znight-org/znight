/**
 * Client side of Server-Sent Events: the WHATWG "interpreting an event stream" algorithm over a
 * byte stream (`parseSseStream`), used by `injectSse()` and by tests over real sockets. Import-free.
 */

/** A dispatched event. */
export interface SseMessage {
  /** Event type: `message` by default. */
  readonly event: string
  readonly data: string
  /** The last event id at dispatch time (what `EventSource` sends back as `Last-Event-ID`). */
  readonly id: string
  /** `JSON.parse(data)`. */
  json<T = unknown>(): T
}

/** An item of an event stream: an event, a comment (heartbeats are `''`) or a reconnection delay. */
export type SseItem =
  | ({ readonly type: 'event' } & SseMessage)
  | { readonly type: 'comment'; readonly text: string }
  | { readonly type: 'retry'; readonly retry: number }

/** Options of {@link parseSseStream}. */
export interface ParseSseOptions {
  /** Stops reading (the body is cancelled) when aborted. */
  readonly signal?: AbortSignal
}

/**
 * Incremental parser (internal): feed it decoded text, collect the items. Follows the HTML
 * specification: CR, LF and CRLF line ends (a CR at the end of a chunk included), one leading space
 * stripped from values, `data` lines buffered and the final LF removed, `id` values containing NUL
 * ignored, `retry` accepted only as ASCII digits, the type defaulting to `message`, an event without
 * data not dispatched.
 */
export class SseParser {
  /** The last event id (updated when an event is dispatched, even without data). */
  lastEventId = ''
  #line = ''
  #skipLf = false
  #data = ''
  #hasData = false
  #type = ''
  #idBuffer = ''

  /** Parses a chunk of text; returns the items it completes. */
  push(text: string): SseItem[] {
    const items: SseItem[] = []
    let start = 0
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code === 0x0a && this.#skipLf) {
        // the LF of a CRLF (possibly split across chunks)
        this.#skipLf = false
        start = index + 1
        continue
      }
      this.#skipLf = false
      if (code !== 0x0a && code !== 0x0d) continue
      this.#line += text.slice(start, index)
      this.#processLine(this.#line, items)
      this.#line = ''
      start = index + 1
      if (code === 0x0d) this.#skipLf = true
    }
    if (start < text.length) this.#line += text.slice(start)
    return items
  }

  #processLine(line: string, items: SseItem[]): void {
    if (line === '') {
      this.#dispatch(items)
      return
    }
    const colon = line.indexOf(':')
    if (colon === 0) {
      items.push({ type: 'comment', text: line.charCodeAt(1) === 0x20 ? line.slice(2) : line.slice(1) })
      return
    }
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.charCodeAt(0) === 0x20) value = value.slice(1)
    switch (field) {
      case 'event':
        this.#type = value
        break
      case 'data':
        this.#data += `${value}\n`
        this.#hasData = true
        break
      case 'id':
        if (!value.includes('\u0000')) this.#idBuffer = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) items.push({ type: 'retry', retry: Number(value) })
        break
      default:
        break
    }
  }

  #dispatch(items: SseItem[]): void {
    this.lastEventId = this.#idBuffer
    if (!this.#hasData) {
      this.#type = ''
      return
    }
    const data = this.#data.endsWith('\n') ? this.#data.slice(0, -1) : this.#data
    const event = this.#type === '' ? 'message' : this.#type
    const id = this.lastEventId
    items.push({ type: 'event', event, data, id, json: <T = unknown>(): T => JSON.parse(data) as T })
    this.#data = ''
    this.#hasData = false
    this.#type = ''
  }
}

/**
 * Turns an event stream body (a `fetch()` response body, `injectStream().body`) into its items.
 * UTF-8 is decoded with the BOM stripped; an unterminated event at the end is discarded. Calling
 * `return()` (leaving a `for await` loop) or aborting `signal` cancels the body.
 *
 * ```ts
 * const response = await fetch(`${http.address}/orders/o-1/events`)
 * for await (const item of parseSseStream(response.body!)) {
 *   if (item.type === 'event') console.log(item.event, item.json())
 * }
 * ```
 */
export function parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: ParseSseOptions = {},
): AsyncIterableIterator<SseItem> {
  return parseWith(new SseParser(), body, options)
}

/** {@link parseSseStream} with a given parser (internal: `injectSse()` reads its `lastEventId`). */
export function parseWith(
  parser: SseParser,
  body: ReadableStream<Uint8Array>,
  options: ParseSseOptions = {},
): AsyncIterableIterator<SseItem> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const queue: SseItem[] = []
  let ended = false
  let cancelled: Promise<void> = Promise.resolve()
  const stop = (): void => {
    if (ended) return
    ended = true
    queue.length = 0
    cancelled = reader.cancel().catch(() => undefined)
  }
  const signal = options.signal
  if (signal !== undefined) {
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  }
  const iterator: AsyncIterableIterator<SseItem> = {
    async next(): Promise<IteratorResult<SseItem>> {
      for (;;) {
        const queued = queue.shift()
        if (queued !== undefined) return { done: false, value: queued }
        if (ended) return { done: true, value: undefined }
        let result: Awaited<ReturnType<typeof reader.read>>
        try {
          result = await reader.read()
        } catch (error) {
          if (ended) return { done: true, value: undefined }
          ended = true
          throw error
        }
        if (result.done) {
          // the decoder may hold the start of a character; an unterminated event is discarded
          parser.push(decoder.decode())
          ended = true
          signal?.removeEventListener('abort', stop)
          return { done: true, value: undefined }
        }
        if (!ended) queue.push(...parser.push(decoder.decode(result.value, { stream: true })))
      }
    },
    async return(): Promise<IteratorResult<SseItem>> {
      stop()
      signal?.removeEventListener('abort', stop)
      await cancelled
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<SseItem> {
      return iterator
    },
  }
  return iterator
}
