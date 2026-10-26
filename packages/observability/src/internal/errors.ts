import { ErrorCode, ZnightError } from '@znight/core'

/** Error thrown for an invalid option value (ZNIGHT005, like the core runtime does for plugin options). */
export function invalidOption(option: string, message: string, hints: readonly string[] = []): ZnightError {
  return new ZnightError(ErrorCode.InvalidDecorator, `Invalid ${option}: ${message}`, { hints })
}

/** Message of any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return Object.prototype.toString.call(error)
  }
}

/** Name of an error class (`TypeError`, `HttpException`...), `Error` for non-errors. */
export function errorType(error: unknown): string {
  if (error instanceof Error) return error.constructor?.name || error.name || 'Error'
  return typeof error === 'object' && error !== null ? 'Error' : typeof error
}

/** Whether `value` is a promise-like object (has a callable `then`). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
