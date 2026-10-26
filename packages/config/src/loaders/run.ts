/** Runs loaders in order and assembles their layers into a {@link ConfigSource}. */
import type { ConfigLayer, ConfigSource } from '../source.ts'
import type { ConfigLoader, ConfigLoaderResult } from './types.ts'

import { ZnightError } from '@znight/core'

import { ConfigLoaderError, errorMessage, invalidConfig } from '../errors.ts'
import { createConfigSource } from '../source.ts'

/** Options of {@link loadConfigSource}. */
export interface LoadConfigSourceOptions {
  /** Base directory of relative file paths. Default: `process.cwd()`. */
  readonly cwd?: string
  /** Process environment given to the loaders. Default: `process.env`. */
  readonly env?: Record<string, string | undefined>
}

/**
 * Checks that `loaders` is a list of {@link ConfigLoader}s.
 *
 * @throws ZnightError (ZNIGHT012) otherwise.
 */
export function assertLoaders(loaders: readonly ConfigLoader[]): void {
  if (!Array.isArray(loaders)) throw invalidConfig('Config loaders must be an array of ConfigLoader')
  for (const [index, loader] of loaders.entries()) {
    if (
      typeof loader !== 'object' ||
      loader === null ||
      typeof loader.name !== 'string' ||
      typeof loader.load !== 'function'
    ) {
      throw invalidConfig(`Config loader #${index} must be an object with a "name" and a "load(context)" method`, [
        'Use the built-in loaders (env(), dotenv(), json(), yaml(), vault(), awsSecretsManager()) or implement ConfigLoader',
      ])
    }
  }
}

function normalizeLayers(loader: ConfigLoader, result: ConfigLoaderResult): ConfigLayer[] {
  if (result === undefined || result === null) return []
  const layers = Array.isArray(result) ? (result as readonly ConfigLayer[]) : [result as ConfigLayer]
  for (const layer of layers) {
    if (
      typeof layer !== 'object' ||
      layer === null ||
      typeof layer.origin !== 'string' ||
      typeof layer.values !== 'object' ||
      layer.values === null ||
      Array.isArray(layer.values)
    ) {
      throw new ConfigLoaderError(
        loader.name,
        'load() must return { origin: string, values: object }, an array of them or undefined',
      )
    }
  }
  return [...layers]
}

/**
 * Runs `loaders` in order (each one sees the values loaded before it) and returns the resulting
 * {@link ConfigSource}: values of later loaders override earlier ones.
 *
 * ```ts
 * const source = await loadConfigSource([dotenv(), env()])
 * source.get('DATABASE_URL')
 * ```
 *
 * @throws ConfigLoaderError (ZNIGHT006) when a loader fails (other errors are wrapped, `cause` kept).
 */
export async function loadConfigSource(
  loaders: readonly ConfigLoader[],
  options: LoadConfigSourceOptions = {},
): Promise<ConfigSource> {
  assertLoaders(loaders)
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const layers: ConfigLayer[] = []
  for (const loader of loaders) {
    let result: ConfigLoaderResult
    try {
      result = await loader.load({ cwd, env, source: createConfigSource(layers) })
    } catch (error) {
      if (error instanceof ZnightError) throw error
      throw new ConfigLoaderError(loader.name, errorMessage(error), { cause: error })
    }
    layers.push(...normalizeLayers(loader, result))
  }
  return createConfigSource(layers)
}
