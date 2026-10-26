/** Internal helpers (not part of the public API). */

/** Whether `value` is a promise-like object (has a callable `then`). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
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

/** Whether the runtime runs in development mode (`NODE_ENV !== 'production'`). */
export function isDevelopment(): boolean {
  return globalThis.process?.env?.NODE_ENV !== 'production'
}

/** Monotonic clock in milliseconds. */
export function now(): number {
  return performance.now()
}
