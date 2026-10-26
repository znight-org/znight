/**
 * Public types of the mocks created by `@znight/testing`. They describe the Jest-compatible API
 * shared by the built-in spy, `vi.fn()` (Vitest), `jest.fn()` (Jest) and `mock()` (`bun:test`).
 */

/** Any function. Every function type is assignable to it (parameters are contravariant). */
export type AnyFunction = (...args: never[]) => unknown

/**
 * Signature of an untyped mock function: accepts any arguments and returns anything.
 */
// biome-ignore lint/suspicious/noExplicitAny: an untyped mock accepts any call shape, like jest.fn()
export type UntypedFunction = (...args: any[]) => any

/** Outcome of one call of a mock function (`mock.results`). */
export type MockResult<R> =
  | { readonly type: 'return'; readonly value: R }
  | { readonly type: 'throw'; readonly value: unknown }
  | { readonly type: 'incomplete'; readonly value: undefined }

/** Recorded calls of a mock function (`fn.mock`). */
export interface MockState<F extends AnyFunction = UntypedFunction> {
  /** Arguments of every call, in call order. */
  readonly calls: Parameters<F>[]
  /** Outcome of every call, in call order. */
  readonly results: MockResult<ReturnType<F>>[]
  /** `this` of every call (the new instance for `new` calls). */
  readonly instances: unknown[]
  /** `this` of every call. */
  readonly contexts: unknown[]
  /** Global, monotonic order of every call (comparable across mocks). */
  readonly invocationCallOrder: number[]
  /** Arguments of the last call. */
  readonly lastCall: Parameters<F> | undefined
}

/**
 * A mock function (spy): callable like `F`, records its calls and can be programmed. The API is the
 * common subset of `jest.fn()`, `vi.fn()` and `bun:test`'s `mock()`.
 */
export interface MockFunction<F extends AnyFunction = UntypedFunction> {
  (...args: Parameters<F>): ReturnType<F>
  readonly mock: MockState<F>
  /** Every call returns `value` (until reset). */
  mockReturnValue(value: ReturnType<F>): this
  /** The next call returns `value`. Queued values are used before the default implementation. */
  mockReturnValueOnce(value: ReturnType<F>): this
  /** Every call returns a promise resolved with `value`. */
  mockResolvedValue(value: Awaited<ReturnType<F>>): this
  mockResolvedValueOnce(value: Awaited<ReturnType<F>>): this
  /** Every call returns a promise rejected with `error`. */
  mockRejectedValue(error: unknown): this
  mockRejectedValueOnce(error: unknown): this
  mockImplementation(implementation: (...args: Parameters<F>) => ReturnType<F>): this
  mockImplementationOnce(implementation: (...args: Parameters<F>) => ReturnType<F>): this
  /** Every call returns its `this`. */
  mockReturnThis(): this
  /** Name displayed by assertion messages. */
  mockName(name: string): this
  getMockName(): string
  getMockImplementation(): ((...args: Parameters<F>) => ReturnType<F>) | undefined
  /** Forgets the recorded calls (implementations are kept). */
  mockClear(): this
  /** Forgets the recorded calls and the programmed implementations. */
  mockReset(): this
  mockRestore(): void
}

/** A member of a {@link Mocked} object: methods become {@link MockFunction}s, objects are mocked deeply. */
export type MockedMember<V> = V extends AnyFunction ? MockFunction<V> : V extends object ? Mocked<V> : V

/**
 * A mock of `T`: assignable to `T`, every method is a {@link MockFunction} and every object member
 * is itself mocked.
 *
 * ```ts
 * const repository: Mocked<UserRepository> = createMock<UserRepository>()
 * repository.findById.mockResolvedValue(user)
 * ```
 */
export type Mocked<T> = T & { [K in keyof T]: MockedMember<T[K]> }

/**
 * An untyped deep mock: every property is a callable {@link MockFunction} which is itself a deep
 * mock (`mock.repository.findById.mockResolvedValue(user)`).
 */
export interface DeepMock {
  readonly [key: string]: DeepMockFunction
}

/** A callable member of a {@link DeepMock}. */
export type DeepMockFunction = MockFunction & DeepMock

/**
 * Creates a mock function from an optional implementation: `vi.fn`, `jest.fn`, `bun:test`'s `mock`
 * or {@link createSpy}.
 */
export type MockFnFactory = (implementation?: AnyFunction) => unknown

/**
 * Which spy implementation mocks use:
 * - `'auto'` (default): Vitest (`globalThis.vi.fn`), Jest (`globalThis.jest.fn`), `bun:test`
 *   (`mock`, when running on Bun), otherwise the built-in spy;
 * - `'builtin'`: the built-in Jest-compatible spy ({@link createSpy});
 * - a factory such as `vi.fn`, `jest.fn` or `mock` from `bun:test`.
 */
export type MockFnOption = MockFnFactory | 'auto' | 'builtin'
