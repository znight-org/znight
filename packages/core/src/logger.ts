/** Structured context attached to a log entry. */
export type LogContext = Readonly<Record<string, unknown>>

/**
 * Minimal logger used by the core runtime and by plugins. `@znight/observability` replaces the
 * default console implementation with a structured (pino) logger through `app.setLogger()`.
 */
export interface CoreLogger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}

/** Log levels, from the most to the least verbose. `silent` disables every entry. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

/** The subset of `console` used by {@link createConsoleLogger}. */
export type ConsoleLike = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>

export interface ConsoleLoggerOptions {
  /** Minimum level written. Default: `info`. */
  readonly level?: LogLevel
  /** Prefix of every message. Default: `[znight]`. */
  readonly prefix?: string
  /** Destination. Default: the global `console`. */
  readonly console?: ConsoleLike
}

/** Creates a {@link CoreLogger} writing to the console. Entries below `level` are dropped. */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): CoreLogger {
  const threshold = LEVELS[options.level ?? 'info']
  const prefix = options.prefix ?? '[znight]'
  const out = options.console ?? console
  const write = (level: Exclude<LogLevel, 'silent'>, message: string, context?: LogContext): void => {
    if (LEVELS[level] < threshold) return
    const text = prefix === '' ? message : `${prefix} ${message}`
    if (context === undefined || Object.keys(context).length === 0) out[level](text)
    else out[level](text, context)
  }
  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  }
}

function noop(): void {}

/** A logger dropping every entry (useful in tests). */
export const silentLogger: CoreLogger = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop })

/**
 * A logger forwarding every call to a replaceable target. Plugins receive this instance, so a
 * logger installed later (e.g. by `@znight/observability`) is used by everyone immediately.
 */
export class DelegatingLogger implements CoreLogger {
  #target: CoreLogger

  constructor(target: CoreLogger) {
    this.#target = target
  }

  /** The logger currently receiving the entries. */
  get target(): CoreLogger {
    return this.#target
  }

  /** Replaces the logger receiving the entries. Passing the delegating logger itself is ignored. */
  setTarget(target: CoreLogger): void {
    if (target !== this) this.#target = target
  }

  debug(message: string, context?: LogContext): void {
    this.#target.debug(message, context)
  }

  info(message: string, context?: LogContext): void {
    this.#target.info(message, context)
  }

  warn(message: string, context?: LogContext): void {
    this.#target.warn(message, context)
  }

  error(message: string, context?: LogContext): void {
    this.#target.error(message, context)
  }
}
