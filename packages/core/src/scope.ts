import type { Token } from './metadata.ts'
import type { ProviderKey } from './tokens.ts'

/**
 * The values of the active request scope (see `Container.runInScope`). Keys are tokens (aliases and
 * classes known to the container are accepted and normalised). Holds the seed values passed to
 * `runInScope` and the request-scoped instances created in the scope.
 */
export interface ScopeContext {
  /** The value stored for `key` in this scope, without creating anything. */
  get<T = unknown>(key: ProviderKey<T>): T | undefined
  /** Whether a value is stored for `key` in this scope. */
  has(key: ProviderKey): boolean
  /** Stores a value for `key`: request-scoped resolutions of `key` return it from now on. */
  set<T>(key: ProviderKey<T>, value: T): void
  /** `true` once the `runInScope` callback has settled and the scope instances were disposed. */
  readonly closed: boolean
}

/** A request-scoped instance created by the container, disposed when its scope closes. */
export interface ScopedInstance {
  readonly token: Token
  readonly instance: unknown
  readonly dispose: string | undefined
}

/** Implementation of {@link ScopeContext} used by the container (internal). */
export class RequestScope implements ScopeContext {
  readonly created: ScopedInstance[] = []
  closed = false
  readonly #canonical: (key: ProviderKey) => Token
  #values: Map<Token, unknown> | undefined
  /** Seed values not yet in {@link values}: canonical tokens and values, alternately. */
  #seeds: readonly unknown[] | undefined

  /** `seeds`: canonical tokens and their values, alternately (copied into {@link values} on first use). */
  constructor(canonical: (key: ProviderKey) => Token, seeds?: readonly unknown[]) {
    this.#canonical = canonical
    this.#seeds = seeds
  }

  /** The values of the scope by canonical token: the seeds, then what was set or created in it. */
  get values(): Map<Token, unknown> {
    let values = this.#values
    if (values === undefined) {
      values = new Map()
      const seeds = this.#seeds
      if (seeds !== undefined) {
        for (let index = 0; index < seeds.length; index += 2) values.set(seeds[index] as Token, seeds[index + 1])
        this.#seeds = undefined
      }
      this.#values = values
    }
    return values
  }

  get<T = unknown>(key: ProviderKey<T>): T | undefined {
    return this.values.get(this.#canonical(key)) as T | undefined
  }

  has(key: ProviderKey): boolean {
    return this.values.has(this.#canonical(key))
  }

  set<T>(key: ProviderKey<T>, value: T): void {
    this.values.set(this.#canonical(key), value)
  }
}
