/** Helpers shared by the drivers (internal). */
import type { DeadLetterRequest } from '../driver.ts'

import { headerRecord, MessagingHeaders } from '../headers.ts'
import { errorMessage, truncate } from '../internal/async.ts'

/** Longest error message copied into the `x-znight-error` header. */
export const MAX_ERROR_HEADER_LENGTH = 1024

/**
 * Headers of a dead-lettered copy: the original headers without the attempt counter (so that a
 * redrive starts over) plus the reason, the error, the original queue and the attempts made.
 */
export function deadLetterHeaders(
  headers: Readonly<Record<string, string>>,
  request: DeadLetterRequest,
  originalQueue: string,
): Record<string, string> {
  const result = headerRecord()
  for (const [name, value] of Object.entries(headers)) if (name !== MessagingHeaders.Attempt) result[name] = value
  result[MessagingHeaders.DeadLetterReason] = request.reason
  result[MessagingHeaders.Error] = truncate(errorMessage(request.error), MAX_ERROR_HEADER_LENGTH)
  result[MessagingHeaders.OriginalQueue] = originalQueue
  result[MessagingHeaders.Attempts] = String(request.attempt)
  return result
}

/** Converts a header value of any type to a string (`undefined` for null/undefined). */
export function headerValueToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (value instanceof Date) return value.toISOString()
  try {
    return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner))
  } catch {
    return String(value)
  }
}

/** Builds a string header record from arbitrary entries (null-prototype, `undefined` values skipped). */
export function toHeaderRecord(entries: Iterable<readonly [string, unknown]>): Record<string, string> {
  const result = headerRecord()
  for (const [name, value] of entries) {
    const text = headerValueToString(value)
    if (text !== undefined) result[name] = text
  }
  return result
}

/** Reads a header (exact name). */
export function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(headers, name) ? headers[name] : undefined
}

/** Positive finite number option with a default. */
export function durationOption(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new TypeError(`[znight] ${name} must be a number of milliseconds >= 0, got ${String(value)}`)
  }
  return value
}

/** A promise with its resolvers. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
