/**
 * Loaders (RFC 0005 §5.5, §8.6): the DataLoader of a `BatchLoad` provider for one execution, and
 * `orderByKeys()`.
 *
 * The registry of an execution (`Map<token, DataLoader>`) lives in its `GraphQLContext` and is
 * created on the first `loader()` call: operations that use no loader allocate nothing.
 */
import type { Container, Token } from '@znight/core'
import type { BatchLoad, BatchLoader, LoaderOptions } from './types.ts'

import { ErrorCode, ZnightError } from '@znight/core'
import DataLoader from 'dataloader'

import { GraphQLErrorCode, GraphQLException } from './errors.ts'

/** DataLoader options of a loader class, read once. */
type ResolvedLoaderOptions = DataLoader.Options<unknown, unknown, unknown>

/**
 * Creates the per-execution DataLoaders of loader providers: the provider is resolved in the
 * current scope (loaders may be request-scoped), its `options` are read once per token.
 */
export class LoaderFactory {
  readonly #container: Container
  readonly #options = new Map<Token, ResolvedLoaderOptions>()

  constructor(container: Container) {
    this.#container = container
  }

  /** A new DataLoader for the loader provider `token`, bound to the instance of the current scope. */
  create(token: Token): BatchLoader<unknown, unknown> {
    const provider = this.#container.get(token) as Partial<BatchLoad<unknown, unknown>> | undefined
    if (provider === null || typeof provider !== 'object' || typeof provider.load !== 'function') {
      throw new ZnightError(
        ErrorCode.InvalidLoader,
        `The loader ${token} does not implement BatchLoad (no load(keys) method)`,
        { hints: ['A loader is a provider implementing BatchLoad<K, V>: async load(keys) { ... }'] },
      )
    }
    let options = this.#options.get(token)
    if (options === undefined) {
      options = readOptions(token, provider.options)
      this.#options.set(token, options)
    }
    return new DataLoader<unknown, unknown, unknown>(
      keys => loadBatch(token, keys, provider as BatchLoad<unknown, unknown>),
      options,
    ) as BatchLoader<unknown, unknown>
  }
}

/**
 * The values of a batch, or ZNIGHT065 (failing every key) when there is not one value per key.
 * `async` so that a `load()` throwing synchronously rejects with its own error (DataLoader would
 * replace it with a TypeError).
 */
async function loadBatch(
  token: Token,
  keys: readonly unknown[],
  provider: BatchLoad<unknown, unknown>,
): Promise<readonly unknown[]> {
  const values: unknown = await provider.load(keys)
  if (Array.isArray(values) && values.length === keys.length) return values
  throw new ZnightError(
    ErrorCode.InvalidLoader,
    `The loader ${token} returned ${Array.isArray(values) ? `${values.length} values` : 'no array'} for ${keys.length} keys`,
    { hints: ['load(keys) returns one value (or Error) per key, in the order of the keys: use orderByKeys()'] },
  )
}

function readOptions(token: Token, options: LoaderOptions | undefined): ResolvedLoaderOptions {
  if (options === undefined) return {}
  const invalid = (reason: string): ZnightError =>
    new ZnightError(ErrorCode.InvalidLoader, `Invalid options of the loader ${token}: ${reason}`, {
      hints: ['options: { maxBatchSize?: positive integer, cache?: boolean, cacheKeyFn?: (key) => unknown }'],
    })
  if (options === null || typeof options !== 'object') throw invalid('expected an object')
  const { maxBatchSize, cache, cacheKeyFn } = options
  if (maxBatchSize !== undefined && !(Number.isSafeInteger(maxBatchSize) && maxBatchSize >= 1)) {
    throw invalid(`maxBatchSize must be a positive integer (received ${String(maxBatchSize)})`)
  }
  if (cache !== undefined && typeof cache !== 'boolean') throw invalid('cache must be a boolean')
  if (cacheKeyFn !== undefined && typeof cacheKeyFn !== 'function') throw invalid('cacheKeyFn must be a function')
  return {
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
    ...(cache === undefined ? {} : { cache }),
    ...(cacheKeyFn === undefined ? {} : { cacheKeyFn: (key: unknown) => cacheKeyFn.call(options, key) }),
  }
}

/** Options of {@link orderByKeys}. */
export interface OrderByKeysOptions {
  /**
   * What a key without value gets: `'error'` (default) a `NOT_FOUND` `GraphQLException` failing that
   * key only, `'null'` the value `null`.
   */
  readonly missing?: 'error' | 'null'
}

/**
 * Reorders `values` (rows in any order, some keys possibly missing) to match `keys`, what a
 * `BatchLoad.load()` must return. Keys are compared with `Map` semantics (`===`, `NaN` equal).
 *
 * ```ts
 * async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
 *   return orderByKeys(ids, await this.authors.findMany(ids), author => author.id)
 * }
 * ```
 */
export function orderByKeys<K, V>(
  keys: readonly K[],
  values: Iterable<V>,
  keyOf: (value: V) => K,
  options?: OrderByKeysOptions & { readonly missing?: 'error' },
): (V | Error)[]
export function orderByKeys<K, V>(
  keys: readonly K[],
  values: Iterable<V>,
  keyOf: (value: V) => K,
  options: OrderByKeysOptions & { readonly missing: 'null' },
): (V | null)[]
export function orderByKeys<K, V>(
  keys: readonly K[],
  values: Iterable<V>,
  keyOf: (value: V) => K,
  options: OrderByKeysOptions = {},
): (V | Error | null)[] {
  const missing = options.missing ?? 'error'
  if (missing !== 'error' && missing !== 'null') {
    throw new TypeError(`orderByKeys(): missing must be 'error' or 'null' (received ${String(missing)})`)
  }
  const byKey = new Map<K, V>()
  for (const value of values) byKey.set(keyOf(value), value)
  const result: (V | Error | null)[] = new Array(keys.length)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as K
    const value = byKey.get(key)
    if (value !== undefined || byKey.has(key)) result[index] = value as V
    else result[index] = missing === 'null' ? null : notFound(key)
  }
  return result
}

function notFound(key: unknown): GraphQLException {
  return new GraphQLException(`Not found: ${typeof key === 'string' ? key : String(key)}`, {
    code: GraphQLErrorCode.NotFound,
  })
}
