/**
 * Naming conventions and identifiers shared by the runtime and the compiler extension
 * (`@znight/config/compiler`). This module has no imports so the compiler extension can use it
 * without loading the runtime entry.
 */

/** Token of the `ConfigSource` external registered by `ConfigPlugin`. */
export const CONFIG_SOURCE_TOKEN = '@znight/config#ConfigSource'

/** Name of the plugin (`ConfigPlugin`) and key of the config section in `metadata.extensions`. */
export const CONFIG_EXTENSION_NAME = 'config'

/** Replacement of secret values in `JSON.stringify`, `util.inspect`, `toString` and error messages. */
export const SECRET_MASK = '[REDACTED]'

/**
 * Converts an identifier to `CONSTANT_CASE`: `databaseUrl` → `DATABASE_URL`, `HTTPPort` →
 * `HTTP_PORT`, `apiKeyV2` → `API_KEY_V2`, `my-app.db` → `MY_APP_DB`.
 */
export function constantCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}

/**
 * Environment variable read for a property without `@Env`/`@Secret` name:
 * `CONSTANT_CASE(prefix)_CONSTANT_CASE(property)`, or `CONSTANT_CASE(property)` without prefix.
 *
 * ```ts
 * defaultEnvName('database', 'maxConnections') // 'DATABASE_MAX_CONNECTIONS'
 * defaultEnvName(undefined, 'port') // 'PORT'
 * ```
 */
export function defaultEnvName(prefix: string | undefined, property: string): string {
  const name = constantCase(property)
  const scope = prefix === undefined ? '' : constantCase(prefix)
  return scope === '' ? name : `${scope}_${name}`
}

/**
 * Key path read in structured sources (JSON/YAML files, Vault, AWS secrets) for a property without
 * `@Key`: `<prefix>.<property>`, or `<property>` without prefix.
 *
 * ```ts
 * defaultKeyPath('database', 'maxConnections') // 'database.maxConnections'
 * ```
 */
export function defaultKeyPath(prefix: string | undefined, property: string): string {
  return prefix === undefined || prefix === '' ? property : `${prefix}.${property}`
}
