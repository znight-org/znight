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

/** A `Record` without prototype (safe for user-controlled keys such as `__proto__`). */
export function emptyRecord<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>
}

/** Whether the code runs on Bun. */
export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}
