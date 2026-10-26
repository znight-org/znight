/**
 * Coercion of raw configuration values (strings from the environment, structured values from files)
 * to the type of a config property.
 */
import type { ConfigEnumValue, ConfigFieldType } from './metadata.ts'

import { SECRET_MASK } from './conventions.ts'

/** Result of {@link coerceConfigValue}. */
export type CoercionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

/** Options of {@link coerceConfigValue}. */
export interface CoercionOptions {
  /** Allowed values (checked after coercion; every element for arrays). */
  readonly enum?: readonly ConfigEnumValue[] | undefined
  /** Hides the value in error messages. */
  readonly secret?: boolean | undefined
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const TRUE = new Set(['true', '1', 'yes', 'on'])
const FALSE = new Set(['false', '0', 'no', 'off'])
const MAX_PREVIEW = 60
const HOST_PORT = /^[^:/?#\s]+:\d+(?:[/?#]|$)/

function ok(value: unknown): CoercionResult {
  return { ok: true, value }
}

function fail(message: string): CoercionResult {
  return { ok: false, message }
}

/** Describes a value for an error message (`"abc"`, `42`, `an object`), or the mask for secrets. */
export function describeValue(value: unknown, secret = false): string {
  if (secret) return SECRET_MASK
  if (typeof value === 'string') {
    const preview = value.length > MAX_PREVIEW ? `${value.slice(0, MAX_PREVIEW)}…` : value
    return JSON.stringify(preview)
  }
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (value instanceof URL) return JSON.stringify(value.href)
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return 'a function'
  return String(value)
}

/**
 * Whether `raw` counts as "not set" for a property of type `type`: `undefined`, `null`, and blank
 * strings for every type but `string` (so `PORT=` falls back to the default).
 */
export function isUnset(raw: unknown, type: ConfigFieldType): boolean {
  if (raw === undefined || raw === null) return true
  return type !== 'string' && typeof raw === 'string' && raw.trim() === ''
}

function toNumber(raw: unknown, secret: boolean): CoercionResult {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? ok(raw) : fail(`expected a finite number but got ${describeValue(raw, secret)}`)
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (NUMBER.test(text)) {
      const value = Number(text)
      if (Number.isFinite(value)) return ok(value)
    }
  }
  return fail(`expected a number but got ${describeValue(raw, secret)}`)
}

function toBoolean(raw: unknown, secret: boolean): CoercionResult {
  if (typeof raw === 'boolean') return ok(raw)
  if (raw === 1 || raw === 0) return ok(raw === 1)
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase()
    if (TRUE.has(text)) return ok(true)
    if (FALSE.has(text)) return ok(false)
  }
  return fail(`expected a boolean (true/false, 1/0, yes/no, on/off) but got ${describeValue(raw, secret)}`)
}

function toText(raw: unknown, secret: boolean): CoercionResult {
  if (typeof raw === 'string') return ok(raw)
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') return ok(String(raw))
  if (raw instanceof URL) return ok(raw.href)
  return fail(`expected a string but got ${describeValue(raw, secret)}`)
}

function toUrl(raw: unknown, secret: boolean): CoercionResult {
  if (raw instanceof URL) return ok(new URL(raw.href))
  if (typeof raw === 'string') {
    const text = raw.trim()
    // `localhost:5432` parses as the scheme `localhost:`: almost always a forgotten scheme
    if (HOST_PORT.test(text)) {
      return fail(
        `expected an absolute URL but got ${describeValue(raw, secret)} (missing scheme, e.g. "http://${secret ? 'host:port' : text}")`,
      )
    }
    if (URL.canParse(text)) return ok(new URL(text))
  }
  return fail(`expected an absolute URL but got ${describeValue(raw, secret)}`)
}

function toJson(raw: unknown, secret: boolean): CoercionResult {
  if (typeof raw === 'object' && raw !== null) {
    // instances never share mutable structures with the source (or with each other)
    try {
      return ok(structuredClone(raw))
    } catch {
      return ok(raw)
    }
  }
  if (typeof raw !== 'string') return ok(raw)
  try {
    return ok(JSON.parse(raw))
  } catch (error) {
    // JSON.parse messages quote the input: never show them for secrets
    const detail = secret || !(error instanceof Error) ? '' : ` (${error.message})`
    return fail(`expected valid JSON but got ${describeValue(raw, secret)}${detail}`)
  }
}

function toList(
  raw: unknown,
  secret: boolean,
  item: (value: unknown, secret: boolean) => CoercionResult,
): CoercionResult {
  let items: readonly unknown[]
  if (Array.isArray(raw)) {
    items = raw
  } else if (typeof raw === 'string') {
    items = raw
      .split(',')
      .map(part => part.trim())
      .filter(part => part !== '')
  } else {
    return fail(`expected a comma-separated list or an array but got ${describeValue(raw, secret)}`)
  }
  const values: unknown[] = []
  for (const [index, value] of items.entries()) {
    const result = item(value, secret)
    if (!result.ok) return fail(`item ${index}: ${result.message}`)
    values.push(result.value)
  }
  return ok(values)
}

function formatEnum(values: readonly ConfigEnumValue[]): string {
  return values.map(value => JSON.stringify(value)).join(', ')
}

function checkEnum(value: unknown, allowed: readonly ConfigEnumValue[], secret: boolean): CoercionResult {
  const items = Array.isArray(value) ? value : [value]
  for (const [index, item] of items.entries()) {
    if (allowed.includes(item as ConfigEnumValue)) continue
    const where = Array.isArray(value) ? `item ${index}: ` : ''
    return fail(`${where}expected one of ${formatEnum(allowed)} but got ${describeValue(item, secret)}`)
  }
  return ok(value)
}

function convert(raw: unknown, type: ConfigFieldType, secret: boolean): CoercionResult {
  switch (type) {
    case 'string':
      return toText(raw, secret)
    case 'number':
      return toNumber(raw, secret)
    case 'boolean':
      return toBoolean(raw, secret)
    case 'string[]':
      return toList(raw, secret, toText)
    case 'number[]':
      return toList(raw, secret, toNumber)
    case 'url':
      return toUrl(raw, secret)
    case 'json':
      return toJson(raw, secret)
    default:
      return fail(`unsupported config type ${JSON.stringify(type)}`)
  }
}

/**
 * Converts a raw value to `type`:
 *
 * | Type       | Accepted raw values                                                                  |
 * | ---------- | ------------------------------------------------------------------------------------ |
 * | `string`   | strings (kept as is), numbers, booleans                                              |
 * | `number`   | finite numbers, strict decimal strings (`42`, `-1.5`, `1e3`; not `12px`, `0x10`)     |
 * | `boolean`  | booleans, `1`/`0`, `true/false`, `yes/no`, `on/off` (case-insensitive)                |
 * | `string[]` | arrays, comma-separated strings (`a, b,c`; items trimmed, empty items dropped)       |
 * | `number[]` | arrays, comma-separated strings, every item a `number`                               |
 * | `url`      | absolute URL strings or `URL` instances → a new `URL`                                |
 * | `json`     | strings (parsed with `JSON.parse`) or structured values (kept as is)                 |
 *
 * Then checks `options.enum`. Never throws.
 */
export function coerceConfigValue(raw: unknown, type: ConfigFieldType, options: CoercionOptions = {}): CoercionResult {
  const secret = options.secret === true
  const result = convert(raw, type, secret)
  if (!result.ok || options.enum === undefined || options.enum.length === 0) return result
  return checkEnum(result.value, options.enum, secret)
}
