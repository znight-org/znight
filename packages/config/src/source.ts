/**
 * Configuration sources: a {@link ConfigSource} answers "what is the raw value of this key, and where
 * does it come from?". `ConfigPlugin` builds one from its loaders ({@link createConfigSource}) and
 * registers it as the `@znight/config#ConfigSource` external.
 */
import { inspect } from 'node:util'

import { SECRET_MASK } from './conventions.ts'

/**
 * Raw configuration values, as loaded: strings from the environment and `.env` files, structured
 * values (numbers, booleans, arrays, objects) from JSON/YAML files and secret stores.
 *
 * Keys are environment variable names (`DB_HOST`) or key paths (`database.host`). Key paths are
 * resolved against nested objects (`{ database: { host } }`) and flat dotted keys
 * (`{ 'database.host': ... }`) alike.
 */
export interface ConfigSource {
  /** Raw value of `key` (string or structured value), `undefined` when no layer defines it. */
  get(key: string): unknown
  /** Whether a value (other than `undefined` / `null`) is defined for `key`. */
  has(key: string): boolean
  /** Every key known by the source (environment names and key paths), without duplicates. */
  keys(): readonly string[]
  /** Where the value of `key` comes from (`process.env`, `.env.local`, `vault:secret/app`...). */
  origin(key: string): string | undefined
  /** Short description of the source for error hints (e.g. `.env < .env.local < process.env`). */
  describe?(): string
}

/** A set of values loaded from one place, see {@link ConfigLoader}. */
export interface ConfigLayer {
  /** Where the values come from, shown in error messages: `process.env`, `.env.local`, `vault:secret/app`. */
  readonly origin: string
  /** Flat (`{ DB_HOST, 'database.host' }`) and/or nested (`{ database: { host } }`) values. */
  readonly values: Readonly<Record<string, unknown>>
}

/** A value found in a source, with its origin. */
export interface ConfigEntry {
  readonly value: unknown
  readonly origin: string
}

type RecordLike = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Looks `key` up in `values`: an own property named `key` first, then a path walk where each step
 * may consume one or several dot-separated segments (`{ 'a.b': { c } }` matches `a.b.c`), longest
 * first. Returns `undefined` when nothing matches.
 */
export function lookupPath(values: RecordLike, key: string): unknown {
  if (Object.hasOwn(values, key)) return values[key]
  if (!key.includes('.')) return undefined
  return walk(values, key.split('.'), 0)
}

function walk(node: unknown, segments: readonly string[], start: number): unknown {
  if (!isRecord(node)) return undefined
  for (let end = segments.length; end > start; end--) {
    const name = segments.slice(start, end).join('.')
    if (!Object.hasOwn(node, name)) continue
    const child = node[name]
    if (end === segments.length) return child
    const found = walk(child, segments, end)
    if (found !== undefined) return found
  }
  return undefined
}

function collectKeys(values: RecordLike, prefix: string, out: Set<string>, depth: number): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue
    const path = prefix === '' ? name : `${prefix}.${name}`
    out.add(path)
    // bounded depth: guards against cyclic structures supplied by custom loaders
    if (isRecord(value) && depth < 32) collectKeys(value, path, out, depth + 1)
  }
}

/**
 * Nests `values` under the key path `key` (`'database'` → `{ database: values }`). Returns `values`
 * unchanged when `key` is `undefined` or empty.
 */
export function nestUnder(values: unknown, key: string | undefined): Readonly<Record<string, unknown>> {
  if (key === undefined || key === '') return isRecord(values) ? values : {}
  return { [key]: values }
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/** The {@link ConfigSource} built from {@link ConfigLayer}s: later layers override earlier ones. */
class LayeredConfigSource implements ConfigSource {
  readonly #layers: readonly ConfigLayer[]

  constructor(layers: readonly ConfigLayer[]) {
    this.#layers = layers
  }

  /** Origins of the layers, from the lowest to the highest precedence. */
  get origins(): readonly string[] {
    return this.#layers.map(layer => layer.origin)
  }

  entry(key: string): ConfigEntry | undefined {
    for (let index = this.#layers.length - 1; index >= 0; index--) {
      const layer = this.#layers[index] as ConfigLayer
      const value = lookupPath(layer.values, key)
      if (value !== undefined && value !== null) return { value, origin: layer.origin }
    }
    return undefined
  }

  get(key: string): unknown {
    return this.entry(key)?.value
  }

  has(key: string): boolean {
    return this.entry(key) !== undefined
  }

  origin(key: string): string | undefined {
    return this.entry(key)?.origin
  }

  keys(): readonly string[] {
    const keys = new Set<string>()
    for (const layer of this.#layers) collectKeys(layer.values, '', keys, 0)
    return [...keys]
  }

  describe(): string {
    return this.#layers.length === 0 ? 'no configuration source' : this.origins.join(' < ')
  }

  /** Never exposes values (they may be secrets). */
  toJSON(): { origins: readonly string[]; keys: number } {
    return { origins: this.origins, keys: this.keys().length }
  }

  toString(): string {
    return `ConfigSource(${this.describe()})`
  }

  [INSPECT](): string {
    return `ConfigSource { origins: ${inspect(this.origins)}, values: ${SECRET_MASK} }`
  }
}

/**
 * Creates a {@link ConfigSource} from layers ordered from the lowest to the highest precedence: the
 * value of a key comes from the last layer defining it (`undefined` and `null` count as undefined).
 *
 * ```ts
 * const source = createConfigSource([
 *   { origin: 'defaults', values: { PORT: '3000' } },
 *   { origin: 'process.env', values: { ...process.env } },
 * ])
 * ```
 */
export function createConfigSource(layers: Iterable<ConfigLayer>): ConfigSource {
  return new LayeredConfigSource([...layers])
}

/** A {@link ConfigSource} over a snapshot of `env` (default `process.env`), with origin `process.env`. */
export function envSource(env: Readonly<Record<string, string | undefined>> = process.env): ConfigSource {
  return createConfigSource([{ origin: 'process.env', values: snapshotEnv(env) }])
}

/** Copies the defined entries of an environment object. */
export function snapshotEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (typeof value === 'string') values[name] = value
  return values
}

/** Looks up a value and its origin in any {@link ConfigSource}. */
export function sourceEntry(source: ConfigSource, key: string): ConfigEntry | undefined {
  if (source instanceof LayeredConfigSource) return source.entry(key)
  const value = source.get(key)
  if (value === undefined || value === null) return undefined
  return { value, origin: source.origin(key) ?? 'config source' }
}
