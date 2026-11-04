import type { LogContext } from '@znight/core'
import type { LogEntryLevel } from './levels.ts'
import type { Logger, ScopeSource } from './logger.ts'

import { invalidOption } from '../internal/errors.ts'

/** Second argument of the logging methods: structured context or an error. */
type LogDetails = LogContext | Error

/**
 * A logger obtained with {@link getLogger}: the logging methods of {@link Logger}, written through
 * the logger of the running application. Create it anywhere, including at module load or in a field
 * initialiser, before any application exists.
 */
export interface StaticLogger {
  /** The name given to {@link getLogger}, written as the `logger` field of every entry. */
  readonly name: string
  /** Whether an entry of `level` would be written (always `true` while entries are buffered). */
  isLevelEnabled(level: LogEntryLevel): boolean
  /** A logger writing `bindings` too in every entry (same name). */
  child(bindings: LogContext): StaticLogger
  trace(message: string, details?: LogDetails): void
  trace(details: LogDetails, message?: string): void
  debug(message: string, details?: LogDetails): void
  debug(details: LogDetails, message?: string): void
  info(message: string, details?: LogDetails): void
  info(details: LogDetails, message?: string): void
  warn(message: string, details?: LogDetails): void
  warn(details: LogDetails, message?: string): void
  error(message: string, details?: LogDetails): void
  error(details: LogDetails, message?: string): void
  fatal(message: string, details?: LogDetails): void
  fatal(details: LogDetails, message?: string): void
  /** Logs at a level chosen at runtime. */
  log(level: LogEntryLevel, message: string, details?: LogDetails): void
}

/** How many entries are kept while no logger can write them (the first ones; later ones are counted). */
export const STATIC_LOG_BUFFER_SIZE = 1000

/** The logger of an application, registered by `ObservabilityPlugin`. */
interface Target {
  readonly logger: Logger
  readonly scope: ScopeSource
}

/** An entry written while no logger could take it. */
interface Buffered {
  readonly logger: StaticLoggerImpl
  readonly level: LogEntryLevel
  readonly first: unknown
  readonly second: unknown
  readonly time: number
}

/** Process-wide routing state, shared by every copy of this package loaded in the process. */
interface Registry {
  /** Applications whose logger exists and that are not disposed yet, oldest first. */
  readonly live: Target[]
  /**
   * The logger of the application disposed last, weakly: kept while the application is reachable
   * (a `main.ts` holds it until the process exits), never keeping a dropped one alive.
   */
  last: WeakRef<Logger> | undefined
  /** Set by {@link setFallbackLogger}. */
  fallback: Logger | undefined
  /** Entries written before any logger existed. */
  readonly buffer: Buffered[]
  /** Entries not buffered because the buffer was full. */
  dropped: number
}

const REGISTRY_KEY = Symbol.for('@znight/observability#StaticLoggers')

const registry: Registry = sharedRegistry()

/** The registry of the process, created by the first copy of this package that needs it. */
function sharedRegistry(): Registry {
  const global = globalThis as Record<symbol, unknown>
  const existing = global[REGISTRY_KEY] as Registry | undefined
  if (existing !== undefined) return existing
  const created: Registry = { live: [], last: undefined, fallback: undefined, buffer: [], dropped: 0 }
  global[REGISTRY_KEY] = created
  return created
}

/**
 * A logger named `name`, usable without dependency injection: in classes the container does not
 * create, in module-level code, or to migrate `new Logger(X.name)` (NestJS) or
 * `LoggerFactory.getLogger(X.class)` (SLF4J). Prefer an injected `Logger` in providers.
 *
 * Entries go to the logger of the application whose request scope is active, otherwise of the
 * application created last, as a child with `{ logger: name, ...bindings }`. Before any application
 * exists they are buffered (the first {@link STATIC_LOG_BUFFER_SIZE}) and written once the first one
 * does; once every application has stopped, they go to the logger of the last one while it is
 * reachable. A logger set with {@link setFallbackLogger} takes them whenever no application runs.
 *
 * ```ts
 * const logger = getLogger('PaymentWebhook')
 *
 * export class PaymentWebhook {
 *   handle(event: { id: string }): void {
 *     logger.info('Webhook received', { eventId: event.id })
 *   }
 * }
 * ```
 *
 * @throws ZnightError ZNIGHT005 when `name` is not a non-empty string.
 */
export function getLogger(name: string, bindings?: LogContext): StaticLogger {
  if (typeof name !== 'string' || name === '') {
    throw invalidOption('getLogger() name', `expected a non-empty string, got ${JSON.stringify(name)}`)
  }
  return new StaticLoggerImpl(name, { ...bindings, logger: name })
}

/**
 * Sets the logger that takes the entries of {@link getLogger} loggers while no application runs
 * (`undefined` removes it). Entries buffered so far are written to it. Typical use: silence or
 * capture them in unit tests that create no application, in a test preload:
 * `setFallbackLogger(new Logger({ level: 'silent' }))`.
 */
export function setFallbackLogger(logger: Logger | undefined): void {
  registry.fallback = logger
  if (logger !== undefined) drain(logger)
}

/**
 * Makes `logger` the target of {@link getLogger} loggers until the returned function is called.
 * Called by `ObservabilityPlugin` once its logger exists; the returned function, when the
 * application is disposed.
 */
export function bindStaticLoggers(logger: Logger, scope: ScopeSource): () => void {
  const target: Target = { logger, scope }
  registry.live.push(target)
  drain(logger)
  return () => {
    const index = registry.live.indexOf(target)
    if (index === -1) return
    registry.live.splice(index, 1)
    registry.last = new WeakRef(logger)
  }
}

/** Internal (tests): forgets every application, the fallback and the buffer. */
export function resetStaticLoggers(): void {
  registry.live.length = 0
  registry.last = undefined
  registry.fallback = undefined
  registry.buffer.length = 0
  registry.dropped = 0
}

/** The logger entries go to now, `undefined` when they must be buffered. */
function currentTarget(): Logger | undefined {
  const live = registry.live
  const count = live.length
  if (count === 1) return (live[0] as Target).logger
  if (count > 1) {
    for (let index = count - 1; index >= 0; index--) {
      const target = live[index] as Target
      if (target.scope.currentScope() !== undefined) return target.logger
    }
    return (live[count - 1] as Target).logger
  }
  return registry.fallback ?? registry.last?.deref()
}

/** Writes the buffered entries (with the time of the call as `loggedAt`) through `root`. */
function drain(root: Logger): void {
  const entries = registry.buffer.splice(0)
  const dropped = registry.dropped
  registry.dropped = 0
  for (const entry of entries) {
    const child = entry.logger.loggerFor(root)
    if (!child.isLevelEnabled(entry.level)) continue
    writeTo(child.child({ loggedAt: new Date(entry.time).toISOString() }), entry.level, entry.first, entry.second)
  }
  if (dropped > 0) {
    root.warn(
      `${dropped} log entries written before the application started were dropped (only the first ${STATIC_LOG_BUFFER_SIZE} are kept)`,
      { component: 'znight', dropped },
    )
  }
}

function writeTo(logger: Logger, level: LogEntryLevel, first: unknown, second: unknown): void {
  ;(logger[level] as (first: unknown, second: unknown) => void).call(logger, first, second)
}

class StaticLoggerImpl implements StaticLogger {
  readonly name: string
  readonly #bindings: LogContext
  /** The children of the application loggers this logger wrote to. */
  // weak: a static logger lives as long as its module and must not keep stopped applications alive
  readonly #children = new WeakMap<Logger, Logger>()

  constructor(name: string, bindings: LogContext) {
    this.name = name
    this.#bindings = bindings
  }

  isLevelEnabled(level: LogEntryLevel): boolean {
    const root = currentTarget()
    return root === undefined || this.loggerFor(root).isLevelEnabled(level)
  }

  child(bindings: LogContext): StaticLogger {
    return new StaticLoggerImpl(this.name, { ...this.#bindings, ...bindings, logger: this.name })
  }

  trace(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('trace', first, second)
  }

  debug(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('debug', first, second)
  }

  info(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('info', first, second)
  }

  warn(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('warn', first, second)
  }

  error(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('error', first, second)
  }

  fatal(first: string | LogDetails, second?: string | LogDetails): void {
    this.#write('fatal', first, second)
  }

  log(level: LogEntryLevel, message: string, details?: LogDetails): void {
    this.#write(level, message, details)
  }

  /** The child of `root` this logger writes through (created once per application logger). */
  loggerFor(root: Logger): Logger {
    let child = this.#children.get(root)
    if (child === undefined) {
      child = root.child(this.#bindings)
      this.#children.set(root, child)
    }
    return child
  }

  #write(level: LogEntryLevel, first: unknown, second: unknown): void {
    const root = currentTarget()
    if (root !== undefined) writeTo(this.loggerFor(root), level, first, second)
    else if (registry.buffer.length >= STATIC_LOG_BUFFER_SIZE) registry.dropped++
    else registry.buffer.push({ logger: this, level, first, second, time: Date.now() })
  }
}
