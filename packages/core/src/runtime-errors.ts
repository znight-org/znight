import type { SourceLocation, Token } from './metadata.ts'

import { type ErrorCode, ErrorCode as ErrorCodes, ZnightError, type ZnightErrorOptions } from './errors.ts'
import { displayName, formatPath } from './tokens.ts'
import { errorMessage } from './utils.ts'

/**
 * ZNIGHT015: a provider factory threw or rejected.
 *
 * Carries the failing token, the dependency path that led to it (outermost first, the failing token
 * last), the source location of the provider when the metadata includes it, and the original error
 * as `cause`.
 */
export class InstantiationError extends ZnightError {
  /** Token of the provider whose factory failed. */
  readonly token: Token
  /** Dependency path from the outermost dependent to {@link token} (inclusive). */
  readonly path: readonly Token[]
  /** Location of the provider declaration, when known. */
  readonly source: SourceLocation | undefined

  constructor(token: Token, path: readonly Token[], cause: unknown, source?: SourceLocation) {
    const lines = [`Failed to instantiate ${displayName(token)}: ${errorMessage(cause)}`, `  token: ${token}`]
    if (source !== undefined) lines.push(`  at: ${source.file}:${source.line}:${source.column}`)
    if (path.length > 1) lines.push(`  dependency path: ${formatPath(path)}`)
    super(ErrorCodes.InstantiationFailed, lines.join('\n'), { cause })
    this.token = token
    this.path = path
    this.source = source
  }

  /** A copy of this error whose path is prefixed with `parents` (used while unwinding a resolution). */
  withParents(parents: readonly Token[]): InstantiationError {
    if (parents.length === 0) return this
    const error = new InstantiationError(this.token, [...parents, ...this.path], this.cause, this.source)
    const suppressed = getSuppressedErrors(this)
    if (suppressed.length > 0) addSuppressedErrors(error, suppressed)
    return error
  }
}

/**
 * A {@link ZnightError} grouping several failures (e.g. every shutdown step that failed). Exposes
 * `errors` like the standard `AggregateError`, while keeping a Znight `code`.
 */
export class ZnightAggregateError extends ZnightError {
  readonly errors: readonly unknown[]

  constructor(code: ErrorCode, message: string, errors: readonly unknown[], options: ZnightErrorOptions = {}) {
    const details = errors.map((error, index) => `  ${index + 1}. ${errorMessage(error)}`)
    super(code, [message, ...details].join('\n'), options)
    this.errors = errors
  }
}

const SUPPRESSED = 'suppressed'

/**
 * Errors that happened while handling `error` (rollback/cleanup failures, concurrent failures) and
 * that were attached to it instead of being thrown. Empty when there are none.
 */
export function getSuppressedErrors(error: unknown): readonly unknown[] {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return []
  const value: unknown = Object.hasOwn(error, SUPPRESSED) ? (error as Record<string, unknown>)[SUPPRESSED] : undefined
  return Array.isArray(value) ? value : []
}

/** Attaches `errors` to `error` (see {@link getSuppressedErrors}). Primitives cannot carry them. */
export function addSuppressedErrors(error: unknown, errors: readonly unknown[]): void {
  if (errors.length === 0) return
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return
  const all = [...getSuppressedErrors(error), ...errors]
  try {
    Object.defineProperty(error, SUPPRESSED, { value: all, enumerable: true, configurable: true, writable: true })
  } catch {
    // frozen or exotic error objects cannot carry the extra information: nothing else to do
  }
}

/** Wraps a non-Znight error into a ZNIGHT021 error mentioning `step`; Znight errors are returned as is. */
export function lifecycleError(step: string, error: unknown): ZnightError {
  if (error instanceof ZnightError) return error
  return new ZnightError(ErrorCodes.LifecycleFailed, `${step} failed: ${errorMessage(error)}`, { cause: error })
}
