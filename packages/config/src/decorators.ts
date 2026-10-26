/**
 * Config marker decorators. Like every Znight decorator they do nothing at runtime: the compiler
 * extension reads them from the AST and generates the field definitions consumed by
 * {@link loadConfig}. Arguments must be statically evaluable (literals, `const` references...).
 *
 * They support TypeScript `experimentalDecorators` and standard decorators.
 */
import type { ClassMarker } from '@znight/core'

/** Marker usable on a class property. */
export type PropertyMarker = (
  target: object | undefined,
  propertyKeyOrContext: string | symbol | ClassFieldDecoratorContext,
) => void

/** A default value accepted by {@link Default}: any JSON-like literal (coerced like a source value). */
export type ConfigDefaultValue =
  | string
  | number
  | boolean
  | null
  | readonly ConfigDefaultValue[]
  | { readonly [key: string]: ConfigDefaultValue }

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const classMarker: ClassMarker = marker
const propertyMarker: PropertyMarker = marker

/**
 * Declares a config class: a singleton provider whose properties are loaded from the configuration
 * sources (environment, `.env` files, JSON/YAML files, Vault, AWS Secrets Manager...).
 *
 * `prefix` (static) namespaces the default variable names (`DATABASE_HOST`) and key paths
 * (`database.host`) of the properties.
 *
 * ```ts
 * @Config('database')
 * export class DatabaseConfig {
 *   host = 'localhost' // DATABASE_HOST or database.host, default 'localhost'
 *   @Env('DB_PORT') port = 5432
 *   @Secret('DB_PASSWORD') password!: string
 * }
 * ```
 */
export function Config(_prefix?: string): ClassMarker {
  return classMarker
}

/**
 * Reads the property from the environment variable `name` (static) instead of the default
 * `PREFIX_PROPERTY` name.
 */
export function Env(_name: string): PropertyMarker {
  return propertyMarker
}

/**
 * Marks the property as a secret: its value is replaced by `[REDACTED]` in `JSON.stringify`,
 * `util.inspect`/`console.log`, `toString()` and error messages. `name` (static) is the environment
 * variable to read, like {@link Env}; without it the `@Env` name or the default name is used.
 */
export function Secret(_name?: string): PropertyMarker {
  return propertyMarker
}

/**
 * Default value used when no source defines the property. A literal initializer
 * (`port = 5432`) works too. The value (static) is coerced like a source value, so
 * `@Default('https://example.com') url!: URL` produces a `URL`.
 */
export function Default(_value: ConfigDefaultValue): PropertyMarker {
  return propertyMarker
}

/**
 * Key path (static) of the property in structured sources (JSON/YAML files, Vault, AWS secrets),
 * instead of the default `<prefix>.<property>`.
 *
 * ```ts
 * @Key('db.primary.host') host!: string
 * ```
 */
export function Key(_path: string): PropertyMarker {
  return propertyMarker
}
