import type { ConfigLoader, ConfigLoaderContext } from './types.ts'

import { ConfigLoaderError, invalidConfig } from '../errors.ts'
import { nestUnder } from '../source.ts'
import { importOptionalPeer, isRecord, readOptionalFile, resolveFile } from './shared.ts'

/** Options of {@link json} and {@link yaml}. */
export interface FileLoaderOptions {
  /** Skip the file when it does not exist. Default: `false` (a missing file is an error). */
  readonly optional?: boolean
  /**
   * Key path under which the file content is mounted: with `key: 'database'`, `{ "host": "x" }` is
   * read as `database.host`. Default: the root (the file must contain an object).
   */
  readonly key?: string
}

type Parse = (text: string) => unknown | Promise<unknown>

function fileLoader(
  name: string,
  format: string,
  path: string,
  options: FileLoaderOptions,
  parse: Parse,
): ConfigLoader {
  if (typeof path !== 'string' || path === '') {
    throw invalidConfig(`${name}(): the file path must be a non-empty string`)
  }
  return {
    name,
    async load(context: ConfigLoaderContext) {
      const file = resolveFile(context, path)
      const text = await readOptionalFile(name, file, path)
      if (text === undefined) {
        if (options.optional === true) return undefined
        throw new ConfigLoaderError(name, `file not found: ${file}`, {
          hints: [`Create the file or pass { optional: true } to ${name}()`],
        })
      }
      let content: unknown
      try {
        content = await parse(text)
      } catch (error) {
        if (error instanceof ConfigLoaderError) throw error
        throw new ConfigLoaderError(name, `invalid ${format} in ${path}: ${(error as Error).message}`, { cause: error })
      }
      if (content === undefined || content === null) return { origin: path, values: {} }
      if (options.key === undefined && !isRecord(content)) {
        throw new ConfigLoaderError(name, `${path} must contain an object at the root (or pass { key } to mount it)`)
      }
      return { origin: path, values: nestUnder(content, options.key) }
    },
  }
}

/**
 * Loads a JSON file. Nested objects are read with key paths (`{ "database": { "host": "x" } }` →
 * `database.host`) and top-level names can match environment names (`{ "DB_HOST": "x" }`).
 *
 * ```ts
 * ConfigPlugin.configure({ loaders: [json('config/app.json'), dotenv(), env()] })
 * ```
 */
export function json(path: string, options: FileLoaderOptions = {}): ConfigLoader {
  return fileLoader('json', 'JSON', path, options, text => JSON.parse(text) as unknown)
}

interface YamlModule {
  parse(text: string): unknown
}

/**
 * Loads a YAML file, like {@link json}. Requires the optional peer dependency `yaml` (`bun add yaml`),
 * imported only when the loader runs.
 */
export function yaml(path: string, options: FileLoaderOptions = {}): ConfigLoader {
  return fileLoader('yaml', 'YAML', path, options, async text => {
    const module = await importOptionalPeer<YamlModule>('yaml', 'yaml')
    return module.parse(text)
  })
}
