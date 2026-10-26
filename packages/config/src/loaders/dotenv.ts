import type { ConfigLayer } from '../source.ts'
import type { ConfigLoader } from './types.ts'

import { parseEnv } from 'node:util'

import { ConfigLoaderError, invalidConfig } from '../errors.ts'
import { readOptionalFile, resolveFile } from './shared.ts'

/** Options of {@link dotenv}. */
export interface DotenvLoaderOptions {
  /**
   * Files to load, in precedence order (later files override earlier ones), relative to the
   * loader `cwd`. Default: the conventional files, see {@link dotenvFiles}.
   */
  readonly path?: string | readonly string[]
  /** Mode used to pick the conventional files. Default: `NODE_ENV`. */
  readonly nodeEnv?: string
  /**
   * Whether missing files are skipped. Default: `true` for the conventional files, `false` for an
   * explicit `path` (a missing file is an error).
   */
  readonly optional?: boolean
  /**
   * Also write the loaded variables to `process.env` (for libraries reading it directly), without
   * replacing variables that already exist. Default: `false` (`process.env` is left untouched).
   */
  readonly populate?: boolean
  /**
   * Write the loaded variables to `process.env`, replacing existing variables (implies `populate`):
   * the files then win over the real environment. Default: `false`.
   */
  readonly override?: boolean
}

/**
 * Conventional `.env` files for a mode, from the lowest to the highest precedence:
 * `.env`, `.env.local` (not in `test`, so tests are reproducible), `.env.<mode>`,
 * `.env.<mode>.local`.
 */
export function dotenvFiles(nodeEnv: string | undefined): string[] {
  const files = ['.env']
  if (nodeEnv !== 'test') files.push('.env.local')
  if (nodeEnv !== undefined && nodeEnv !== '') files.push(`.env.${nodeEnv}`, `.env.${nodeEnv}.local`)
  return files
}

/**
 * Loads `.env` files with the `node:util` `parseEnv` parser (comments, quotes, multi-line values,
 * `export` prefixes). Each file is a layer: later files override earlier ones and the environment
 * loaded after them (`env()`) overrides both. Variables are not expanded (`${OTHER}` stays as is).
 *
 * ```ts
 * dotenv() // .env, .env.local, .env.<NODE_ENV>, .env.<NODE_ENV>.local
 * dotenv({ path: ['config/.env', 'config/.env.secret'] })
 * ```
 */
export function dotenv(options: DotenvLoaderOptions = {}): ConfigLoader {
  const explicit = options.path === undefined ? undefined : [options.path].flat()
  if (explicit?.some(path => typeof path !== 'string' || path === '')) {
    throw invalidConfig('dotenv(): "path" must be a non-empty string or an array of them')
  }
  return {
    name: 'dotenv',
    async load(context) {
      const files = explicit ?? dotenvFiles(options.nodeEnv ?? context.env['NODE_ENV'])
      const optional = options.optional ?? explicit === undefined
      const layers: ConfigLayer[] = []
      for (const path of files) {
        const text = await readOptionalFile('dotenv', resolveFile(context, path), path)
        if (text === undefined) {
          if (optional) continue
          throw new ConfigLoaderError('dotenv', `file not found: ${resolveFile(context, path)}`, {
            hints: ['Create the file or pass { optional: true } to dotenv()'],
          })
        }
        const values: Record<string, string> = {}
        for (const [name, value] of Object.entries(parseEnv(text))) if (value !== undefined) values[name] = value
        layers.push({ origin: path, values })
      }
      if (options.populate === true || options.override === true) {
        const merged = Object.assign({}, ...layers.map(layer => layer.values)) as Record<string, string>
        const existing = new Set(Object.keys(context.env).filter(name => context.env[name] !== undefined))
        for (const [name, value] of Object.entries(merged)) {
          if (options.override === true || !existing.has(name)) context.env[name] = value
        }
      }
      return layers
    },
  }
}
