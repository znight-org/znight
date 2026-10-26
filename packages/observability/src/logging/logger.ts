import type { LogContext } from '@znight/core'
import type {
  DestinationStream,
  Logger as PinoLogger,
  LoggerOptions as PinoLoggerOptions,
  redactOptions as PinoRedactOptions,
} from 'pino'
import type { LogEntryLevel, LoggerLevel } from './levels.ts'
import type { PrettyOptions } from './pretty.ts'

import { isSpanContextValid, context as otelContext, trace } from '@opentelemetry/api'
import pino from 'pino'

import { REQUEST_ID_TOKEN } from '../tokens.ts'
import { parseLevel } from './levels.ts'
import { prettyTransport } from './pretty.ts'
import { consoleTransport, type LogTransport } from './transport.ts'

/** Something exposing the active request scope: the Znight `Container` (duck-typed). */
export interface ScopeSource {
  currentScope(): { get(key: string): unknown } | undefined
}

/** Redaction settings (pino `redact`). */
export interface RedactOptions {
  /** Paths to redact (`password`, `req.headers.authorization`, `users[*].token`...). */
  readonly paths: readonly string[]
  /** Replacement value, or a function of the value and its path. Default: `'[Redacted]'`. */
  readonly censor?: string | ((value: unknown, path: string[]) => unknown)
  /** Remove the keys instead of censoring their values. Default: `false`. */
  readonly remove?: boolean
}

/** Options of {@link Logger}. */
export interface LoggerOptions {
  /** Minimum level written. Default: the `LOG_LEVEL` environment variable, otherwise `info`. */
  readonly level?: LoggerLevel
  /** Logger name, written as the `name` field of every entry. */
  readonly name?: string
  /** Fields written in every entry. Default: `{ pid, hostname }`; `null` writes none. */
  readonly base?: Readonly<Record<string, unknown>> | null
  /** Paths whose values are censored (or removed) from every entry, e.g. `['password', '*.token']`. */
  readonly redact?: readonly string[] | RedactOptions
  /** Human-readable output through the optional `pino-pretty` peer (development only). Default: `false`. */
  readonly pretty?: boolean | PrettyOptions
  /** Where entries go. Default: {@link consoleTransport} (JSON lines on stdout). */
  readonly transport?: LogTransport | readonly LogTransport[]
  /** A raw destination stream (any object with `write(line)`), added to the transports. */
  readonly destination?: DestinationStream
  /** Timestamp format: `epoch` (milliseconds, pino's default), `iso` (ISO 8601 string) or `false` (none). */
  readonly timestamp?: 'epoch' | 'iso' | false
  /** Key of the message. Default: `msg` (`message` with the CloudWatch transport). */
  readonly messageKey?: string
  /** Serializers by key. `err` and `error` serialize `Error`s (type, message, stack, cause) by default. */
  readonly serializers?: Readonly<Record<string, (value: never) => unknown>>
  /** Fields computed for every entry (merged after the automatic context). */
  readonly mixin?: () => Readonly<Record<string, unknown>>
  /** Request scope provider (the container) used to add {@link scopeFields}. Set by `ObservabilityPlugin`. */
  readonly scope?: ScopeSource
  /**
   * Log fields read from the active request scope: field name → scope token. Values that are
   * `undefined` or `null` are skipped. Default: `{ requestId: '@znight/http#RequestId' }`.
   */
  readonly scopeFields?: Readonly<Record<string, string>>
  /** Add `traceId` and `spanId` of the active OpenTelemetry span. Default: `true`. */
  readonly traceContext?: boolean
  /** Raw pino options, applied last (escape hatch). */
  readonly pino?: Partial<PinoLoggerOptions>
}

/** Options of {@link Logger.child}. */
export interface ChildLoggerOptions {
  /** Level of the child (and of its own children). Default: the parent's. */
  readonly level?: LoggerLevel
  /** Prefix of every message of the child. */
  readonly msgPrefix?: string
}

/** What a logger and its children share. */
interface Shared {
  readonly transports: readonly LogTransport[]
  /**
   * Set once the logger is closed or its application disposed: buffering transports would keep
   * later entries until a timer the exiting process never waits for, so each one is flushed.
   */
  flushEachEntry: boolean
  /** A flush is queued for the entries of the current tick. */
  flushQueued: boolean
}

/** Internal: switches a logger (and its children) to flushing each entry. See {@link flushEachEntry}. */
let enableFlushEachEntry: (logger: Logger) => void

/** Second argument of the logging methods: structured context or an error. */
type LogDetails = LogContext | Error

type PinoMethod = (this: PinoLogger, ...args: unknown[]) => void

/**
 * Structured logger backed by [pino](https://getpino.io): newline-delimited JSON, very low overhead,
 * redaction, child loggers. Injectable in any provider (`constructor(private logger: Logger)`).
 *
 * Every entry is enriched with the active context: `requestId` (from the current request scope)
 * and `traceId` / `spanId` (from the active OpenTelemetry span).
 *
 * ```ts
 * logger.info('User created', { userId })
 * logger.error('Payment failed', error)
 * logger.warn({ orderId }, 'Order delayed') // pino argument order works too
 * const child = logger.child({ component: 'billing' })
 * ```
 */
export class Logger {
  /** Internal hand-off from {@link child} to the constructor. */
  static #pending: { readonly pino: PinoLogger; readonly shared: Shared } | undefined
  readonly #pino: PinoLogger
  readonly #shared: Shared

  static {
    enableFlushEachEntry = logger => {
      logger.#shared.flushEachEntry = true
    }
  }

  constructor(options: LoggerOptions = {}) {
    const pending = Logger.#pending
    if (pending !== undefined) {
      Logger.#pending = undefined
      this.#pino = pending.pino
      this.#shared = pending.shared
      return
    }
    const transports = transportsOf(options)
    this.#pino = pino(pinoOptions(options, transports), destinationOf(transports))
    this.#shared = { transports, flushEachEntry: false, flushQueued: false }
  }

  /** The underlying pino logger (escape hatch). */
  get pino(): PinoLogger {
    return this.#pino
  }

  /** Current minimum level. Can be changed at runtime. */
  get level(): LoggerLevel {
    return this.#pino.level as LoggerLevel
  }

  set level(level: LoggerLevel) {
    this.#pino.level = parseLevel(level, 'logger level')
  }

  /** Whether an entry of `level` would be written (skip building costly context otherwise). */
  isLevelEnabled(level: LogEntryLevel): boolean {
    return this.#pino.isLevelEnabled(level)
  }

  /** Fields bound to this logger (`child()` bindings). */
  bindings(): LogContext {
    return this.#pino.bindings()
  }

  /**
   * A logger writing `bindings` in every entry, sharing this logger's destination (children are
   * cheap: bindings are serialized once).
   */
  child(bindings: LogContext, options: ChildLoggerOptions = {}): Logger {
    const childOptions: { level?: string; msgPrefix?: string } = {}
    if (options.level !== undefined) childOptions.level = parseLevel(options.level, 'child logger level')
    if (options.msgPrefix !== undefined) childOptions.msgPrefix = options.msgPrefix
    Logger.#pending = { pino: this.#pino.child(bindings, childOptions), shared: this.#shared }
    try {
      return new Logger()
    } finally {
      Logger.#pending = undefined
    }
  }

  trace(message: string, details?: LogDetails): void
  trace(details: LogDetails, message?: string): void
  trace(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('trace', first, second)
  }

  debug(message: string, details?: LogDetails): void
  debug(details: LogDetails, message?: string): void
  debug(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('debug', first, second)
  }

  info(message: string, details?: LogDetails): void
  info(details: LogDetails, message?: string): void
  info(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('info', first, second)
  }

  warn(message: string, details?: LogDetails): void
  warn(details: LogDetails, message?: string): void
  warn(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('warn', first, second)
  }

  error(message: string, details?: LogDetails): void
  error(details: LogDetails, message?: string): void
  error(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('error', first, second)
  }

  fatal(message: string, details?: LogDetails): void
  fatal(details: LogDetails, message?: string): void
  fatal(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('fatal', first, second)
  }

  /** Logs at a level chosen at runtime. */
  log(level: LogEntryLevel, message: string, details?: LogDetails): void {
    this.#write(level, message, details)
  }

  /** Writes out what the transports buffered (Datadog batches, async stdout writes). Never rejects. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.#shared.transports.map(transport => transport.flush?.()))
  }

  /**
   * Flushes, then closes the transports (timers, sockets). Shared by every child. Never rejects.
   * The logger stays usable: entries written afterwards are flushed right away (no batching), so
   * they are delivered before the process exits.
   */
  async close(): Promise<void> {
    this.#shared.flushEachEntry = true
    await this.flush()
    await Promise.allSettled(this.#shared.transports.map(transport => transport.close?.()))
  }

  #write(level: LogEntryLevel, first: unknown, second: unknown): void {
    write(this.#pino, level, first, second)
    const shared = this.#shared
    if (!shared.flushEachEntry || shared.flushQueued || !this.#pino.isLevelEnabled(level)) return
    // one flush for the entries of this tick; it starts the transports' I/O (fetch...), which keeps
    // the process alive until they are delivered
    shared.flushQueued = true
    queueMicrotask(() => {
      shared.flushQueued = false
      void this.flush()
    })
  }
}

/**
 * Makes `logger` (and its children) flush each entry as soon as it is written, without closing its
 * transports. `ObservabilityPlugin` calls it when the application is disposed: the framework still
 * logs afterwards (`Application stopped`), and buffering transports (Datadog) would otherwise hold
 * those entries behind a timer that does not keep the process alive.
 */
export function flushEachEntry(logger: Logger): void {
  enableFlushEachEntry(logger)
}

function write(logger: PinoLogger, level: LogEntryLevel, first: unknown, second: unknown): void {
  const method = logger[level] as PinoMethod
  if (typeof first === 'string') {
    if (second === undefined || second === null) method.call(logger, first)
    else if (typeof second === 'object') method.call(logger, second, first)
    else method.call(logger, { details: second }, first)
  } else if (typeof first === 'object' && first !== null) {
    method.call(logger, first, typeof second === 'string' ? second : undefined)
  } else {
    method.call(logger, String(first))
  }
}

function transportsOf(options: LoggerOptions): LogTransport[] {
  const transports: LogTransport[] = []
  if (options.transport !== undefined) {
    if (isTransportList(options.transport)) transports.push(...options.transport)
    else transports.push(options.transport)
  }
  if (options.pretty !== undefined && options.pretty !== false) {
    transports.push(prettyTransport(options.pretty === true ? {} : options.pretty))
  }
  if (options.destination !== undefined) transports.push(destinationTransport(options.destination))
  if (transports.length === 0) transports.push(consoleTransport())
  return transports
}

function isTransportList(value: LogTransport | readonly LogTransport[]): value is readonly LogTransport[] {
  return Array.isArray(value)
}

function destinationTransport(stream: DestinationStream): LogTransport {
  const flushable = stream as DestinationStream & { flush?: (callback: (error?: unknown) => void) => void }
  return {
    name: 'destination',
    stream,
    flush: () =>
      new Promise<void>(resolve => {
        if (typeof flushable.flush !== 'function') return resolve()
        try {
          flushable.flush(() => resolve())
        } catch {
          resolve()
        }
      }),
  }
}

function destinationOf(transports: readonly LogTransport[]): DestinationStream {
  const [single] = transports
  if (transports.length === 1 && single !== undefined && single.level === undefined) return single.stream
  return pino.multistream(
    transports.map(transport => ({ stream: transport.stream, level: transport.level ?? 'trace' })) as never,
  )
}

const DEFAULT_SCOPE_FIELDS: Readonly<Record<string, string>> = Object.freeze({ requestId: REQUEST_ID_TOKEN })

function pinoOptions(options: LoggerOptions, transports: readonly LogTransport[]): PinoLoggerOptions {
  const result: PinoLoggerOptions = {}
  for (const transport of transports) Object.assign(result, transport.loggerOptions)
  const envLevel = globalThis.process?.env?.['LOG_LEVEL']
  result.level =
    options.level !== undefined || envLevel === undefined || envLevel === ''
      ? parseLevel(options.level ?? 'info', 'level')
      : parseLevel(envLevel, 'LOG_LEVEL environment variable')
  if (options.name !== undefined) result.name = options.name
  if (options.base !== undefined) result.base = options.base === null ? null : { ...options.base }
  if (options.messageKey !== undefined) result.messageKey = options.messageKey
  if (options.timestamp !== undefined) result.timestamp = timestampOf(options.timestamp)
  if (options.redact !== undefined) result.redact = redactOf(options.redact)
  result.serializers = {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    ...result.serializers,
    ...(options.serializers as PinoLoggerOptions['serializers']),
  }
  const mixin = mixinOf(options)
  if (mixin !== undefined) result.mixin = mixin
  return { ...result, ...options.pino }
}

function timestampOf(timestamp: 'epoch' | 'iso' | false): PinoLoggerOptions['timestamp'] {
  if (timestamp === false) return false
  return timestamp === 'iso' ? pino.stdTimeFunctions.isoTime : pino.stdTimeFunctions.epochTime
}

function redactOf(redact: readonly string[] | RedactOptions): string[] | PinoRedactOptions {
  if (Array.isArray(redact)) return [...(redact as readonly string[])]
  const options = redact as RedactOptions
  const result: PinoRedactOptions = { paths: [...options.paths] }
  if (options.censor !== undefined) result.censor = options.censor as PinoRedactOptions['censor']
  if (options.remove !== undefined) result.remove = options.remove
  return result
}

/** The automatic context: scope fields, active trace context and the user's mixin. */
function mixinOf(options: LoggerOptions): (() => Record<string, unknown>) | undefined {
  const scope = options.scope
  const fields = scope === undefined ? [] : Object.entries(options.scopeFields ?? DEFAULT_SCOPE_FIELDS)
  const traceContext = options.traceContext ?? true
  const user = options.mixin
  if (fields.length === 0 && !traceContext && user === undefined) return undefined
  return () => {
    // pino's merge strategy mutates the returned object: always a fresh one
    const context: Record<string, unknown> = {}
    if (fields.length > 0) {
      const current = scope?.currentScope()
      if (current !== undefined) {
        for (const [field, token] of fields) {
          const value = current.get(token)
          if (value !== undefined && value !== null) context[field] = value
        }
      }
    }
    if (traceContext) {
      const spanContext = trace.getSpanContext(otelContext.active())
      if (spanContext !== undefined && isSpanContextValid(spanContext)) {
        context['traceId'] = spanContext.traceId
        context['spanId'] = spanContext.spanId
      }
    }
    if (user !== undefined) Object.assign(context, user())
    return context
  }
}
