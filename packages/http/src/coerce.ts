import { BadRequestException } from './exceptions.ts'

/**
 * Converts a raw request value (route parameter, query value, header) to `T`, or throws a
 * `400 Bad Request` naming `label` (`param "id"`, `query "page"`, `header "x-limit"`).
 * Called by the compiler-generated `invoke` functions.
 */
export type Coercer<T> = (value: unknown, label: string) => T

/** The coercion helpers called by generated code (see the "Compiler contract" of the README). */
export interface Coercers {
  /** A string. Rejects missing values and repeated query values. */
  readonly string: Coercer<string>
  /** A finite decimal number (`12`, `-1.5`, `1e3`). Rejects `''`, hex, `NaN`, `Infinity`. */
  readonly number: Coercer<number>
  /** A safe integer (`42`, `-7`). */
  readonly integer: Coercer<number>
  /** `true`/`1` → `true`, `false`/`0` → `false` (case-insensitive). */
  readonly boolean: Coercer<boolean>
  /** A bigint (`123`, `-9007199254740993`). */
  readonly bigint: Coercer<bigint>
  /** A `Date` from an ISO 8601 string or a millisecond timestamp. */
  readonly date: Coercer<Date>
  /** One of `values` (string or number literals, compared after coercion). */
  enum<const T extends readonly (string | number | boolean)[]>(value: unknown, label: string, values: T): T[number]
  /** An array: a single value becomes a one-element array, each item is coerced with `item`. */
  array<T>(value: unknown, label: string, item: Coercer<T>): T[]
  /** `undefined` when the value is missing, otherwise `item(value, label)`. */
  optional<T>(value: unknown, label: string, item: Coercer<T>): T | undefined
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const INTEGER = /^[+-]?\d+$/

function invalid(label: string, expected: string, value: unknown): BadRequestException {
  return new BadRequestException(`Invalid ${label}: expected ${expected}, received ${describe(value)}`)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value)
  if (Array.isArray(value)) return `${value.length} values`
  return typeof value
}

/** The single raw string of a value, or a 400 (missing / repeated / not a string). */
function single(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) throw new BadRequestException(`Missing ${label}`)
  if (Array.isArray(value))
    throw new BadRequestException(`Invalid ${label}: expected a single value, received ${value.length}`)
  throw invalid(label, 'a string', value)
}

function toNumber(value: unknown, label: string): number {
  const raw = single(value, label)
  const text = raw.trim()
  if (NUMBER.test(text)) {
    const result = Number(text)
    if (Number.isFinite(result)) return result
  }
  throw invalid(label, 'a number', raw)
}

function toInteger(value: unknown, label: string): number {
  const raw = single(value, label)
  const text = raw.trim()
  if (INTEGER.test(text)) {
    const result = Number(text)
    if (Number.isSafeInteger(result)) return result
  }
  throw invalid(label, 'an integer', raw)
}

function toBoolean(value: unknown, label: string): boolean {
  const raw = single(value, label)
  switch (raw.trim().toLowerCase()) {
    case 'true':
    case '1':
      return true
    case 'false':
    case '0':
      return false
    default:
      throw invalid(label, 'a boolean (true, false, 1 or 0)', raw)
  }
}

function toBigint(value: unknown, label: string): bigint {
  const raw = single(value, label)
  const text = raw.trim()
  if (INTEGER.test(text)) return BigInt(text)
  throw invalid(label, 'an integer', raw)
}

function toDate(value: unknown, label: string): Date {
  const raw = single(value, label)
  const text = raw.trim()
  const date = INTEGER.test(text) ? new Date(Number(text)) : new Date(text)
  if (text === '' || Number.isNaN(date.getTime())) throw invalid(label, 'a date (ISO 8601 or timestamp)', raw)
  return date
}

function toEnum<const T extends readonly (string | number | boolean)[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  const raw = single(value, label)
  for (const candidate of values) {
    if (typeof candidate === 'string' ? candidate === raw : String(candidate) === raw.trim()) return candidate
  }
  throw invalid(label, `one of ${values.map(candidate => JSON.stringify(candidate)).join(', ')}`, raw)
}

function toArray<T>(value: unknown, label: string, item: Coercer<T>): T[] {
  if (value === undefined || value === null) throw new BadRequestException(`Missing ${label}`)
  if (!Array.isArray(value)) return [item(value, label)]
  const result = new Array<T>(value.length)
  for (let index = 0; index < value.length; index++) result[index] = item(value[index], `${label}[${index}]`)
  return result
}

function toOptional<T>(value: unknown, label: string, item: Coercer<T>): T | undefined {
  return value === undefined || value === null ? undefined : item(value, label)
}

/**
 * Coercion helpers used by generated `invoke` functions for typed parameters without schema:
 *
 * ```ts
 * invoke: (c, ctx) => c.list(
 *   coerce.number(ctx.params['id'], 'param "id"'),
 *   coerce.optional(ctx.query['page'], 'query "page"', coerce.integer),
 *   coerce.array(ctx.query['tag'], 'query "tag"', coerce.string),
 * )
 * ```
 *
 * Every failure is a `BadRequestException` (400) whose message names the input.
 */
export const coerce: Coercers = Object.freeze({
  string: single,
  number: toNumber,
  integer: toInteger,
  boolean: toBoolean,
  bigint: toBigint,
  date: toDate,
  enum: toEnum,
  array: toArray,
  optional: toOptional,
})
