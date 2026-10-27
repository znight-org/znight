/**
 * Reading statically evaluated values (`StaticValue`) without importing the compiler: references
 * to exported bindings (`ValueRef`) are recognised structurally.
 */
import type { StaticValue, ValueRef } from '@znight/compiler'
import type { JsonValue } from '../types.ts'

/** `true` for a `ValueRef` (a reference to an exported binding, nested in an evaluated value). */
export function isRef(value: unknown): value is ValueRef {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype !== Object.prototype && prototype !== null && (value as { kind?: unknown }).kind === 'ref'
}

/** `true` for an evaluated object literal (not an array, not a reference). */
export function isRecord(value: unknown): value is Readonly<Record<string, StaticValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isRef(value)
}

/** The value when it is JSON (no `undefined` inside objects is kept, no bigint, no reference). */
export function toJson(value: StaticValue): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value === undefined || typeof value === 'bigint' || isRef(value)) return undefined
  if (Array.isArray(value)) {
    const items: JsonValue[] = []
    for (const item of value as readonly StaticValue[]) {
      const json = toJson(item)
      if (json === undefined) return undefined
      items.push(json)
    }
    return items
  }
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value as Readonly<Record<string, StaticValue>>)) {
    if (item === undefined) continue
    const json = toJson(item)
    if (json === undefined) return undefined
    result[key] = json
  }
  return result
}

/** The first `$znight` key found in a value (reserved), as a path (`info.x.$znight`). */
export function findReservedKey(value: StaticValue, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of (value as readonly StaticValue[]).entries()) {
      const found = findReservedKey(item, `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const [key, item] of Object.entries(value)) {
    const where = path === '' ? key : `${path}.${key}`
    if (key === '$znight') return where
    const found = findReservedKey(item, where)
    if (found !== undefined) return found
  }
  return undefined
}

/** A short description for messages. */
export function describe(value: StaticValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (isRef(value)) return `a reference to '${value.text}'`
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/** Absolute URL (`https://...`, `mailto:`...). */
export function isAbsoluteUrl(value: string): boolean {
  return URL.canParse(value)
}

/** Absolute or relative URL (servers: `/api`, `https://api.example.com/v1`). */
export function isUrlReference(value: string): boolean {
  return value !== '' && !/\s/.test(value) && (URL.canParse(value) || URL.canParse(value, 'https://example.com'))
}
