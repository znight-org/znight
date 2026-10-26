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
   * Synchronous writes. Default `false`: writes are non-blocking (pino's default), buffered entries
   * are flushed by `logger.flush()` and on process exit.
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
  return withLevel(
    {
      name: 'console',
      stream,
      flush: () => {
        flushSonicBoom(stream)
        return Promise.resolve()
      },
    },
    options.level,
  )
}

/** Synchronously writes what a SonicBoom destination buffered (no-op when nothing is pending). */
export function flushSonicBoom(stream: { flushSync?: () => void }): void {
  try {
    stream.flushSync?.()
  } catch {
    // not opened yet, already closed or an fsync unsupported by the descriptor (pipes, TTYs)
  }
}

/** Adds an optional `level` to a transport (keeps `exactOptionalPropertyTypes` happy). */
export function withLevel(transport: LogTransport, level: LoggerLevel | undefined): LogTransport {
  return level === undefined ? transport : { ...transport, level }
}
