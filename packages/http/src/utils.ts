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

/**
 * Constructor of {@link fastRecord}: its prototype is an empty, frozen object without prototype, so
 * nothing is inherited (`__proto__`, `constructor`, `toString`... are plain own keys).
 */
const FastRecord = function FastRecord() {} as unknown as new () => object
FastRecord.prototype = Object.freeze(Object.create(null))

/**
 * A `Record` that inherits nothing, like {@link emptyRecord}, but that V8 keeps in fast mode: an
 * `Object.create(null)` object is a dictionary, about twice as slow to fill and enumerate (response
 * headers: built, completed and enumerated on every request). Its prototype is not `null` (an empty
 * frozen object): use {@link emptyRecord} for records handed to user code (query, fields...).
 */
export function fastRecord<V>(): Record<string, V> {
  return new FastRecord() as Record<string, V>
}

/** Whether the code runs on Bun. */
export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}
