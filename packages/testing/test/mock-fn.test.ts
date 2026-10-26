import { createMock, createSpy, detectMockFn, isBuiltinSpy, resolveMockFn, setDefaultMockFn } from '../src/index.ts'
import { afterEach, describe, expect, test as it, mock } from 'bun:test'

type Globals = { vi?: unknown; jest?: unknown }

afterEach(() => {
  const scope = globalThis as Globals
  delete scope.vi
  delete scope.jest
  setDefaultMockFn()
})

describe('detectMockFn', () => {
  it('uses bun:test when running on Bun', () => {
    const detected = detectMockFn()
    expect(detected.source).toBe('bun')
    const spy = detected.create(() => 1) as () => number
    spy()
    // bun:test's expect only accepts genuine bun mocks
    expect(spy).toHaveBeenCalledTimes(1)
    expect(isBuiltinSpy(spy)).toBe(false)
  })

  it('prefers a global Vitest vi.fn', () => {
    const fn = (implementation?: unknown) => createSpy(implementation as never)
    ;(globalThis as Globals).vi = { fn }
    expect(detectMockFn()).toEqual({ source: 'vitest', create: fn })
  })

  it('then a global Jest jest.fn', () => {
    const fn = (implementation?: unknown) => createSpy(implementation as never)
    ;(globalThis as Globals).jest = { fn }
    expect(detectMockFn()).toEqual({ source: 'jest', create: fn })
  })

  it('ignores globals without a fn function', () => {
    ;(globalThis as Globals).vi = { fn: 'nope' }
    ;(globalThis as Globals).jest = {}
    expect(detectMockFn().source).toBe('bun')
  })
})

describe('resolveMockFn', () => {
  it("'builtin' forces the built-in spy", () => {
    const resolved = resolveMockFn('builtin')
    expect(resolved.source).toBe('builtin')
    expect(isBuiltinSpy(resolved.create())).toBe(true)
  })

  it('a function is used as is', () => {
    const factory = mock(() => createSpy())
    expect(resolveMockFn(factory)).toEqual({ source: 'custom', create: factory })
  })

  it("'auto' and undefined auto-detect", () => {
    expect(resolveMockFn('auto').source).toBe('bun')
    expect(resolveMockFn().source).toBe('bun')
  })

  it('rejects invalid options', () => {
    expect(() => resolveMockFn('vitest' as never)).toThrow(TypeError)
    expect(() => setDefaultMockFn(42 as never)).toThrow(TypeError)
  })
})

describe('setDefaultMockFn', () => {
  it('changes the factory used when none is given, and resets to auto-detection', () => {
    setDefaultMockFn('builtin')
    expect(resolveMockFn().source).toBe('builtin')
    const mocked = createMock<{ run(): void }>()
    expect(isBuiltinSpy(mocked.run)).toBe(true)
    setDefaultMockFn()
    expect(resolveMockFn().source).toBe('bun')
  })

  it('an explicit option wins over the default', () => {
    setDefaultMockFn('builtin')
    expect(resolveMockFn('auto').source).toBe('bun')
  })
})
