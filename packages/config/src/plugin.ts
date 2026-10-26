import type { Plugin, PluginContext } from '@znight/core'
import type { ConfigLoader } from './loaders/types.ts'
import type { ConfigSource } from './source.ts'

import { CONFIG_EXTENSION_NAME } from './conventions.ts'
import { configDefinitions, validateConfigs } from './load.ts'
import { dotenv } from './loaders/dotenv.ts'
import { env } from './loaders/env.ts'
import { assertLoaders, loadConfigSource } from './loaders/run.ts'
import { ConfigTokens } from './tokens.ts'

/** Options of {@link ConfigPlugin.configure}. */
export interface ConfigPluginOptions {
  /**
   * Loaders run in order; values of later loaders override earlier ones.
   * Default: `[dotenv(), env()]` (the environment wins over `.env` files).
   */
  readonly loaders?: readonly ConfigLoader[]
  /** Base directory of relative file paths. Default: `process.cwd()`. */
  readonly cwd?: string
  /** Process environment given to the loaders. Default: `process.env`. */
  readonly env?: Record<string, string | undefined>
  /**
   * Validate every config class of the metadata in `register()` and report all problems at once.
   * Default: `true`. When `false`, each config class still fails on its own when it is created.
   */
  readonly validate?: boolean
}

/** The plugin instance returned by {@link ConfigPlugin.configure}. */
export interface ConfigPluginInstance extends Plugin {
  readonly name: 'config'
  /** The source built by `register()` (`undefined` before). */
  readonly source: ConfigSource | undefined
}

/**
 * Loads the configuration and validates every config class before any provider is created.
 *
 * `register()` runs the loaders in order, registers the resulting source as the
 * `@znight/config#ConfigSource` external (injected into config class factories), then validates
 * every class of `metadata.extensions.config` and throws one `ConfigValidationError` (ZNIGHT006)
 * listing every missing or invalid value.
 *
 * ```ts
 * const app = await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [ConfigPlugin.configure({ loaders: [dotenv(), env(), vault({ path: 'secret/app' })] })],
 * })
 * ```
 */
export const ConfigPlugin: {
  readonly name: 'config'
  configure(options?: ConfigPluginOptions): ConfigPluginInstance
} = Object.freeze({
  name: CONFIG_EXTENSION_NAME,
  configure(options: ConfigPluginOptions = {}): ConfigPluginInstance {
    const loaders = options.loaders ?? [dotenv(), env()]
    assertLoaders(loaders)
    let source: ConfigSource | undefined
    return {
      name: CONFIG_EXTENSION_NAME,
      get source(): ConfigSource | undefined {
        return source
      },
      async register(ctx: PluginContext): Promise<void> {
        const started = performance.now()
        const loaded = await loadConfigSource(loaders, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
        })
        source = loaded
        ctx.container.registerValue(ConfigTokens.Source, loaded)
        if (options.validate !== false) validateConfigs(ctx.metadata, loaded)
        ctx.logger.debug('Configuration loaded', {
          sources: loaded.describe?.(),
          configs: configDefinitions(ctx.metadata).length,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        })
      },
    }
  },
} as const)
