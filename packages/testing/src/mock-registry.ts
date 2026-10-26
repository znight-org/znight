import type { ClassKey, Token, TypedToken } from '@znight/core'
import type { MetadataIndex } from './metadata-index.ts'
import type { DeepMock, Mocked } from './types.ts'

import { describeToken, displayName, ErrorCode, ZnightError } from '@znight/core'

import { clearMock, resetMock } from './mock.ts'
import { describeKey } from './utils.ts'

/**
 * The auto-mocks of a `TestBed`, looked up by class, token, alias or display name.
 *
 * ```ts
 * const { instance, mocks } = await TestBed.create(UserService, { metadata })
 * mocks.get(UserRepository).findById.mockResolvedValue(user) // typed
 * mocks.get('Logger').info // untyped deep mock
 * ```
 */
export interface MockRegistry {
  /**
   * The auto-mock injected for `key`: a class (typed result), a token, an alias (interface, base
   * class) or a unique display name (`'UserRepository'`).
   *
   * @throws ZnightError ZNIGHT001 when no auto-mock matches (the message says why: provided value,
   *   configuration class, optional dependency...), ZNIGHT008 when a display name is ambiguous.
   */
  get<T>(key: ClassKey<T>): Mocked<T>
  get<T = never>(key: TypedToken<T>): [T] extends [never] ? DeepMock : Mocked<T>
  /** Whether an auto-mock matches `key`. */
  has(key: ClassKey | Token): boolean
  /** Tokens of the auto-mocked dependencies, in injection order. */
  tokens(): Token[]
  /** `mockClear()` on every spy of every auto-mock (recorded calls are forgotten). */
  clearAll(): void
  /** Resets every auto-mock to its initial state (calls and programmed behaviours are forgotten). */
  resetAll(): void
}

/** Why a dependency was not auto-mocked (used in error messages). */
export type InjectionKind = 'provided' | 'override' | 'config' | 'optional' | 'interceptor' | 'real'

const REASONS: Readonly<Record<InjectionKind, string>> = {
  provided: 'its value was passed with `provide`',
  override: 'it was replaced with `overrides`',
  config: 'it is a configuration class (a real instance is injected; set values with `config`)',
  optional: 'it is an optional dependency (`undefined` is injected unless provided)',
  interceptor: 'it is an interceptor (not applied unless `aop: "real"`)',
  real: 'it was built for real (aop: "real")',
}

/** Default {@link MockRegistry} implementation (internal). */
export class TestMocks implements MockRegistry {
  readonly #mocks: ReadonlyMap<Token, object>
  readonly #others: ReadonlyMap<Token, InjectionKind>
  readonly #index: MetadataIndex
  readonly #owner: Token

  constructor(
    mocks: ReadonlyMap<Token, object>,
    others: ReadonlyMap<Token, InjectionKind>,
    index: MetadataIndex,
    owner: Token,
  ) {
    this.#mocks = mocks
    this.#others = others
    this.#index = index
    this.#owner = owner
  }

  get<T>(key: ClassKey<T>): Mocked<T>
  get<T = never>(key: TypedToken<T>): [T] extends [never] ? DeepMock : Mocked<T>
  get(key: unknown): unknown {
    const token = this.#index.find(key, new Set(this.#mocks.keys()))
    if (token !== undefined) return this.#mocks.get(token)
    throw this.#notMockedError(key)
  }

  has(key: ClassKey | Token): boolean {
    return this.#index.find(key, new Set(this.#mocks.keys())) !== undefined
  }

  tokens(): Token[] {
    return [...this.#mocks.keys()]
  }

  clearAll(): void {
    for (const mock of this.#mocks.values()) clearMock(mock)
  }

  resetAll(): void {
    for (const mock of this.#mocks.values()) resetMock(mock)
  }

  #notMockedError(key: unknown): ZnightError {
    const owner = displayName(this.#owner)
    let other: Token | undefined
    try {
      other = this.#index.find(key, new Set(this.#others.keys()))
    } catch {
      other = undefined
    }
    if (other !== undefined) {
      const kind = this.#others.get(other) as InjectionKind
      return new ZnightError(ErrorCode.MissingProvider, `${describeToken(other)} is not mocked: ${REASONS[kind]}`)
    }
    const mocked = [...this.#mocks.keys()].map(displayName)
    return new ZnightError(
      ErrorCode.MissingProvider,
      `No mock for ${describeKey(key)}: it is not a direct dependency of ${owner}`,
      {
        hints: [
          mocked.length === 0 ? `${owner} has no auto-mocked dependency` : `Auto-mocked: ${mocked.join(', ')}`,
          'TestBed only mocks direct dependencies; regenerate the metadata if the constructor changed',
        ],
      },
    )
  }
}
