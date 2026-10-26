/** Validation of HTTP header names and values (internal). */
import type { HeaderValue } from './exceptions.ts'

/** A field name: an RFC 9110 token. */
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Characters a field value may not contain: everything but HTAB, visible ASCII, space and obs-text
 * (what Node.js `validateHeaderValue` accepts; Fetch `Headers` are less strict, Latin-1 only).
 */
const INVALID_VALUE = /[^\t\x20-\x7e\x80-\xff]/

/** Whether `name` is a valid header name. */
export function isHeaderName(name: string): boolean {
  return NAME.test(name)
}

/** Whether `value` can be sent as a header value by every adapter (no CR / LF, Latin-1 only...). */
export function isHeaderValue(value: string): boolean {
  return !INVALID_VALUE.test(value)
}

/**
 * The name of the first header whose name or value cannot be sent (`ctx.setHeader('x', 'a\r\nb')`,
 * a non Latin-1 file name...), `undefined` when every header is valid.
 */
export function findInvalidHeader(headers: Readonly<Record<string, HeaderValue | undefined>>): string | undefined {
  for (const name of Object.keys(headers)) {
    const value = headers[name]
    if (value === undefined) continue
    if (!NAME.test(name)) return name
    if (typeof value === 'string') {
      if (INVALID_VALUE.test(value)) return name
    } else {
      for (const item of value) if (INVALID_VALUE.test(String(item))) return name
    }
  }
  return undefined
}
