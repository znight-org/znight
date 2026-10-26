import type { ConfigLoader } from './types.ts'

import { invalidConfig } from '../errors.ts'
import { warnBunLoadedDotenv } from './bun.ts'

/** Options of {@link env}. */
export interface EnvLoaderOptions {
  /**
   * Only read variables starting with `prefix`, without the prefix: with `prefix: 'APP_'`,
   * `APP_DB_HOST` is read as `DB_HOST` and `DB_HOST` itself is ignored.
   */
  readonly prefix?: string
  /** Keep the prefix in the variable names (only filter). Default: `false`. */
  readonly keepPrefix?: boolean
  /** Variables to read instead of the context environment (`process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Loads a snapshot of the environment variables (`process.env`), taken when the loader runs.
 *
 * On Bun, `process.env` also holds the `.env` files Bun loads automatically at startup (with its own
 * precedence and `${VAR}` expansion): `env()` then emits a warning (`ZnightWarning`, once per
 * process) recommending to disable that loading (`env = false` in `bunfig.toml`, `bun --no-env-file`)
 * and to let `dotenv()` load the files. `env({ env: process.env })` reads `process.env` as is,
 * without the check.
 *
 * ```ts
 * ConfigPlugin.configure({ loaders: [dotenv(), env({ prefix: 'APP_' })] })
 * ```
 */
export function env(options: EnvLoaderOptions = {}): ConfigLoader {
  const prefix = options.prefix ?? ''
  if (typeof prefix !== 'string') throw invalidConfig('env(): "prefix" must be a string')
  return {
    name: 'env',
    load(context) {
      const variables = options.env ?? context.env
      if (options.env === undefined) warnBunLoadedDotenv(variables)
      const values: Record<string, string> = {}
      for (const [name, value] of Object.entries(variables)) {
        if (typeof value !== 'string' || !name.startsWith(prefix)) continue
        const key = options.keepPrefix === true ? name : name.slice(prefix.length)
        if (key !== '') values[key] = value
      }
      const base = options.env === undefined ? 'process.env' : 'environment'
      return { origin: prefix === '' ? base : `${base} (prefix ${prefix})`, values }
    },
  }
}
