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
  readonly values: Map<Token, unknown> = new Map()
  readonly created: ScopedInstance[] = []
  closed = false
  readonly #canonical: (key: ProviderKey) => Token

  constructor(canonical: (key: ProviderKey) => Token) {
    this.#canonical = canonical
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
