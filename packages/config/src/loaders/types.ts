import type { ConfigLayer, ConfigSource } from '../source.ts'

/** What a {@link ConfigLoader} receives. */
export interface ConfigLoaderContext {
  /** Base directory of relative file paths (`ConfigPlugin` option `cwd`, default `process.cwd()`). */
  readonly cwd: string
  /**
   * The process environment (`process.env` unless overridden). Loaders may write to it, e.g.
   * `dotenv({ populate: true })`.
   */
  readonly env: Record<string, string | undefined>
  /**
   * Values loaded by the previous loaders: a loader can read its own settings from them
   * (`vault()` reads `VAULT_ADDR`/`VAULT_TOKEN` loaded from a `.env` file).
   */
  readonly source: ConfigSource
}

/** What {@link ConfigLoader.load} returns: one layer, several (in precedence order) or nothing. */
export type ConfigLoaderResult = ConfigLayer | readonly ConfigLayer[] | undefined

/**
 * Loads configuration values from one place. Loaders run in order and later loaders override
 * earlier ones. A custom loader is a plain object:
 *
 * ```ts
 * const consul: ConfigLoader = {
 *   name: 'consul',
 *   async load({ source }) {
 *     const response = await fetch(`${source.get('CONSUL_URL')}/v1/kv/app?raw`)
 *     return { origin: 'consul:app', values: await response.json() }
 *   },
 * }
 * ```
 *
 * Throw (any error) to abort the application start: `ConfigPlugin` wraps it in a
 * `ConfigLoaderError` naming the loader.
 */
export interface ConfigLoader {
  /** Name used in error messages and logs (`env`, `dotenv`, `vault`...). */
  readonly name: string
  load(context: ConfigLoaderContext): ConfigLoaderResult | Promise<ConfigLoaderResult>
}
