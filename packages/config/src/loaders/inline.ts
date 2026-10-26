import type { ConfigLoader } from './types.ts'

import { invalidConfig } from '../errors.ts'
import { isRecord } from './shared.ts'

/** Options of {@link inline}. */
export interface InlineLoaderOptions {
  /** Origin shown in error messages. Default: `inline`. */
  readonly name?: string
}

/**
 * Loads fixed values: defaults before the other loaders, or overrides after them (tests, scripts).
 *
 * ```ts
 * ConfigPlugin.configure({ loaders: [inline({ PORT: '3000' }, { name: 'defaults' }), dotenv(), env()] })
 * ```
 */
export function inline(values: Readonly<Record<string, unknown>>, options: InlineLoaderOptions = {}): ConfigLoader {
  if (!isRecord(values)) throw invalidConfig('inline(): values must be an object')
  return {
    name: 'inline',
    load: () => ({ origin: options.name ?? 'inline', values }),
  }
}
