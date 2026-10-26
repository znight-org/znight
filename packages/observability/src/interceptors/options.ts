import { invalidOption } from '../internal/errors.ts'

/**
 * Checks that interceptor options are an object (or absent). Options come from decorator
 * arguments emitted by the compiler; anything else is a usage error (ZNIGHT005).
 */
export function assertOptionsObject(options: unknown, where: string): asserts options is object | undefined {
  if (options === undefined || options === null) return
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw invalidOption(`${where} options`, `expected an object, got ${JSON.stringify(options)}`)
  }
}

/** Checks an optional string option. */
export function assertOptionalString(value: unknown, option: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw invalidOption(option, `expected a string, got ${JSON.stringify(value)}`)
  }
}
