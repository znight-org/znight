import type { ClassKey } from '@znight/core'
import type { AnyFunction, DeepMock, Mocked, MockFnFactory, MockFnOption } from './types.ts'

import { resolveMockFn } from './mock-fn.ts'

/** Options of {@link createMock}. */
export interface CreateMockOptions {
  /**
   * Name of the mock, used to name its spies in assertion messages (`UserRepository.findById`).
   * Default: the class name, or `mock`.
   */
  readonly name?: string
  /**
   * When `true`, calling an unconfigured method returns a deep mock (the same one for every call)
   * instead of `undefined`, so fluent APIs work: `db.select().from('users')`. Default: `false`.
   */
  readonly deep?: boolean
  /** Spy implementation. Default: auto-detected (see `MockFnOption`). */
  readonly mockFn?: MockFnOption
}

/** Shared state of a mock and every spy created under it. */
interface MockTree {
  readonly create: MockFnFactory
  readonly deep: boolean
  readonly spies: SpyRecord[]
}

interface SpyRecord {
  readonly spy: SpyLike
  readonly implementation: AnyFunction | undefined
}

interface SpyLike {
  (...args: unknown[]): unknown
  mockName?: (name: string) => unknown
  mockClear?: () => unknown
  mockReset?: () => unknown
  mockImplementation?: (implementation: AnyFunction) => unknown
}

/**
 * Property names never auto-mocked (they read as `undefined` unless set explicitly). Libraries probe
 * them to detect promises (`then`), JSON values (`toJSON`), asymmetric matchers (`asymmetricMatch`),
 * React elements (`$$typeof`), DOM nodes (`nodeType`, `tagName`), ES module namespaces
 * (`__esModule`) or mock functions (`_isMockFunction`). Names starting with `@@` (Immutable.js
 * sentinels) are reserved too. Symbol-keyed properties are never auto-mocked.
 */
const RESERVED: ReadonlySet<string> = new Set([
  'then',
  'toJSON',
  'asymmetricMatch',
  '$$typeof',
  'nodeType',
  'tagName',
  '__esModule',
  '_isMockFunction',
])

const TREE: unique symbol = Symbol('znight.mock')

const mocks = new WeakSet<object>()

function isReserved(key: string): boolean {
  return RESERVED.has(key) || key.startsWith('@@')
}

/**
 * Creates a deep auto-mock.
 *
 * - Every property read returns a spy (`MockFunction`), created on first access and then stable.
 *   Spies are deep too: `mock.pool.query.mockResolvedValue(rows)`.
 * - Unconfigured spies return `undefined` (or a deep mock with `{ deep: true }`).
 * - The mock is **not thenable** and inert for serialisers: `then`, `toJSON`, `asymmetricMatch`,
 *   `$$typeof`, `Symbol.toPrimitive`... read as `undefined`, so `await mock`, `JSON.stringify(mock)`
 *   and `expect(...).toEqual(mock)` behave.
 * - Assigned properties win: `mock.enabled = false`.
 * - With a class, the mock inherits its prototype (`instanceof` works) and getters read as
 *   `undefined` instead of a (truthy) spy.
 * - Functions of `partial` become spies with that implementation; other values are set as is.
 *
 * ```ts
 * const repository = createMock(UserRepository, { findById: async id => ({ id }) })
 * const logger = createMock<Logger>()
 * logger.info('hello')
 * expect(logger.info).toHaveBeenCalledWith('hello')
 * ```
 */
export function createMock<T>(cls: ClassKey<T>, partial?: Partial<T>, options?: CreateMockOptions): Mocked<T>
export function createMock<T = never>(
  partial?: Partial<T>,
  options?: CreateMockOptions,
): [T] extends [never] ? DeepMock : Mocked<T>
export function createMock(first?: unknown, second?: unknown, third?: unknown): unknown {
  if (typeof first === 'function') {
    return mockObject(first as ClassKey<unknown>, second as object | undefined, third as CreateMockOptions | undefined)
  }
  return mockObject(undefined, first as object | undefined, second as CreateMockOptions | undefined)
}

/** {@link createMock} with an optional class (internal). */
export function mockObject(
  cls: ClassKey<unknown> | undefined,
  partial: object | undefined,
  options: CreateMockOptions = {},
): object {
  if (partial !== undefined && (partial === null || typeof partial !== 'object')) {
    throw new TypeError('[znight] createMock(): the partial implementation must be an object')
  }
  const tree: MockTree = {
    create: resolveMockFn(options.mockFn).create,
    deep: options.deep === true,
    spies: [],
  }
  const className = typeof cls === 'function' ? (cls as { name?: unknown }).name : undefined
  const name = options.name ?? (typeof className === 'string' && className !== '' ? className : 'mock')
  return createNode(name, tree, cls, partial)
}

/** Whether `value` is a mock (or one of its spies) created by {@link createMock}. */
export function isMock(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && mocks.has(value)
}

/** Forgets the calls recorded by every spy of `mock` (`mockClear()`); implementations are kept. */
export function clearMock(mock: object): void {
  for (const { spy } of treeOf(mock, 'clearMock').spies) spy.mockClear?.()
}

/**
 * Resets every spy of `mock` to its initial state: recorded calls and programmed implementations
 * are forgotten, implementations given to {@link createMock} (and deep returns) are restored.
 */
export function resetMock(mock: object): void {
  for (const { spy, implementation } of treeOf(mock, 'resetMock').spies) {
    spy.mockReset?.()
    if (implementation !== undefined) spy.mockImplementation?.(implementation)
  }
}

function treeOf(mock: object, where: string): MockTree {
  const tree = isMock(mock) ? (mock as { [TREE]?: MockTree })[TREE] : undefined
  if (tree === undefined) throw new TypeError(`[znight] ${where}(): expected a mock created by createMock()`)
  return tree
}

/** An object mock (the root of a mock, or the value returned by a deep spy). */
function createNode(
  name: string,
  tree: MockTree,
  cls: ClassKey<unknown> | undefined,
  partial: object | undefined,
): object {
  const target: Record<PropertyKey, unknown> = Object.create(
    typeof cls === 'function' && isObjectLike(cls.prototype) ? (cls.prototype as object) : Object.prototype,
  )
  const accessors = typeof cls === 'function' ? accessorKeys(cls.prototype) : undefined
  const children = new Map<string, unknown>()
  if (partial !== undefined) {
    for (const key of Reflect.ownKeys(partial)) {
      const value = (partial as Record<PropertyKey, unknown>)[key]
      if (typeof key === 'string' && typeof value === 'function') {
        children.set(key, createSpyNode(`${name}.${key}`, tree, value as AnyFunction))
      } else {
        defineValue(target, key, value)
      }
    }
  }
  const proxy: object = new Proxy(target, {
    get(object, key, receiver): unknown {
      if (typeof key === 'symbol') {
        if (key === TREE) return tree
        return Object.hasOwn(object, key) ? object[key] : undefined
      }
      if (Object.hasOwn(object, key)) return object[key]
      if (key === 'constructor') return Reflect.get(object, key, receiver)
      if (isReserved(key)) return undefined
      if (Object.hasOwn(Object.prototype, key)) return Reflect.get(Object.prototype, key, receiver)
      if (accessors?.has(key) === true) return undefined
      let child = children.get(key)
      if (child === undefined) {
        child = createSpyNode(`${name}.${key}`, tree, undefined)
        children.set(key, child)
      }
      return child
    },
    set(object, key, value): boolean {
      defineValue(object, key, value)
      return true
    },
    deleteProperty(object, key): boolean {
      if (typeof key === 'string') children.delete(key)
      return Reflect.deleteProperty(object, key)
    },
  })
  mocks.add(proxy)
  return proxy
}

/** A spy whose unknown properties are deep spies (`spy.nested.method`). */
function createSpyNode(path: string, tree: MockTree, implementation: AnyFunction | undefined): SpyLike {
  const effective = implementation ?? (tree.deep ? deepReturn(path, tree) : undefined)
  const spy = tree.create(effective) as SpyLike
  if (typeof spy !== 'function') {
    throw new TypeError(`[znight] The mockFn factory returned ${typeof spy} instead of a function`)
  }
  if (typeof spy.mockName === 'function') spy.mockName(path)
  makeDeep(spy, path, tree)
  tree.spies.push({ spy, implementation: effective })
  mocks.add(spy)
  return spy
}

/** The implementation of a deep spy: returns the same deep mock on every call. */
function deepReturn(path: string, tree: MockTree): AnyFunction {
  let result: object | undefined
  return () => {
    result ??= createNode(`${path}()`, tree, undefined, undefined)
    return result
  }
}

/**
 * Inserts a proxy between `spy` and its prototype: reading a property the spy does not have (own or
 * inherited) creates a child spy. The spy itself stays a genuine spy of its framework, which
 * `bun:test`'s `expect` requires (it rejects proxies).
 */
function makeDeep(spy: SpyLike, path: string, tree: MockTree): void {
  const original: unknown = Object.getPrototypeOf(spy)
  if (!isObjectLike(original)) return
  const children = new Map<string, SpyLike>()
  const prototype = new Proxy(original as object, {
    get(object, key, receiver): unknown {
      if (typeof key === 'symbol' || key in object || isReserved(key)) return Reflect.get(object, key, receiver)
      let child = children.get(key)
      if (child === undefined) {
        child = createSpyNode(`${path}.${key}`, tree, undefined)
        children.set(key, child)
      }
      return child
    },
  })
  try {
    Object.setPrototypeOf(spy, prototype)
  } catch {
    // a frozen or exotic spy: it keeps working, without deep members
  }
}

function defineValue(object: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
}

/** Names of the accessors (getters/setters) declared along a prototype chain, `Object.prototype` excluded. */
function accessorKeys(prototype: unknown): ReadonlySet<string> {
  const keys = new Set<string>()
  let current: unknown = prototype
  while (isObjectLike(current) && current !== Object.prototype && current !== Function.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) keys.add(key)
    }
    current = Object.getPrototypeOf(current)
  }
  return keys
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}
