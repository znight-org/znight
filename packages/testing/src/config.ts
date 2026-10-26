import type { ProviderClass, ProviderKey, Token } from '@znight/core'
import type { ConfigClassInfo } from './extensions.ts'
import type { MetadataIndex } from './metadata-index.ts'

import { displayName, ErrorCode, InstantiationError, ZnightError } from '@znight/core'

import { describeKey, entriesOf } from './utils.ts'

/** Property values of one configuration class (`{ port: 8080 }`). */
export type ConfigProperties = Readonly<Record<string, unknown>>

/**
 * Configuration values by configuration class, for `TestBed.create(..., { config })`: a record keyed
 * by token, display name or `@Config` prefix, or `[ConfigClass, values]` pairs.
 *
 * ```ts
 * config: { DatabaseConfig: { host: 'db.test' } }
 * config: { database: { host: 'db.test' } } // @Config('database')
 * config: [[DatabaseConfig, { host: 'db.test' }]]
 * ```
 */
export type ConfigValues =
  | Iterable<readonly [ProviderKey, ConfigProperties]>
  | Readonly<Record<string, ConfigProperties>>

/**
 * Resolves {@link ConfigValues} to per-token values, validating class keys and property names.
 *
 * @throws ZnightError ZNIGHT012 for an unknown configuration class or property.
 */
export function normalizeConfigValues(
  values: ConfigValues | undefined,
  index: MetadataIndex,
  configs: ReadonlyMap<Token, ConfigClassInfo>,
): Map<Token, Record<string, unknown>> {
  const result = new Map<Token, Record<string, unknown>>()
  if (values === undefined) return result
  const universe = new Set(configs.keys())
  for (const [key, properties] of entriesOf<ProviderKey, ConfigProperties>(values)) {
    const token = index.find(key, universe) ?? findByPrefix(key, configs)
    if (token === undefined) {
      const available = [...configs.values()].map(describeConfig)
      throw new ZnightError(ErrorCode.InvalidConfig, `config: ${describeKey(key)} is not a configuration class`, {
        hints: [
          available.length === 0
            ? 'The metadata declares no configuration class (extensions.config.configs)'
            : `Configuration classes: ${available.join(', ')}`,
        ],
      })
    }
    const info = configs.get(token) as ConfigClassInfo
    if (properties === null || typeof properties !== 'object') {
      throw new ZnightError(ErrorCode.InvalidConfig, `config: the values of ${displayName(token)} must be an object`)
    }
    const known = new Set(info.fields.map(field => field.property))
    for (const property of Object.keys(properties)) {
      if (!known.has(property)) {
        throw new ZnightError(
          ErrorCode.InvalidConfig,
          `config: ${displayName(token)} has no configuration property "${property}"`,
          { hints: [`Properties: ${[...known].join(', ') || '(none)'}`] },
        )
      }
    }
    result.set(token, { ...result.get(token), ...properties })
  }
  return result
}

/**
 * Builds a real configuration instance like `@znight/config` without any source would:
 * `new ConfigClass()` (field initializers run), then the declared `@Default` values (which win over
 * initializers, as at runtime, converted to the field type, see {@link convertDefault}), then
 * `values` (as given). Required fields without value stay `undefined`.
 */
export function buildConfigInstance(
  info: ConfigClassInfo,
  cls: ProviderClass | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): object {
  let instance: Record<string, unknown>
  try {
    instance =
      cls === undefined ? {} : (new (cls as unknown as new () => Record<string, unknown>)() as Record<string, unknown>)
  } catch (error) {
    throw new InstantiationError(info.token, [info.token], error)
  }
  for (const field of info.fields) {
    if (values !== undefined && Object.hasOwn(values, field.property)) {
      instance[field.property] = values[field.property]
    } else if (field.hasDefault) {
      instance[field.property] = convertDefault(field.default, field.type)
    }
  }
  return instance
}

function findByPrefix(key: unknown, configs: ReadonlyMap<Token, ConfigClassInfo>): Token | undefined {
  if (typeof key !== 'string') return undefined
  const matches = [...configs.values()].filter(info => info.prefix === key)
  return matches.length === 1 ? matches[0]?.token : undefined
}

function describeConfig(info: ConfigClassInfo): string {
  const name = displayName(info.token)
  return info.prefix === undefined ? name : `${name} (prefix "${info.prefix}")`
}

const INVALID: unique symbol = Symbol('invalid')
/** Strict decimal numbers, as accepted by `@znight/config` (`42`, `-1.5`, `1e3`; not `0x10`). */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const TRUE = new Set(['true', '1', 'yes', 'on'])
const FALSE = new Set(['false', '0', 'no', 'off'])

/**
 * A declared default converted to the field type the way `@znight/config` converts it at runtime
 * (`loadConfig`), so the instance has the same shape in tests as in the application: `'8080'` → `8080`
 * (`number`), `'yes'` → `true`, `'a, b'` → `['a', 'b']` (lists), an absolute URL string → a `URL`
 * (`url`), a JSON string → its value (`json`). `@znight/testing` does not depend on `@znight/config`,
 * hence this small mirror of its coercion rules. A value that does not convert (the compiler already
 * rejects invalid defaults) or an unknown type is kept as is (copied).
 */
export function convertDefault(value: unknown, type: string | undefined): unknown {
  const converted = convert(value, type)
  return converted === INVALID ? copy(value) : converted
}

function convert(value: unknown, type: string | undefined): unknown {
  switch (type) {
    case 'string':
      return toText(value)
    case 'number':
      return toNumber(value)
    case 'boolean':
      return toBoolean(value)
    case 'string[]':
      return toList(value, toText)
    case 'number[]':
      return toList(value, toNumber)
    case 'url':
      return toUrl(value)
    case 'json':
      return toJson(value)
    default:
      return INVALID
  }
}

function toText(value: unknown): unknown {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return INVALID
}

function toNumber(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return INVALID
  const number = Number(value.trim())
  return Number.isFinite(number) ? number : INVALID
}

function toBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value !== 'string') return INVALID
  const text = value.trim().toLowerCase()
  if (TRUE.has(text)) return true
  return FALSE.has(text) ? false : INVALID
}

function toList(value: unknown, item: (value: unknown) => unknown): unknown {
  let items: readonly unknown[]
  if (Array.isArray(value)) {
    items = value
  } else if (typeof value === 'string') {
    items = value
      .split(',')
      .map(part => part.trim())
      .filter(part => part !== '')
  } else {
    return INVALID
  }
  const result: unknown[] = []
  for (const entry of items) {
    const converted = item(entry)
    if (converted === INVALID) return INVALID
    result.push(converted)
  }
  return result
}

function toUrl(value: unknown): unknown {
  if (value instanceof URL) return new URL(value.href)
  return typeof value === 'string' && URL.canParse(value.trim()) ? new URL(value.trim()) : INVALID
}

function toJson(value: unknown): unknown {
  if (typeof value !== 'string') return copy(value)
  try {
    return JSON.parse(value) as unknown
  } catch {
    return INVALID
  }
}

/** Defaults are static values: copy them so that tests never share mutable defaults. */
function copy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}
