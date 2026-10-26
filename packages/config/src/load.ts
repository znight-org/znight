/**
 * Entry points of generated code: {@link loadConfig} (factory of every config class provider) and
 * {@link validateConfigs} (aggregated validation run by `ConfigPlugin.register`).
 */
import type { ZnightMetadata } from '@znight/core'
import type { ConfigProblem } from './errors.ts'
import type { ConfigClassDefinition, ConfigFieldDefinition } from './metadata.ts'
import type { ConfigSource } from './source.ts'

import { displayName } from '@znight/core'

import { ConfigValidationError, invalidConfig } from './errors.ts'
import { resolveFields } from './resolve.ts'
import { maskSecrets } from './secrets.ts'
import { envSource } from './source.ts'

/** A config class: instantiated without constructor arguments. */
export type ConfigClass<T extends object = object> = new () => T

/** Options of {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Name of the class in error messages. Default: `ConfigClass.name`. */
  readonly name?: string
  /** Environment read when `source` is `undefined` (no `ConfigPlugin`). Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const NO_PLUGIN_HINT =
  'No ConfigSource is registered: values were read from process.env only. Add ConfigPlugin.configure() to Application.create({ plugins }) to load .env files and other sources'

function sourceHints(source: ConfigSource): string[] {
  const hints = ['Set the missing variables in the environment or in a .env file']
  const description = source.describe?.()
  if (description !== undefined) hints.push(`Configuration sources (lowest to highest precedence): ${description}`)
  return hints
}

/**
 * Creates and fills an instance of a config class. Called by the factory the compiler generates for
 * every `@Config` class:
 *
 * ```ts
 * factory: d => loadConfig(DatabaseConfig, d[0], fields) // d[0]: the ConfigSource, or undefined
 * ```
 *
 * The class is instantiated without arguments (initializers run), then every field is resolved
 * (see {@link resolveFields}: environment name, key path, `@Default`, initializer), coerced, checked
 * against its `enum` and assigned. Secret properties are masked in `JSON.stringify`,
 * `util.inspect` and `toString()`. Without `source` (no `ConfigPlugin`), values are read from
 * `process.env` (or `options.env`).
 *
 * @throws ConfigValidationError (ZNIGHT006) listing every missing or invalid value of the class.
 * @throws ZnightError (ZNIGHT012) when a field definition is malformed.
 */
export function loadConfig<T extends object>(
  ConfigClass: ConfigClass<T>,
  source: ConfigSource | undefined,
  fields: readonly ConfigFieldDefinition[],
  options: LoadConfigOptions = {},
): T {
  const name = options.name ?? (ConfigClass.name || 'Config')
  const instance = new ConfigClass()
  const record = instance as Record<string, unknown>
  const effective = source ?? envSource(options.env)
  const { values, problems } = resolveFields(name, fields, effective, property => record[property] !== undefined)
  if (problems.length > 0) {
    const hints = sourceHints(effective)
    if (source === undefined) hints.push(NO_PLUGIN_HINT)
    throw new ConfigValidationError(problems, { hints })
  }
  for (const [property, value] of values) {
    // [[Define]] semantics, like class fields: setters and inherited accessors are bypassed
    Object.defineProperty(instance, property, { value, writable: true, enumerable: true, configurable: true })
  }
  maskSecrets(
    instance,
    fields.filter(field => field.secret === true).map(field => field.property),
  )
  return instance
}

/**
 * The config classes of `metadata.extensions.config` (empty when the application has none).
 *
 * @throws ZnightError (ZNIGHT012) when the section is malformed.
 */
export function configDefinitions(metadata: Pick<ZnightMetadata, 'extensions'>): readonly ConfigClassDefinition[] {
  const section = metadata.extensions?.config
  if (section === undefined) return []
  if (typeof section !== 'object' || section === null || !Array.isArray(section.configs)) {
    throw invalidConfig('Invalid metadata.extensions.config: expected { configs: [...] }', [
      'Regenerate the container (znight generate) with matching @znight/compiler and @znight/config versions',
    ])
  }
  for (const config of section.configs) {
    if (typeof config !== 'object' || config === null || typeof config.token !== 'string') {
      throw invalidConfig('Invalid metadata.extensions.config: every config needs a token and fields')
    }
  }
  return section.configs
}

/**
 * Validates every config class of `metadata` against `source` at once, without instantiating them.
 * Run by `ConfigPlugin.register` so all problems of the application are reported in one error,
 * before any provider is created.
 *
 * @throws ConfigValidationError (ZNIGHT006) listing every missing or invalid value.
 * @throws ZnightError (ZNIGHT012) when the config metadata is malformed.
 */
export function validateConfigs(metadata: Pick<ZnightMetadata, 'extensions'>, source: ConfigSource): void {
  const configs = configDefinitions(metadata)
  const counts = new Map<string, number>()
  for (const config of configs) counts.set(displayName(config.token), (counts.get(displayName(config.token)) ?? 0) + 1)
  const problems: ConfigProblem[] = []
  for (const config of configs) {
    const short = displayName(config.token)
    const name = (counts.get(short) ?? 0) > 1 ? config.token : short
    problems.push(...resolveFields(name, config.fields, source).problems)
  }
  if (problems.length > 0) throw new ConfigValidationError(problems, { hints: sourceHints(source) })
}
