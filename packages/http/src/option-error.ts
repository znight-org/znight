/** Errors of invalid `HttpPlugin` options (internal). */
import { ErrorCode, ZnightError } from '@znight/core'

/** `ZNIGHT005: HttpPlugin: option "<name>" must be <expected> (received <value>)`. */
export function invalidOption(
  name: string,
  expected: string,
  value: unknown,
  cause?: unknown,
  hints?: readonly string[],
): ZnightError {
  return new ZnightError(
    ErrorCode.InvalidDecorator,
    `HttpPlugin: option "${name}" must be ${expected} (received ${describeOption(value)})`,
    {
      ...(cause === undefined ? {} : { cause }),
      ...(hints === undefined ? {} : { hints }),
    },
  )
}

/** A short description of an option value for messages. */
export function describeOption(value: unknown): string {
  if (typeof value === 'function') return 'a function'
  if (value instanceof RegExp) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return typeof value
  }
}
