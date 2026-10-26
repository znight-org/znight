import type { HookName, HookWrapper } from '@znight/core'

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'QUERY',
  'TRACE',
])

/** Value used for HTTP methods outside of the known set (bounded label cardinality, semconv `_OTHER`). */
export const OTHER_METHOD = '_OTHER'

/** Upper-cased known HTTP method, `_OTHER` for anything else. */
export function normalizeMethod(method: string): string {
  const upper = typeof method === 'string' ? method.toUpperCase() : ''
  return KNOWN_METHODS.has(upper) ? upper : OTHER_METHOD
}

/**
 * Combines several wrappers of the same hook into one (the first is the outermost). Returns
 * `undefined` when there is nothing to combine.
 */
export function composeWrappers<K extends HookName>(
  wrappers: readonly (HookWrapper<K> | undefined)[],
): HookWrapper<K> | undefined {
  const active = wrappers.filter((wrapper): wrapper is HookWrapper<K> => wrapper !== undefined)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return (event, next) => {
    const dispatch = (index: number): Promise<unknown> =>
      index === active.length ? next() : (active[index] as HookWrapper<K>)(event, () => dispatch(index + 1))
    return dispatch(0)
  }
}
