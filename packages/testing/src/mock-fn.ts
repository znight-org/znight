import type { MockFnFactory, MockFnOption } from './types.ts'

import { createRequire } from 'node:module'

import { createSpy } from './spy.ts'

/** Where the spy factory used by mocks comes from. */
export type MockFnSource = 'custom' | 'vitest' | 'jest' | 'bun' | 'builtin'

/** A spy factory and its origin (see {@link resolveMockFn}). */
export interface ResolvedMockFn {
  readonly source: MockFnSource
  readonly create: MockFnFactory
}

const BUILTIN: ResolvedMockFn = Object.freeze({ source: 'builtin', create: createSpy as MockFnFactory })

let defaultOption: MockFnOption = 'auto'
/** `mock` of `bun:test`: `undefined` until probed, `null` when unavailable. */
let bunMock: MockFnFactory | null | undefined

function assertOption(option: unknown, where: string): asserts option is MockFnOption {
  if (typeof option === 'function' || option === 'auto' || option === 'builtin') return
  throw new TypeError(`[znight] ${where}: mockFn must be 'auto', 'builtin' or a function such as vi.fn`)
}

/**
 * Sets the spy factory used when `mockFn` is not passed explicitly (e.g. in a Vitest setup file:
 * `setDefaultMockFn(vi.fn)`). Without argument, restores auto-detection.
 */
export function setDefaultMockFn(option: MockFnOption = 'auto'): void {
  assertOption(option, 'setDefaultMockFn()')
  defaultOption = option
}

/**
 * Resolves a {@link MockFnOption} (default: the option set with {@link setDefaultMockFn}, `'auto'`
 * initially) to a spy factory.
 */
export function resolveMockFn(option?: MockFnOption): ResolvedMockFn {
  const effective = option ?? defaultOption
  assertOption(effective, 'resolveMockFn()')
  if (typeof effective === 'function') return { source: 'custom', create: effective }
  if (effective === 'builtin') return BUILTIN
  return detectMockFn()
}

/**
 * Auto-detects the spy factory of the running test framework: Vitest (`globalThis.vi.fn`, with
 * `globals: true`), Jest (`globalThis.jest.fn`), `bun:test` (`mock`, loaded only when running on
 * Bun), otherwise the built-in spy ({@link createSpy}).
 */
export function detectMockFn(): ResolvedMockFn {
  const scope = globalThis as { vi?: { fn?: unknown }; jest?: { fn?: unknown } }
  const vitest = scope.vi?.fn
  if (typeof vitest === 'function') return { source: 'vitest', create: vitest as MockFnFactory }
  const jest = scope.jest?.fn
  if (typeof jest === 'function') return { source: 'jest', create: jest as MockFnFactory }
  const bun = loadBunMock()
  if (bun !== undefined) return { source: 'bun', create: bun }
  return BUILTIN
}

/** Whether the code runs on Bun. */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

function loadBunMock(): MockFnFactory | undefined {
  bunMock ??= isBunRuntime() ? requireBunMock() : null
  return bunMock ?? undefined
}

function requireBunMock(): MockFnFactory | null {
  try {
    // non-literal specifier: bundlers and Vite never try to resolve `bun:test`
    const specifier = ['bun', 'test'].join(':')
    const bunTest = createRequire(import.meta.url)(specifier) as { mock?: unknown }
    return typeof bunTest.mock === 'function' ? (bunTest.mock as MockFnFactory) : null
  } catch {
    return null
  }
}
