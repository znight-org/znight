import { emptyRecord } from './utils.ts'

/** Parsed query string (or `application/x-www-form-urlencoded` body): repeated keys become arrays. */
export type QueryRecord = Record<string, string | string[]>

/**
 * Parses a query string (with or without the leading `?`) with `URLSearchParams` semantics (`+` is
 * a space, malformed `%` sequences are kept as is, invalid UTF-8 becomes U+FFFD). A key present
 * once maps to a string, a repeated key to an array of strings, in order. No nesting (`a[b]=1` is
 * the key `a[b]`). The returned object has no prototype.
 *
 * `parseQuery('?tag=a&tag=b&page=2')` → `{ tag: ['a', 'b'], page: '2' }`
 */
export function parseQuery(query: string): QueryRecord {
  const result = emptyRecord<string | string[]>()
  if (query === '' || query === '?') return result
  for (const [key, value] of new URLSearchParams(query)) {
    const existing = result[key]
    if (existing === undefined) result[key] = value
    else if (typeof existing === 'string') result[key] = [existing, value]
    else existing.push(value)
  }
  return result
}

/** Splits a request target (`/users?page=2`) into its raw path and raw query (without `?`). */
export function splitUrl(url: string): { readonly path: string; readonly query: string } {
  const index = url.indexOf('?')
  return index === -1 ? { path: url, query: '' } : { path: url.slice(0, index), query: url.slice(index + 1) }
}
