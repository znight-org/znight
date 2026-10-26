import type { MethodInterceptor, MethodInvocation } from '@znight/core'
import type { LogEntryLevel } from '../logging/levels.ts'
import type { Logger } from '../logging/logger.ts'

import { guard } from '../internal/safe.ts'
import { elapsedMs, now } from '../internal/time.ts'
import { parseEntryLevel } from '../logging/levels.ts'
import { observeCall } from './observe.ts'
import { assertOptionalString, assertOptionsObject } from './options.ts'

/** Options of `@Logged()` / {@link LoggedInterceptor}. */
export interface LoggedOptions {
  /** Level of the entry written when the method returns. Default: `debug`. */
  readonly level?: LogEntryLevel
  /** Level of the entry written when the method throws. Default: `error`. */
  readonly errorLevel?: LogEntryLevel
  /** Log the arguments (`args`), subject to the logger's redaction paths (`args[0].password`). Default: `false`. */
  readonly args?: boolean
  /** Log the returned value (`result`; the resolved value for async methods). Default: `false`. */
  readonly result?: boolean
  /** Message prefix. Default: `<Class>.<method>()`. */
  readonly message?: string
}

/** Normalised `@Logged()` options. */
export interface Resolved {
  readonly level: LogEntryLevel
  readonly errorLevel: LogEntryLevel
  readonly args: boolean
  readonly result: boolean
  readonly message: string | undefined
}

const DEFAULTS: Resolved = Object.freeze({
  level: 'debug',
  errorLevel: 'error',
  args: false,
  result: false,
  message: undefined,
})

/**
 * Method interceptor behind `@Logged()`: writes one entry per call with `class`, `method` and
 * `durationMs` (plus `args` / `result` when enabled), at `level` on success and at `errorLevel` with
 * `err` on failure. Calls cost nothing beyond a level check when both levels are disabled.
 * Synchronous methods stay synchronous.
 */
export class LoggedInterceptor implements MethodInterceptor<LoggedOptions | undefined> {
  readonly #logger: Logger
  readonly #resolved = new WeakMap<LoggedOptions, Resolved>()
  readonly #record = guard('@Logged()')

  constructor(logger: Logger) {
    this.#logger = logger
  }

  intercept(invocation: MethodInvocation, options?: LoggedOptions): unknown {
    const settings = this.#settings(options)
    const logger = this.#logger
    if (!logger.isLevelEnabled(settings.level) && !logger.isLevelEnabled(settings.errorLevel)) {
      return invocation.proceed()
    }
    const started = now()
    const label = settings.message ?? `${invocation.className}.${invocation.methodName}()`
    const entry = (): Record<string, unknown> => {
      const fields: Record<string, unknown> = {
        class: invocation.className,
        method: invocation.methodName,
        durationMs: elapsedMs(started),
      }
      if (settings.args) fields.args = invocation.args
      return fields
    }
    return observeCall(invocation.isAsync, () => invocation.proceed(), {
      success: value =>
        this.#record(() => {
          if (!logger.isLevelEnabled(settings.level)) return
          const fields = entry()
          if (settings.result) fields.result = value
          logger.log(settings.level, `${label} completed`, fields)
        }),
      failure: error =>
        this.#record(() => {
          if (!logger.isLevelEnabled(settings.errorLevel)) return
          const fields = entry()
          fields.err = error
          logger.log(settings.errorLevel, `${label} failed`, fields)
        }),
    })
  }

  #settings(options: LoggedOptions | undefined): Resolved {
    if (options === undefined || options === null) return DEFAULTS
    let resolved = this.#resolved.get(options)
    if (resolved === undefined) {
      resolved = resolveLoggedOptions(options)
      this.#resolved.set(options, resolved)
    }
    return resolved
  }
}

/**
 * Validates and normalises `@Logged()` options.
 *
 * @throws ZnightError (ZNIGHT005) for invalid options.
 */
export function resolveLoggedOptions(options: unknown, where = '@Logged()'): Resolved {
  assertOptionsObject(options, where)
  if (options === undefined || options === null) return DEFAULTS
  const { level, errorLevel, args, result, message } = options as LoggedOptions
  assertOptionalString(message, `${where} message`)
  return {
    level: level === undefined ? DEFAULTS.level : parseEntryLevel(level, `${where} level`),
    errorLevel: errorLevel === undefined ? DEFAULTS.errorLevel : parseEntryLevel(errorLevel, `${where} errorLevel`),
    args: args === true,
    result: result === true,
    message,
  }
}
