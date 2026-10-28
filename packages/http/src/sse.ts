/**
 * Server-Sent Events (RFC 0006 §4.6, §4.7): the event encoder, the `HttpResponse.sse()` body marker
 * and the event stream (preamble, pull loop, heartbeats, raw byte passthrough, error handling,
 * graceful close with a jittered `retry`, bounded source stop).
 */
import type { RequestAbortKind } from './context.ts'

import { type ContextRunner, captureContext } from './stream.ts'

/** One event of an event stream. */
export interface SseEvent<T = unknown> {
  /** A string is sent as is; anything else goes through `JSON.stringify` (`toJSON` honoured). */
  readonly data?: T
  /** Event type (`addEventListener(type)`). The client defaults to `message`. No CR or LF. */
  readonly event?: string
  /** Last event id, echoed by the client as `Last-Event-ID`. No CR, LF or NUL. `''` resets it. */
  readonly id?: string | number
  /** Reconnection delay in ms (a safe integer ≥ 0). */
  readonly retry?: number
  /** Comment lines, ignored by `EventSource` (debugging, padding). */
  readonly comment?: string
}

/** Options of `@Sse()` and `HttpResponse.sse()`. */
export interface SseOptions {
  /**
   * Milliseconds without an event after which a keep-alive comment (`:`) is sent (an integer
   * from 1 000 to 2 147 483 647). `false` disables it. Default: the plugin option `sse.heartbeat`
   * (8 000).
   */
  readonly heartbeat?: number | false
  /**
   * Client reconnection delay (`retry:`, ms), sent first. Default: the plugin option `sse.retry`
   * (none: browsers use about 3 s).
   */
  readonly retry?: number
  /**
   * The server ends the stream gracefully after this many ms (load rebalancing, re-authentication):
   * `ctx.signal` aborts (`'expired'`), then the client gets a jittered `retry` and reconnects. An
   * integer from 1 000 to 2 147 483 647 (about 24.8 days, the longest timer). Default: none.
   */
  readonly maxDuration?: number
}

/**
 * What `@Sse` handlers and `HttpResponse.sse()` accept: an async iterable (async generators,
 * `EventChannel`, a Node.js `Readable` of raw bytes), an iterable (arrays, sync generators; not
 * strings) or a `ReadableStream`, of `SseEvent` objects or `Uint8Array` chunks (already-framed SSE
 * text, written as is: proxying an upstream event stream).
 */
export type SseSource =
  | AsyncIterable<SseEvent | Uint8Array>
  | Iterable<SseEvent>
  | ReadableStream<SseEvent | Uint8Array>

/** The body of `HttpResponse.sse()`: an event source and its options (served by the plugin). */
export class SseBody {
  readonly source: SseSource
  readonly options: SseOptions

  constructor(source: SseSource, options: SseOptions = {}) {
    if (!isSseSource(source)) {
      throw new TypeError(
        'HttpResponse.sse() expects an AsyncIterable, an Iterable or a ReadableStream of SseEvent (not a string)',
      )
    }
    checkSseOptions(options, 'HttpResponse.sse()')
    this.source = source
    this.options = options
  }
}

/** Whether `value` is an {@link SseBody}. */
export function isSseBody(value: unknown): value is SseBody {
  return value instanceof SseBody
}

/** Whether `value` can be served as an event stream (async iterable, non-string iterable, `ReadableStream`). */
export function isSseSource(value: unknown): value is SseSource {
  if (value instanceof ReadableStream) return true
  if (value === null || typeof value !== 'object') return false
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function' ||
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  )
}

/** Smallest heartbeat and `maxDuration` (ms). */
export const MIN_SSE_INTERVAL_MS = 1_000
/**
 * Longest heartbeat, `maxDuration` and grace period (ms): the longest `setTimeout` delay (larger
 * ones overflow to 1 ms on Node.js and Bun, which would end every stream at once).
 */
export const MAX_SSE_TIMER_MS = 2_147_483_647

/**
 * Checks SSE options (`HttpResponse.sse()`, hand-written metadata): `heartbeat` an integer from
 * 1 000 to 2 147 483 647 or `false`, `retry` an integer ≥ 0, `maxDuration` an integer from 1 000 to
 * 2 147 483 647, no other key.
 *
 * @throws TypeError naming `what`.
 */
export function checkSseOptions(options: unknown, what: string): void {
  const problem = sseOptionsProblem(options)
  if (problem !== undefined) throw new TypeError(`${what}: ${problem}`)
}

/** What is wrong with SSE options, `undefined` when they are valid. */
export function sseOptionsProblem(options: unknown): string | undefined {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return 'options must be an object { heartbeat?, retry?, maxDuration? }'
  }
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    switch (key) {
      case 'heartbeat':
        if (value !== false && !isInteger(value, MIN_SSE_INTERVAL_MS, MAX_SSE_TIMER_MS)) {
          return `heartbeat must be an integer number of ms from ${MIN_SSE_INTERVAL_MS} to ${MAX_SSE_TIMER_MS}, or false (received ${String(value)})`
        }
        break
      case 'retry':
        if (!isInteger(value, 0)) return `retry must be an integer number of ms ≥ 0 (received ${String(value)})`
        break
      case 'maxDuration':
        if (!isInteger(value, MIN_SSE_INTERVAL_MS, MAX_SSE_TIMER_MS)) {
          return `maxDuration must be an integer number of ms from ${MIN_SSE_INTERVAL_MS} to ${MAX_SSE_TIMER_MS} (received ${String(value)})`
        }
        break
      default:
        return `unknown option "${key}" (options: { heartbeat?, retry?, maxDuration? })`
    }
  }
  return undefined
}

function isInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

// -------------------------------------------------------------------------------------------------
// Encoding
// -------------------------------------------------------------------------------------------------

const EVENT_KEYS: ReadonlySet<string> = new Set(['data', 'event', 'id', 'retry', 'comment'])
const LINE_BREAK = /\r\n|\r|\n/

/**
 * Encodes one event (WHATWG framing): one `: <line>` per comment line, `id:`, `event:`, `retry:`,
 * then one `data: <line>` per line of the data (split on CRLF, CR and LF, so data can never inject
 * fields or end the event early), and an empty line. An `event` without `data` gets an empty
 * `data:` line (otherwise `EventSource` would not dispatch it); events with only `id`, `retry` or
 * `comment` have no data line.
 *
 * ```ts
 * encodeSseEvent({ id: 41, event: 'status', data: { status: 'paid' } })
 * // 'id: 41\nevent: status\ndata: {"status":"paid"}\n\n'
 * ```
 *
 * @throws TypeError for anything but a plain object with the keys of {@link SseEvent} (strings,
 *   numbers, `null`: yield `{ data: value }`), an empty event, an `event` / `id` with CR or LF (NUL
 *   for `id`), a `retry` that is not an integer ≥ 0, a `data` JSON cannot serialise.
 */
export function encodeSseEvent(event: SseEvent): string {
  if (event === null || typeof event !== 'object' || !isPlainObject(event)) {
    throw new TypeError(
      `Invalid SSE event: expected an object { data?, event?, id?, retry?, comment? } (received ${describe(event)}): yield { data: value }`,
    )
  }
  let defined = 0
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.has(key)) {
      throw new TypeError(`Invalid SSE event: unknown key "${key}" (keys: data, event, id, retry, comment)`)
    }
    if ((event as Record<string, unknown>)[key] !== undefined) defined++
  }
  if (defined === 0) throw new TypeError('Invalid SSE event: an empty event (set data, event, id, retry or comment)')
  const { data, event: type, id, retry, comment } = event
  let text = ''
  if (comment !== undefined) {
    if (typeof comment !== 'string') throw new TypeError('Invalid SSE event: comment must be a string')
    for (const line of comment.split(LINE_BREAK)) text += line === '' ? ':\n' : `: ${line}\n`
  }
  if (id !== undefined) {
    const value = typeof id === 'number' && Number.isFinite(id) ? String(id) : id
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new TypeError('Invalid SSE event: id must be a string without CR, LF or NUL, or a finite number')
    }
    text += `id: ${value}\n`
  }
  if (type !== undefined) {
    if (typeof type !== 'string' || /[\r\n]/.test(type)) {
      throw new TypeError('Invalid SSE event: event must be a string without CR or LF')
    }
    text += `event: ${type}\n`
  }
  if (retry !== undefined) {
    if (!isInteger(retry, 0)) throw new TypeError('Invalid SSE event: retry must be an integer number of ms ≥ 0')
    text += `retry: ${retry}\n`
  }
  if (data !== undefined) {
    for (const line of dataText(data).split(LINE_BREAK)) text += `data: ${line}\n`
  } else if (type !== undefined) {
    text += 'data: \n'
  }
  return `${text}\n`
}

function dataText(data: unknown): string {
  if (typeof data === 'string') return data
  let json: string | undefined
  try {
    json = JSON.stringify(data)
  } catch (error) {
    throw new TypeError(`Invalid SSE event: data cannot be serialised as JSON (${errorText(error)})`, { cause: error })
  }
  if (json === undefined) throw new TypeError(`Invalid SSE event: data cannot be serialised as JSON (${typeof data})`)
  return json
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'a string'
  if (Array.isArray(value)) return 'an array'
  if (value instanceof Uint8Array) return 'bytes'
  return typeof value === 'object' ? `an instance of ${value.constructor?.name ?? 'a class'}` : typeof value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// -------------------------------------------------------------------------------------------------
// The event stream
// -------------------------------------------------------------------------------------------------

/** Default reconnection delay the jitter of the final `retry` starts from (ms). */
export const DEFAULT_RECONNECT_MS = 3_000
/** How long a stopped source may take before the request scope closes anyway (ms). */
export const SOURCE_STOP_TIMEOUT_MS = 5_000

const ENCODER = new TextEncoder()
const HEARTBEAT = ENCODER.encode(':\n\n')

/** Settings of one event stream (route options resolved over the plugin options). */
export interface SseStreamSettings {
  /** Heartbeat interval in ms; `0` disables it. */
  readonly heartbeat: number
  /** `retry` sent first, if any. */
  readonly retry: number | undefined
  /** `maxDuration` in ms, if any. */
  readonly maxDuration: number | undefined
  /** Time the source gets to finish after a graceful close started (ms). */
  readonly graceMs: number
  /** Bound of the source stop (ms). Default: {@link SOURCE_STOP_TIMEOUT_MS}. */
  readonly stopTimeoutMs?: number
  /** Random generator of the jitter (`[0, 1)`). Default: `Math.random`. */
  readonly random?: () => number
}

/** What the stream reports to the request (its context and its logger). */
export interface SseHost {
  /** Aborts `ctx.signal` with `kind`. */
  abort(kind: RequestAbortKind): void
  /** Logs a failure (`The SSE stream failed`) or a warning, with the request id and path. */
  error(message: string, error: unknown): void
  warn(message: string): void
}

/** A source being read: one pull at a time. */
interface SourceReader {
  next(): Promise<IteratorResult<unknown>>
  stop(): Promise<unknown>
}

type Settled =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: unknown }

/**
 * One event stream: the byte stream sent to the client and the controls of the pipeline
 * ({@link close} on shutdown or `maxDuration`). The source is read only when the client pulls
 * (backpressure); the first chunk (`retry: N` or the comment `:`) is queued at once so that every
 * adapter flushes the headers.
 */
export class SseSession {
  /** The bytes to send (pull-based, `highWaterMark: 0`). */
  readonly stream: ReadableStream<Uint8Array>
  readonly #source: SseSource
  readonly #settings: SseStreamSettings
  readonly #host: SseHost
  readonly #run: ContextRunner
  #reader: SourceReader | undefined
  /** The source read in progress, kept across heartbeats until its item is consumed. */
  #pending: Promise<Settled> | undefined
  /** What {@link #pending} settled with, until {@link #pull} consumes it. */
  #settled: Settled | undefined
  /** Resolves the race waiting for {@link #pending} (one at a time). */
  #onSettled: (() => void) | undefined
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined
  /** `open` → `closing` (graceful close running) → `ended`. */
  #phase: 'open' | 'closing' | 'ended' = 'open'
  /** The raw bytes written so far end at an event boundary (a heartbeat may follow). */
  #atBoundary = true
  /** Raw byte scanner: the current line has content / the previous byte was a CR. */
  #lineHasContent = false
  #afterCr = false
  /** Whether the line the last CR ended was empty (an event boundary, whether a LF follows or not). */
  #crBoundary = false
  #wake: (() => void) | undefined
  #graceTimer: ReturnType<typeof setTimeout> | undefined
  #maxTimer: ReturnType<typeof setTimeout> | undefined
  #stopped: Promise<void> | undefined
  #ended: () => void = () => undefined
  /** Resolves once the stream ended (source done, failed, stopped or cancelled). */
  readonly ended: Promise<void>

  constructor(source: SseSource, settings: SseStreamSettings, host: SseHost) {
    this.#source = source
    this.#settings = settings
    this.#host = host
    // the source runs in the handler's async context (request scope, tracing), timers included
    this.#run = captureContext()
    this.ended = new Promise(resolve => {
      this.#ended = resolve
    })
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: controller => {
          this.#controller = controller
          const retry = settings.retry
          controller.enqueue(retry === undefined ? HEARTBEAT : ENCODER.encode(`retry: ${retry}\n\n`))
          if (settings.maxDuration !== undefined) {
            this.#maxTimer = unref(setTimeout(() => this.close('expired'), timerDelay(settings.maxDuration)))
          }
        },
        pull: controller => this.#pull(controller),
        cancel: () => this.#cancel(),
      },
      { highWaterMark: 0 },
    )
  }

  /** Whether the stream is closing or over. */
  get closed(): boolean {
    return this.#phase !== 'open'
  }

  /**
   * Starts the graceful close (shutdown, `maxDuration`): `ctx.signal` aborts with `kind`, the source
   * may yield its final events for `graceMs`, then a jittered `retry` is sent, the source is stopped
   * and the response ends. Idempotent.
   */
  close(kind: 'shutdown' | 'expired'): void {
    if (this.#phase !== 'open') return
    this.#phase = 'closing'
    clearTimeout(this.#maxTimer)
    this.#host.abort(kind)
    this.#graceTimer = unref(setTimeout(() => void this.#endGracefully(), timerDelay(this.#settings.graceMs)))
    this.#wake?.()
  }

  async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    for (;;) {
      if (this.#phase === 'ended') return
      this.#next()
      const heartbeat =
        this.#phase === 'open' && this.#settings.heartbeat > 0 && this.#atBoundary ? this.#settings.heartbeat : 0
      const outcome = await this.#race(heartbeat)
      // closed or cancelled while waiting
      if (this.#isEnded()) return
      if (outcome === 'heartbeat') {
        controller.enqueue(HEARTBEAT)
        return
      }
      if (outcome === 'wake') continue
      this.#pending = undefined
      this.#settled = undefined
      if (outcome.kind === 'done') {
        await this.#finish()
        return
      }
      if (outcome.kind === 'error') {
        if (!this.#isAbortError(outcome.error)) this.#host.error('The SSE stream failed', outcome.error)
        await this.#finish()
        return
      }
      const value = outcome.value
      if (value instanceof Uint8Array) {
        if (value.byteLength === 0) continue
        this.#scan(value)
        controller.enqueue(value)
        return
      }
      let encoded: string
      try {
        if (!this.#endsAtBoundary()) {
          // an event written after an unterminated raw event would merge into it
          throw new TypeError(
            'Invalid SSE event: an SseEvent cannot follow raw bytes that do not end at an event boundary (an empty line)',
          )
        }
        encoded = encodeSseEvent(value as SseEvent)
      } catch (error) {
        this.#host.error('The SSE stream failed', error)
        await this.#finish(true)
        return
      }
      controller.enqueue(ENCODER.encode(encoded))
      this.#atBoundary = true
      this.#lineHasContent = false
      this.#afterCr = false
      return
    }
  }

  /**
   * Starts the next read of the source, unless one is pending (it is kept across heartbeats). The
   * read gets one reaction for its whole life, which records its outcome: a quiet source does not
   * accumulate a reaction per heartbeat.
   */
  #next(): void {
    if (this.#pending !== undefined) return
    const pending = this.#run(() => {
      try {
        return this.#readerOf().next()
      } catch (error) {
        return Promise.reject(error)
      }
    }).then(
      (result): Settled => (result.done === true ? { kind: 'done' } : { kind: 'value', value: result.value }),
      (error: unknown): Settled => ({ kind: 'error', error }),
    )
    this.#pending = pending
    void pending.then(outcome => {
      if (this.#pending !== pending) return
      this.#settled = outcome
      this.#onSettled?.()
    })
  }

  /** Waits for the pending item, a heartbeat delay (`0`: none) or a wake-up (close, cancel). */
  #race(heartbeat: number): Promise<Settled | 'heartbeat' | 'wake'> {
    // settled while nobody waited (after a heartbeat or a wake-up): kept until consumed
    if (this.#settled !== undefined) return Promise.resolve(this.#settled)
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let done = false
      const settle = (outcome: Settled | 'heartbeat' | 'wake'): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (this.#wake === wake) this.#wake = undefined
        if (this.#onSettled === settled) this.#onSettled = undefined
        resolve(outcome)
      }
      const wake = (): void => settle('wake')
      const settled = (): void => settle(this.#settled as Settled)
      if (heartbeat > 0) timer = unref(setTimeout(() => settle('heartbeat'), timerDelay(heartbeat)))
      this.#wake = wake
      this.#onSettled = settled
    })
  }

  /** Tracks whether the raw bytes written so far end at an event boundary (an empty line). */
  #scan(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (byte === 0x0a && this.#afterCr) {
        // the LF of a CRLF (possibly the first byte of a chunk): the CR decided the boundary
        this.#afterCr = false
        this.#atBoundary = this.#crBoundary
        continue
      }
      this.#afterCr = byte === 0x0d
      if (byte === 0x0a || byte === 0x0d) {
        this.#atBoundary = !this.#lineHasContent
        this.#lineHasContent = false
        if (this.#afterCr) this.#crBoundary = this.#atBoundary
      } else {
        this.#lineHasContent = true
        this.#atBoundary = false
      }
    }
    // a final CR may be the first half of a CRLF: no heartbeat until the next byte tells
    if (this.#afterCr) this.#atBoundary = false
  }

  /**
   * Whether the bytes written so far end at an event boundary, for bytes written once the source
   * is over (the final `retry`) or replaced (an encoded event): a final CR ending an empty line
   * counts, since no raw byte will follow it.
   */
  #endsAtBoundary(): boolean {
    return this.#atBoundary || (this.#afterCr && this.#crBoundary)
  }

  /**
   * Ends the stream after the source: done, failed, or an invalid item (`stop`: the source is
   * stopped). During a graceful close the jittered `retry` is written first.
   */
  async #finish(stop = false): Promise<void> {
    if (this.#phase === 'ended') return
    const graceful = this.#phase === 'closing'
    this.#phase = 'ended'
    this.#clearTimers()
    const controller = this.#controller as ReadableStreamDefaultController<Uint8Array>
    // never inside an unterminated raw event (the client discards it at the end of the stream)
    if (graceful && this.#endsAtBoundary()) controller.enqueue(this.#finalRetry())
    if (stop) await this.#stop()
    try {
      controller.close()
    } catch {
      // cancelled meanwhile
    }
    this.#ended()
  }

  /** The grace period is over: final `retry`, the source is stopped (bounded), the response ends. */
  async #endGracefully(): Promise<void> {
    if (this.#phase !== 'closing') return
    this.#phase = 'ended'
    this.#clearTimers()
    const controller = this.#controller as ReadableStreamDefaultController<Uint8Array>
    // never inside an unterminated raw event (the client discards it at the end of the stream)
    if (this.#endsAtBoundary()) controller.enqueue(this.#finalRetry())
    this.#wake?.()
    await this.#stop()
    try {
      controller.close()
    } catch {
      // cancelled meanwhile
    }
    this.#ended()
  }

  /** The client disconnected (or the body was discarded: HEAD, bodyless status, invalid headers). */
  async #cancel(): Promise<void> {
    const wasEnded = this.#phase === 'ended'
    this.#phase = 'ended'
    this.#clearTimers()
    this.#host.abort('client')
    this.#wake?.()
    if (!wasEnded || this.#stopped !== undefined) await this.#stop()
    this.#ended()
  }

  /** `retry: R` with R drawn uniformly in [r, 2r] (spreads the reconnections of a rolling deployment). */
  #finalRetry(): Uint8Array {
    const base = this.#settings.retry ?? DEFAULT_RECONNECT_MS
    const random = this.#settings.random ?? Math.random
    return ENCODER.encode(`retry: ${Math.round(base + random() * base)}\n\n`)
  }

  /**
   * Stops the source (`return()` / `cancel()`) and waits for it at most `stopTimeoutMs`: an async
   * generator blocked in an `await` that ignores `ctx.signal` would hold the request scope forever.
   */
  #stop(): Promise<void> {
    this.#stopped ??= this.#stopBounded()
    return this.#stopped
  }

  async #stopBounded(): Promise<void> {
    const timeoutMs = this.#settings.stopTimeoutMs ?? SOURCE_STOP_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopping = this.#run(() => {
      try {
        return this.#readerOf().stop()
      } catch {
        return Promise.resolve()
      }
    }).then(
      () => 'stopped' as const,
      () => 'stopped' as const,
    )
    const timeout = new Promise<'timeout'>(resolve => {
      timer = unref(setTimeout(() => resolve('timeout'), timeoutMs))
    })
    const outcome = await Promise.race([stopping, timeout])
    clearTimeout(timer)
    if (outcome === 'timeout') {
      this.#host.warn(
        `The SSE source did not stop within ${timeoutMs} ms after its signal was aborted: make it honour ctx.signal`,
      )
    }
  }

  #isEnded(): boolean {
    return this.#phase === 'ended'
  }

  #clearTimers(): void {
    clearTimeout(this.#graceTimer)
    clearTimeout(this.#maxTimer)
  }

  /** An error caused by the abort of `ctx.signal` (a source honouring it): not a failure. */
  #isAbortError(error: unknown): boolean {
    return this.#phase !== 'open' && (error as { name?: unknown } | null)?.name === 'AbortError'
  }

  /** The reader of the source, created on first use (a never-read async generator never runs). */
  #readerOf(): SourceReader {
    this.#reader ??= readerOf(this.#source)
    return this.#reader
  }
}

function readerOf(source: SseSource): SourceReader {
  if (source instanceof ReadableStream) {
    const reader = source.getReader() as unknown as {
      read(): Promise<IteratorResult<unknown>>
      cancel(reason?: unknown): Promise<void>
    }
    return {
      next: () => reader.read(),
      stop: () => reader.cancel(),
    }
  }
  const asyncFactory = (source as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[Symbol.asyncIterator]
  if (typeof asyncFactory === 'function') {
    const iterator = asyncFactory.call(source)
    return {
      next: () => iterator.next(),
      stop: async () => {
        await iterator.return?.()
      },
    }
  }
  const iterator = (source as Iterable<unknown>)[Symbol.iterator]()
  return {
    next: () => Promise.resolve(iterator.next()),
    stop: () => Promise.resolve(iterator.return?.()),
  }
}

/** A delay `setTimeout` keeps (larger ones overflow to 1 ms): the options are validated, this is a backstop. */
function timerDelay(ms: number): number {
  return Math.min(ms, MAX_SSE_TIMER_MS)
}

function unref<T>(timer: T): T {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}
