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
 * Builds a real configuration instance: `new ConfigClass()` (field initializers run), then declared
 * defaults for fields still `undefined`, then `values`. Required fields without value stay
 * `undefined`.
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
    } else if (field.hasDefault && instance[field.property] === undefined) {
      instance[field.property] = copy(field.default)
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

/** Defaults are static values: copy them so that tests never share mutable defaults. */
function copy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}
