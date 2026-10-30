import type { DestinationStream, LoggerOptions as PinoLoggerOptions } from 'pino'
import type { LoggerLevel } from './levels.ts'

import pino from 'pino'

/**
 * Where log entries go. A transport is a pino destination stream (receives one serialized JSON
 * line per entry) plus the pino options its output format needs. Combine several with
 * `LoggerOptions.transport: [a, b]`.
 */
export interface LogTransport {
  /** Name used in messages (`console`, `datadog`...). */
  readonly name: string
  /** Destination receiving one JSON line per entry. */
  readonly stream: DestinationStream
  /** Minimum level written to this transport (only raises the logger level). Default: every entry. */
  readonly level?: LoggerLevel
  /**
   * Pino options the output format requires (message key, timestamp, level formatter...). Merged
   * under the logger's own options: explicit `LoggerOptions` win.
   */
  readonly loggerOptions?: Partial<PinoLoggerOptions>
  /** Writes buffered entries out. */
  flush?(): Promise<void>
  /** Flushes and releases resources (timers, sockets). The transport may still accept entries afterwards. */
  close?(): Promise<void>
}

/** Options of {@link consoleTransport}. */
export interface ConsoleTransportOptions {
  /** File descriptor: `1` (stdout, default) or `2` (stderr). */
  readonly fd?: 1 | 2
  /**
   * Synchronous writes. Default `false`: writes are non-blocking (pino's default), in order; the
   * process waits for the pending ones before exiting, and `logger.flush()` resolves once they are
   * written.
   */
  readonly sync?: boolean
  /** Minimum level written to this transport. */
  readonly level?: LoggerLevel
}

/**
 * Newline-delimited JSON on stdout (the default transport): the format expected by log shippers,
 * Kubernetes, Docker and most cloud log collectors.
 */
export function consoleTransport(options: ConsoleTransportOptions = {}): LogTransport {
  const stream = pino.destination({ dest: options.fd ?? 1, sync: options.sync ?? false, minLength: 0 })
  return withLevel({ name: 'console', stream, flush: () => drainSonicBoom(stream) }, options.level)
}

/** How often {@link drainSonicBoom} checks whether a destination stopped without an event. */
const STALLED_WRITE_CHECK_MS = 50

/** The parts of a SonicBoom destination (`pino.destination()`) read by {@link drainSonicBoom}. */
interface SonicBoomLike {
  readonly destroyed?: boolean
  /** Internal to SonicBoom: an asynchronous write is in flight (or the file is being opened). */
  readonly _writing?: boolean
  /** Internal to SonicBoom: bytes not written yet (the chunk in flight included). */
  readonly _len?: number
  on(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
}

/**
 * Resolves once a SonicBoom destination has written the entries it holds when called; immediately
 * when nothing is in flight (synchronous destinations, or anything else). Never rejects.
 *
 * It waits for SonicBoom's own asynchronous writes and never calls `flushSync()`: while a chunk is
 * being written asynchronously, `flushSync()` writes the queued entries synchronously AHEAD of it,
 * so on a slow output (pipe, CI runner, log collector) later entries overtook earlier ones, e.g. the
 * final `Application stopped` printed before the last lines of the providers' shutdown hooks.
 * Pending writes keep the process alive until they complete, so nothing is lost at exit either.
 */
export function drainSonicBoom(stream: unknown): Promise<void> {
  if (!isWritingSonicBoom(stream)) return Promise.resolve()
  const waiter = waiters.get(stream) ?? watchWrites(stream)
  // the bytes to write before the entries held now are out (later entries are not waited for)
  const pending = typeof stream._len === 'number' && stream._len > 0 ? stream._len : Number.POSITIVE_INFINITY
  return new Promise<void>(resolve => {
    waiter.flushes.push({ until: waiter.written + pending, resolve })
  })
}

/** The flushes waiting for the writes of one destination: a single set of listeners for all of them. */
interface WriteWaiter {
  /** Bytes written since the waiter was created. */
  written: number
  flushes: { readonly until: number; readonly resolve: () => void }[]
}

const waiters = new WeakMap<SonicBoomLike, WriteWaiter>()

function watchWrites(sonic: SonicBoomLike): WriteWaiter {
  const waiter: WriteWaiter = { written: 0, flushes: [] }
  const settle = (all: boolean): void => {
    const done = waiter.flushes.filter(flush => all || flush.until <= waiter.written)
    waiter.flushes = waiter.flushes.filter(flush => !done.includes(flush))
    if (waiter.flushes.length === 0) stop()
    for (const flush of done) flush.resolve()
  }
  const listeners: Record<string, (...args: never[]) => void> = {
    write: (written: number) => {
      waiter.written += written
      settle(false)
    },
    drain: () => settle(true),
    close: () => settle(true),
  }
  // no 'error' listener (it would swallow errors pino does not handle): a failed write stops the
  // destination without any further event, and so does a file opened with nothing to write
  const stalled = setInterval(() => {
    if (!isWritingSonicBoom(sonic)) settle(true)
  }, STALLED_WRITE_CHECK_MS)
  stalled.unref?.()
  function stop(): void {
    clearInterval(stalled)
    for (const [event, listener] of Object.entries(listeners)) sonic.removeListener(event, listener)
    waiters.delete(sonic)
  }
  for (const [event, listener] of Object.entries(listeners)) sonic.on(event, listener)
  waiters.set(sonic, waiter)
  return waiter
}

/** Whether `stream` is a SonicBoom destination with an asynchronous write in flight. */
function isWritingSonicBoom(stream: unknown): stream is SonicBoomLike {
  if (typeof stream !== 'object' || stream === null) return false
  const sonic = stream as Partial<SonicBoomLike>
  return (
    sonic._writing === true &&
    sonic.destroyed !== true &&
    typeof sonic.on === 'function' &&
    typeof sonic.removeListener === 'function'
  )
}

/** Adds an optional `level` to a transport (keeps `exactOptionalPropertyTypes` happy). */
export function withLevel(transport: LogTransport, level: LoggerLevel | undefined): LogTransport {
  return level === undefined ? transport : { ...transport, level }
}
