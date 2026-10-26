/**
 * Resolution of config fields against a source: precedence, coercion, enum and required checks.
 * Pure: never instantiates the config class, never throws for invalid values (problems are
 * collected), only for invalid definitions (ZNIGHT012).
 */
import type { ConfigProblem } from './errors.ts'
import type { ConfigFieldDefinition } from './metadata.ts'
import type { ConfigSource } from './source.ts'

import { coerceConfigValue, isUnset } from './coerce.ts'
import { invalidConfig } from './errors.ts'
import { CONFIG_FIELD_TYPES } from './metadata.ts'
import { sourceEntry } from './source.ts'

/** Result of {@link resolveFields}. */
export interface ResolvedFields {
  /** Coerced values to assign, by property (properties left to their initializer are absent). */
  readonly values: ReadonlyMap<string, unknown>
  readonly problems: readonly ConfigProblem[]
}

/** Origin reported for problems of `@Default` values. */
export const DEFAULT_ORIGIN = '@Default'

const checked = new WeakSet<object>()

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Checks the shape of generated field definitions (once per array).
 *
 * @throws ZnightError ZNIGHT012 when a definition is malformed (stale or hand-written metadata).
 */
export function assertFieldDefinitions(config: string, fields: readonly ConfigFieldDefinition[]): void {
  if (!Array.isArray(fields)) {
    throw invalidConfig(`Invalid config fields of ${config}: expected an array of field definitions`, [
      'Regenerate the container (znight generate) with matching @znight/compiler and @znight/config versions',
    ])
  }
  if (checked.has(fields)) return
  const seen = new Set<string>()
  for (const [index, field] of fields.entries()) {
    const problem = definitionProblem(field, seen)
    if (problem !== undefined) {
      throw invalidConfig(`Invalid config field #${index} of ${config}: ${problem}`, [
        'Regenerate the container (znight generate) with matching @znight/compiler and @znight/config versions',
      ])
    }
  }
  checked.add(fields)
}

function definitionProblem(field: ConfigFieldDefinition | null | undefined, seen: Set<string>): string | undefined {
  if (typeof field !== 'object' || field === null) return 'expected an object'
  if (!isNonEmptyString(field.property)) return '"property" must be a non-empty string'
  if (seen.has(field.property)) return `property "${field.property}" is defined twice`
  seen.add(field.property)
  if (!isNonEmptyString(field.env)) return `"env" of "${field.property}" must be a non-empty string`
  if (!isNonEmptyString(field.key)) return `"key" of "${field.property}" must be a non-empty string`
  if (!CONFIG_FIELD_TYPES.includes(field.type)) {
    return `unsupported type ${JSON.stringify(field.type)} for "${field.property}" (expected ${CONFIG_FIELD_TYPES.join(', ')})`
  }
  if (field.enum !== undefined && !Array.isArray(field.enum)) return `"enum" of "${field.property}" must be an array`
  return undefined
}

/**
 * Resolves `fields` of the config class named `config` against `source`. For each field, the value
 * comes from the first of:
 *
 * 1. the source, by environment variable name (`field.env`);
 * 2. the source, by key path (`field.key`);
 * 3. `field.default` (`@Default` or statically evaluated initializer);
 * 4. the instance initializer, when `hasInitializer(property)` (left untouched).
 *
 * `undefined`, `null` and blank strings (except for `string` fields) count as not set. A field
 * without value is a `missing` problem when `required`; a value that cannot be coerced (or is not
 * in `enum`) is an `invalid` problem.
 */
export function resolveFields(
  config: string,
  fields: readonly ConfigFieldDefinition[],
  source: ConfigSource,
  hasInitializer: (property: string) => boolean = () => false,
): ResolvedFields {
  assertFieldDefinitions(config, fields)
  const values = new Map<string, unknown>()
  const problems: ConfigProblem[] = []
  for (const field of fields) {
    const secret = field.secret === true
    const base = { config, property: field.property, env: field.env, key: field.key }
    const names = field.env === field.key ? [field.env] : [field.env, field.key]
    let found = false
    for (const name of names) {
      const entry = sourceEntry(source, name)
      if (entry === undefined || isUnset(entry.value, field.type)) continue
      found = true
      const result = coerceConfigValue(entry.value, field.type, { enum: field.enum, secret })
      if (result.ok) values.set(field.property, result.value)
      else problems.push({ ...base, kind: 'invalid', message: result.message, name, origin: entry.origin })
      break
    }
    if (found) continue
    if (Object.hasOwn(field, 'default') && !isUnset(field.default, field.type)) {
      const result = coerceConfigValue(field.default, field.type, { enum: field.enum, secret })
      if (result.ok) values.set(field.property, result.value)
      else {
        problems.push({
          ...base,
          kind: 'invalid',
          message: `invalid default value: ${result.message}`,
          name: DEFAULT_ORIGIN,
          origin: DEFAULT_ORIGIN,
        })
      }
      continue
    }
    if (hasInitializer(field.property)) continue
    if (field.required === true) problems.push({ ...base, kind: 'missing', message: 'missing required value' })
  }
  return { values, problems }
}
