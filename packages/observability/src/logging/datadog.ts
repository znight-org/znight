import type { LoggerLevel } from './levels.ts'
import type { LogTransport } from './transport.ts'

import { hostname as osHostname } from 'node:os'
import { promisify } from 'node:util'
import { gzip as gzipCallback } from 'node:zlib'
import { ErrorCode, ZnightError } from '@znight/core'

import { errorMessage, invalidOption } from '../internal/errors.ts'
import { levelLabel } from './levels.ts'

const gzip = promisify(gzipCallback)

/** Datadog limits: 1000 entries and 5 MB (uncompressed) per request, 1 MB per entry. */
const MAX_BATCH_ENTRIES = 1000
const MAX_PAYLOAD_BYTES = 5_000_000
const MAX_ENTRY_BYTES = 1_000_000
const TRUNCATED_MESSAGE_CHARS = 64 * 1024
const MAX_RETRY_AFTER_MS = 30_000

/** Options of {@link datadogTransport}. */
export interface DatadogTransportOptions {
  /** Datadog API key. Default: `DD_API_KEY`. Required. */
  readonly apiKey?: string
  /** Datadog site (`datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`...). Default: `DD_SITE` or `datadoghq.com`. */
  readonly site?: string
  /** Full intake URL, overrides `site` (proxies, tests). Default: `https://http-intake.logs.<site>/api/v2/logs`. */
  readonly url?: string
  /** `service` of every entry (unless the entry has one). Default: `DD_SERVICE`. */
  readonly service?: string
  /** `ddsource`. Default: `nodejs`. */
  readonly source?: string
  /** `hostname` of entries without one. Default: the OS host name. */
  readonly hostname?: string
  /** `ddtags`, as `key:value` strings or a record. `env:<DD_ENV>` and `version:<DD_VERSION>` are added when set. */
  readonly tags?: readonly string[] | Readonly<Record<string, string>>
  /** Maximum entries per request (1 to 1000). Default: 100. */
  readonly batchSize?: number
  /** Maximum uncompressed bytes per request. Default: 4 MB (Datadog accepts 5 MB). */
  readonly maxBatchBytes?: number
  /** Delay before buffered entries are sent. Default: 2000 ms. */
  readonly flushIntervalMs?: number
  /** Maximum buffered entries; the oldest are dropped beyond it (reported to `onError`). Default: 10 000. */
  readonly maxBufferSize?: number
  /** Retries of a failed request (network errors, 408, 429, 5xx) with exponential backoff. Default: 3. */
  readonly maxRetries?: number
  /** Base backoff delay. Default: 500 ms (then 1 s, 2 s...; `Retry-After` is honoured). */
  readonly retryDelayMs?: number
  /** Timeout of each request. Default: 10 000 ms. */
  readonly timeoutMs?: number
  /** Gzip request bodies. Default: `true`. */
  readonly compress?: boolean
  /** Add `dd.trace_id` / `dd.span_id` (decimal, Datadog format) from OpenTelemetry `traceId` / `spanId`. Default: `true`. */
  readonly traceCorrelation?: boolean
  /** Minimum level sent to Datadog. */
  readonly level?: LoggerLevel
  /** `fetch` implementation. Default: the global `fetch`. */
  readonly fetch?: typeof fetch
  /**
   * Receives delivery failures (`dropped` = entries lost). Default: one line on stderr. Never log
   * through the same logger here (it would loop).
   */
  readonly onError?: (error: Error, dropped: number) => void
}

/** The transport returned by {@link datadogTransport}. */
export interface DatadogTransport extends LogTransport {
  /** Sends every buffered entry and waits for in-flight requests (retries included). */
  flush(): Promise<void>
  /** Flushes and stops the timer. Entries written afterwards are still buffered and sent. */
  close(): Promise<void>
  /** Entries waiting to be sent. */
  readonly pending: number
  /** Entries dropped so far (buffer overflow or delivery failure). */
  readonly dropped: number
}

interface Settings {
  readonly url: string
  readonly apiKey: string
  readonly service: string | undefined
  readonly source: string
  readonly hostname: string
  readonly tags: string | undefined
  readonly batchSize: number
  readonly maxBatchBytes: number
  readonly flushIntervalMs: number
  readonly maxBufferSize: number
  readonly maxRetries: number
  readonly retryDelayMs: number
  readonly timeoutMs: number
  readonly compress: boolean
  readonly traceCorrelation: boolean
  readonly fetch: typeof fetch
  readonly onError: (error: Error, dropped: number) => void
}

interface Buffered {
  readonly json: string
  readonly bytes: number
}

/**
 * Sends log entries to the Datadog HTTP logs intake (`/api/v2/logs`) with `fetch`: batched (count,
 * bytes and time), gzip-compressed, retried with exponential backoff on network errors, 408, 429
 * and 5xx, bounded in memory. Entries are mapped to Datadog's reserved attributes (`message`,
 * `status`, `timestamp`, `service`, `hostname`, `ddsource`, `ddtags`, `error.*`) and correlated with
 * traces (`dd.trace_id` / `dd.span_id`).
 *
 * Call `flush()` / `close()` before the process exits: `ObservabilityPlugin` flushes the logger in
 * `onDispose`.
 *
 * @throws ZnightError (ZNIGHT006) when no API key is configured.
 */
export function datadogTransport(options: DatadogTransportOptions = {}): DatadogTransport {
  const sender = new DatadogSender(settingsOf(options))
  return {
    name: 'datadog',
    ...(options.level === undefined ? {} : { level: options.level }),
    stream: { write: (line: string) => sender.write(line) },
    flush: () => sender.flush(),
    close: () => sender.close(),
    get pending() {
      return sender.pending
    },
    get dropped() {
      return sender.dropped
    },
  }
}

class DatadogSender {
  readonly #settings: Settings
  #buffer: Buffered[] = []
  #bufferBytes = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #sending: Promise<void> | undefined
  #dropped = 0

  constructor(settings: Settings) {
    this.#settings = settings
  }

  get pending(): number {
    return this.#buffer.length
  }

  get dropped(): number {
    return this.#dropped
  }

  write(line: string): void {
    const entry = this.#entryOf(line)
    let json = JSON.stringify(entry)
    let bytes = Buffer.byteLength(json)
    if (bytes > MAX_ENTRY_BYTES) {
      json = JSON.stringify(truncated(entry))
      bytes = Buffer.byteLength(json)
    }
    this.#buffer.push({ json, bytes })
    this.#bufferBytes += bytes
    if (this.#buffer.length > this.#settings.maxBufferSize) {
      const removed = this.#buffer.shift() as Buffered
      this.#bufferBytes -= removed.bytes
      this.#drop(new Error('Datadog log transport: buffer full, dropping the oldest entry'), 1)
    }
    if (this.#buffer.length >= this.#settings.batchSize || this.#bufferBytes >= this.#settings.maxBatchBytes) {
      this.#sendSoon()
    } else {
      this.#arm()
    }
  }

  async flush(): Promise<void> {
    this.#disarm()
    while (this.#sending !== undefined || this.#buffer.length > 0) await this.#startDrain()
  }

  close(): Promise<void> {
    return this.flush()
  }

  #arm(): void {
    if (this.#timer !== undefined || this.#sending !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#sendSoon()
    }, this.#settings.flushIntervalMs)
    this.#timer.unref?.()
  }

  #disarm(): void {
    if (this.#timer === undefined) return
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #sendSoon(): void {
    this.#disarm()
    void this.#startDrain()
  }

  /** The running drain, started when there is none. */
  #startDrain(): Promise<void> {
    if (this.#sending === undefined) {
      const sending: Promise<void> = this.#drain().finally(() => {
        if (this.#sending === sending) this.#sending = undefined
      })
      this.#sending = sending
    }
    return this.#sending
  }

  /** Sends batches until the buffer is empty. Never rejects: failures go to `onError`. */
  async #drain(): Promise<void> {
    while (this.#buffer.length > 0) {
      const batch = this.#takeBatch()
      try {
        await this.#send(batch)
      } catch (error) {
        this.#drop(error instanceof Error ? error : new Error(errorMessage(error)), batch.length)
      }
    }
  }

  #takeBatch(): Buffered[] {
    const { batchSize, maxBatchBytes } = this.#settings
    let count = 0
    let bytes = 2
    for (const entry of this.#buffer) {
      if (count === batchSize || (count > 0 && bytes + entry.bytes + 1 > maxBatchBytes)) break
      bytes += entry.bytes + 1
      count++
    }
    const batch = this.#buffer.slice(0, count)
    this.#buffer = this.#buffer.slice(count)
    for (const entry of batch) this.#bufferBytes -= entry.bytes
    return batch
  }

  async #send(batch: readonly Buffered[]): Promise<void> {
    const settings = this.#settings
    const json = `[${batch.map(entry => entry.json).join(',')}]`
    const body: Uint8Array | string = settings.compress ? new Uint8Array(await gzip(json)) : json
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'dd-api-key': settings.apiKey,
    }
    if (settings.compress) headers['content-encoding'] = 'gzip'
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined
      let failure: unknown
      try {
        response = await settings.fetch(settings.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(settings.timeoutMs),
        })
        await response.body?.cancel().catch(() => undefined)
      } catch (error) {
        failure = error
      }
      if (response?.ok === true) return
      let delay = backoff(settings.retryDelayMs, attempt)
      if (response === undefined) {
        if (attempt >= settings.maxRetries) {
          throw new Error(`Datadog log intake unreachable: ${errorMessage(failure)}`, { cause: failure })
        }
      } else {
        if (!isRetryableStatus(response.status) || attempt >= settings.maxRetries) {
          throw new Error(`Datadog log intake responded ${response.status} ${response.statusText}`.trim())
        }
        delay = retryAfterMs(response.headers.get('retry-after')) ?? delay
      }
      await sleep(delay)
    }
  }

  #drop(error: Error, count: number): void {
    this.#dropped += count
    try {
      this.#settings.onError(error, count)
    } catch {
      // a failing error handler must not break logging
    }
  }

  #entryOf(line: string): Record<string, unknown> {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      record =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { message: String(parsed) }
    } catch {
      record = { message: line.trimEnd() }
    }
    return toDatadogEntry(record, this.#settings)
  }
}

const DATADOG_STATUS: Readonly<Record<string, string>> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'critical',
}

/** Maps a pino record (default or CloudWatch-shaped) to Datadog reserved attributes. */
export function toDatadogEntry(
  record: Readonly<Record<string, unknown>>,
  settings: Pick<Settings, 'service' | 'source' | 'hostname' | 'tags' | 'traceCorrelation'>,
): Record<string, unknown> {
  const { msg, message, level, time, timestamp, err, ...rest } = record
  const entry: Record<string, unknown> = rest
  entry.message = firstString(message, msg) ?? ''
  const label = levelLabel(level)
  entry.status = label === undefined ? 'info' : DATADOG_STATUS[label]
  if (label !== undefined) entry.level = label
  const date = timestamp ?? time
  if (date !== undefined) entry.timestamp = date
  entry.ddsource = settings.source
  if (typeof entry.hostname !== 'string') entry.hostname = settings.hostname
  if (typeof entry.service !== 'string' && settings.service !== undefined) entry.service = settings.service
  if (settings.tags !== undefined) entry.ddtags = settings.tags
  if (err !== undefined) {
    if (entry.error === undefined && typeof err === 'object' && err !== null) {
      const { type, message: errorText, stack, ...details } = err as Record<string, unknown>
      entry.error = { kind: type, message: errorText, stack, ...details }
    } else {
      entry.err = err
    }
  }
  if (settings.traceCorrelation) {
    const traceId = entry.traceId
    const spanId = entry.spanId
    if (
      typeof traceId === 'string' &&
      /^[\da-f]{32}$/i.test(traceId) &&
      typeof spanId === 'string' &&
      /^[\da-f]{16}$/i.test(spanId)
    ) {
      const dd = typeof entry.dd === 'object' && entry.dd !== null ? (entry.dd as Record<string, unknown>) : {}
      entry.dd = {
        ...dd,
        trace_id: BigInt(`0x${traceId.slice(16)}`).toString(10),
        span_id: BigInt(`0x${spanId}`).toString(10),
      }
    }
  }
  return entry
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string') return value
  return undefined
}

function truncated(entry: Record<string, unknown>): Record<string, unknown> {
  const message = typeof entry.message === 'string' ? entry.message : ''
  const kept: Record<string, unknown> = { truncated: true }
  for (const key of [
    'status',
    'level',
    'timestamp',
    'ddsource',
    'ddtags',
    'hostname',
    'service',
    'traceId',
    'spanId',
    'dd',
  ]) {
    if (entry[key] !== undefined) kept[key] = entry[key]
  }
  kept.message = message.length > TRUNCATED_MESSAGE_CHARS ? `${message.slice(0, TRUNCATED_MESSAGE_CHARS)}…` : message
  return kept
}

function settingsOf(options: DatadogTransportOptions): Settings {
  const env = globalThis.process?.env ?? {}
  const apiKey = options.apiKey ?? env.DD_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new ZnightError(ErrorCode.MissingConfig, 'Datadog log transport: no API key', {
      hints: ['Set the DD_API_KEY environment variable or pass datadogTransport({ apiKey })'],
    })
  }
  const site = options.site ?? env.DD_SITE ?? 'datadoghq.com'
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function')
    throw invalidOption('datadogTransport fetch', 'no fetch implementation available')
  return {
    url: options.url ?? `https://http-intake.logs.${site}/api/v2/logs`,
    apiKey,
    service: options.service ?? env.DD_SERVICE,
    source: options.source ?? 'nodejs',
    hostname: options.hostname ?? safeHostname(),
    tags: tagsOf(options.tags, env),
    batchSize: integer(options.batchSize, 100, 1, MAX_BATCH_ENTRIES, 'datadogTransport batchSize'),
    maxBatchBytes: integer(options.maxBatchBytes, 4_000_000, 1024, MAX_PAYLOAD_BYTES, 'datadogTransport maxBatchBytes'),
    flushIntervalMs: integer(
      options.flushIntervalMs,
      2000,
      0,
      Number.MAX_SAFE_INTEGER,
      'datadogTransport flushIntervalMs',
    ),
    maxBufferSize: integer(options.maxBufferSize, 10_000, 1, Number.MAX_SAFE_INTEGER, 'datadogTransport maxBufferSize'),
    maxRetries: integer(options.maxRetries, 3, 0, 100, 'datadogTransport maxRetries'),
    retryDelayMs: integer(options.retryDelayMs, 500, 0, Number.MAX_SAFE_INTEGER, 'datadogTransport retryDelayMs'),
    timeoutMs: integer(options.timeoutMs, 10_000, 1, Number.MAX_SAFE_INTEGER, 'datadogTransport timeoutMs'),
    compress: options.compress ?? true,
    traceCorrelation: options.traceCorrelation ?? true,
    fetch: fetchImpl,
    onError: options.onError ?? defaultOnError,
  }
}

function tagsOf(
  tags: readonly string[] | Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const list: string[] = []
  if (Array.isArray(tags)) list.push(...(tags as readonly string[]))
  else if (tags !== undefined) for (const [key, value] of Object.entries(tags)) list.push(`${key}:${value}`)
  const has = (key: string): boolean => list.some(tag => tag.startsWith(`${key}:`))
  if (env.DD_ENV && !has('env')) list.push(`env:${env.DD_ENV}`)
  if (env.DD_VERSION && !has('version')) list.push(`version:${env.DD_VERSION}`)
  return list.length === 0 ? undefined : list.join(',')
}

function integer(value: number | undefined, fallback: number, min: number, max: number, option: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidOption(option, `expected an integer between ${min} and ${max}, got ${value}`)
  }
  return value
}

function safeHostname(): string {
  try {
    return osHostname()
  } catch {
    return 'unknown'
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function backoff(base: number, attempt: number): number {
  const exponential = base * 2 ** attempt
  return Math.round(exponential / 2 + Math.random() * (exponential / 2))
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function defaultOnError(error: Error, dropped: number): void {
  globalThis.process?.stderr?.write(
    `[znight] ${error.message} (${dropped} log entr${dropped === 1 ? 'y' : 'ies'} dropped)\n`,
  )
}
