import type { ClassKey, Container, ProviderClass, ProviderValues, TypedToken, ZnightMetadata } from '@znight/core'
import type { ConfigValues } from './config.ts'
import type { MockRegistry } from './mock-registry.ts'
import type { MockFnOption } from './types.ts'

import { Builder } from './testbed-builder.ts'

/**
 * How `@Intercept` interceptors of the target are handled:
 * - `'none'` (default): interceptors are neither instantiated nor applied, the target's methods are
 *   the plain ones;
 * - `'real'`: interceptors are built (their own dependencies auto-mocked) or taken from
 *   `provide`/`overrides`, and applied like the container does.
 */
export type AopMode = 'none' | 'real'

/** Options of {@link TestBed.create}. */
export interface TestBedOptions {
  /** The generated metadata (`__ZNIGHT_METADATA__`). */
  readonly metadata: ZnightMetadata
  /**
   * Values injected instead of auto-mocks, keyed by class, token, alias or display name. Required
   * for qualified values (`@Inject('dbUrl')`, `@Provides({ name })` without a class) such as
   * primitives; also used for optional dependencies and members of multi dependencies.
   */
  readonly provide?: ProviderValues
  /**
   * Like `provide`, but a value shaped like a provider definition (`{ scope, deps, factory }`) is
   * built with its factory, its own dependencies being resolved like the target's (auto-mocked...).
   * A definition keyed by the target replaces the target's factory. Wins over `provide`.
   */
  readonly overrides?: ProviderValues
  /** Values of configuration classes (real instances are injected for `@Config` classes). */
  readonly config?: ConfigValues
  /** Spy implementation of the auto-mocks. Default: auto-detected. */
  readonly mockFn?: MockFnOption
  /** Auto-mocks return deep mocks from unconfigured methods instead of `undefined`. Default: `false`. */
  readonly deep?: boolean
  /** Interceptors handling, see {@link AopMode}. Default: `'none'`. */
  readonly aop?: AopMode
}

/** What {@link TestBed.create} returns. */
export interface TestBedResult<T> {
  /** The target, built with its real (generated) factory. */
  readonly instance: T
  /** The auto-mocks injected into the target. */
  readonly mocks: MockRegistry
  /**
   * A container holding the target and everything injected into it (auto-mocks, provided values,
   * configuration instances), for code that resolves dependencies itself.
   */
  readonly container: Container
}

/**
 * Unit-test harness: builds one provider with its real factory and auto-mocks its **direct**
 * dependencies, by kind:
 *
 * | Dependency                                   | Injected                                            |
 * | -------------------------------------------- | --------------------------------------------------- |
 * | class / interface / `@Provides` / external   | deep auto-mock                                      |
 * | configuration class (`@Config`)              | real instance: defaults + `config` values           |
 * | qualified value (`@Inject('x')`, primitives) | the `provide` value (an error otherwise)            |
 * | optional (`@Optional()`, `T \| undefined`)   | `undefined` (or the `provide` value)                |
 * | multi (`T[]`)                                | `[]` (or the provided members)                      |
 * | `Lazy<T>`                                    | `{ get: () => mock }`                               |
 * | interceptor (`@Intercept`)                   | nothing, not applied (unless `aop: 'real'`)         |
 *
 * ```ts
 * const { instance, mocks } = await TestBed.create(UserService, { metadata: __ZNIGHT_METADATA__ })
 * mocks.get(UserRepository).findById.mockResolvedValue({ id: '1' })
 * await instance.findById('1')
 * expect(mocks.get(UserRepository).findById).toHaveBeenCalledWith('1')
 * ```
 */
export class TestBed {
  private constructor() {
    // static API only
  }

  /**
   * Builds `target` (a class, token, alias or display name of a provider of `options.metadata`).
   *
   * @throws ZnightError ZNIGHT001 (unknown target, qualified dependency without value), ZNIGHT012
   *   (invalid `config`), ZNIGHT015 (the factory failed).
   */
  static create<T>(target: ProviderClass<T> | ClassKey<T>, options: TestBedOptions): Promise<TestBedResult<T>>
  static create<T = unknown>(target: TypedToken<T>, options: TestBedOptions): Promise<TestBedResult<T>>
  static create(target: unknown, options: TestBedOptions): Promise<TestBedResult<unknown>> {
    try {
      return new Builder(options).build(target)
    } catch (error) {
      return Promise.reject(error)
    }
  }
}
