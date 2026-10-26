/** Internal helpers. */

/**
 * Materialises a `Map`, an iterable of `[key, value]` pairs or a record into an array of pairs (an
 * iterable such as a generator can only be read once).
 */
export function entriesOf<K, V>(
  values: Iterable<readonly [K, V]> | Readonly<Record<string, V>>,
): (readonly [K | string, V])[] {
  if (typeof (values as Partial<Iterable<unknown>>)[Symbol.iterator] === 'function') {
    const entries: (readonly [K, V])[] = []
    for (const entry of values as Iterable<readonly [K, V]>) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new TypeError('[znight] Expected [key, value] pairs (a Map, an array of pairs or a record)')
      }
      entries.push(entry)
    }
    return entries
  }
  return Object.entries(values as Readonly<Record<string, V>>)
}

/** Whether `value` is a promise-like object (has a callable `then`). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Describes a provider key (class, token...) for messages. */
export function describeKey(key: unknown): string {
  if (typeof key === 'function') return `class ${(key as { name?: string }).name || '<anonymous>'}`
  if (typeof key === 'string') return `"${key}"`
  return String(key)
}
