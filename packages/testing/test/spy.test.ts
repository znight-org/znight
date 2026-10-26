import { createSpy, isBuiltinSpy } from '../src/index.ts'
import { describe, expect, test as it } from 'bun:test'

describe('createSpy', () => {
  it('records calls, contexts, results and the last call', () => {
    const spy = createSpy((a: number, b: number) => a + b)
    const self = { name: 'self' }
    expect(spy(1, 2)).toBe(3)
    expect(spy.call(self, 3, 4)).toBe(7)
    expect(spy.mock.calls).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(spy.mock.contexts).toEqual([undefined, self])
    expect(spy.mock.instances).toEqual([undefined, self])
    expect(spy.mock.results).toEqual([
      { type: 'return', value: 3 },
      { type: 'return', value: 7 },
    ])
    expect(spy.mock.lastCall).toEqual([3, 4])
  })

  it('returns undefined without implementation', () => {
    const spy = createSpy()
    expect(spy('x')).toBeUndefined()
    expect(spy.mock.calls).toEqual([['x']])
    expect(spy.mock.lastCall).toEqual(['x'])
  })

  it('lastCall is undefined before any call', () => {
    expect(createSpy().mock.lastCall).toBeUndefined()
  })

  it('records thrown errors and rethrows them', () => {
    const error = new Error('boom')
    const spy = createSpy(() => {
      throw error
    })
    expect(() => spy()).toThrow(error)
    expect(spy.mock.results).toEqual([{ type: 'throw', value: error }])
  })

  it('invocationCallOrder is global and monotonic', () => {
    const first = createSpy()
    const second = createSpy()
    first()
    second()
    first()
    const [a, c] = first.mock.invocationCallOrder as [number, number]
    const [b] = second.mock.invocationCallOrder as [number]
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })

  it('mockReturnValue / mockReturnValueOnce (once values first, in order)', () => {
    const spy = createSpy<() => string>()
    spy.mockReturnValue('default').mockReturnValueOnce('one').mockReturnValueOnce('two')
    expect([spy(), spy(), spy(), spy()]).toEqual(['one', 'two', 'default', 'default'])
  })

  it('mockResolvedValue / mockResolvedValueOnce', async () => {
    const spy = createSpy<() => Promise<number>>()
    spy.mockResolvedValue(1).mockResolvedValueOnce(0)
    expect(await spy()).toBe(0)
    expect(await spy()).toBe(1)
  })

  it('mockRejectedValue / mockRejectedValueOnce', async () => {
    const spy = createSpy<() => Promise<number>>()
    spy.mockRejectedValue(new Error('always')).mockRejectedValueOnce(new Error('once'))
    await expect(spy()).rejects.toThrow('once')
    await expect(spy()).rejects.toThrow('always')
  })

  it('mockImplementation / mockImplementationOnce / getMockImplementation', () => {
    const spy = createSpy((value: number) => value)
    const double = (value: number): number => value * 2
    spy.mockImplementation(double).mockImplementationOnce(value => -value)
    expect(spy(2)).toBe(-2)
    expect(spy(2)).toBe(4)
    expect(spy.getMockImplementation()).toBe(double)
  })

  it('mockReturnThis returns the receiver', () => {
    const builder = { where: createSpy().mockReturnThis() }
    expect(builder.where()).toBe(builder)
  })

  it('mockName / getMockName', () => {
    const spy = createSpy()
    expect(spy.getMockName()).toBe('spy')
    expect(spy.mockName('UserRepository.findById')).toBe(spy)
    expect(spy.getMockName()).toBe('UserRepository.findById')
  })

  it('mockClear forgets calls and keeps implementations', () => {
    const spy = createSpy(() => 1)
    spy.mockReturnValue(2)
    spy()
    const calls = spy.mock.calls
    spy.mockClear()
    expect(spy.mock.calls).toEqual([])
    expect(calls).toHaveLength(0)
    expect(spy.mock.results).toEqual([])
    expect(spy.mock.invocationCallOrder).toEqual([])
    expect(spy()).toBe(2)
  })

  it('mockReset forgets calls and programmed behaviour, restoring the initial implementation', () => {
    const spy = createSpy(() => 'initial')
    spy.mockReturnValue('programmed').mockReturnValueOnce('once')
    spy()
    spy.mockReset()
    expect(spy.mock.calls).toEqual([])
    expect(spy()).toBe('initial')
    const bare = createSpy()
    bare.mockReturnValue(1)
    bare.mockReset()
    expect(bare()).toBeUndefined()
  })

  it('mockRestore behaves like mockReset', () => {
    const spy = createSpy(() => 'initial')
    spy.mockReturnValue('programmed')
    spy.mockRestore()
    expect(spy()).toBe('initial')
  })

  it('new calls record the instance and return it unless the implementation returns an object', () => {
    const Ctor = createSpy(function (this: { value?: number }, value: number) {
      this.value = value
    })
    const instance = new (Ctor as unknown as new (value: number) => { value: number })(3)
    expect(instance.value).toBe(3)
    expect(Ctor.mock.instances[0]).toBe(instance)
    const replacement = { replaced: true }
    const Factory = createSpy(() => replacement)
    expect(new (Factory as unknown as new () => object)()).toBe(replacement)
  })

  it('is recognised as a Jest/Vitest mock function', () => {
    const spy = createSpy() as unknown as { _isMockFunction: boolean }
    expect(spy._isMockFunction).toBe(true)
    expect(isBuiltinSpy(spy)).toBe(true)
    expect(isBuiltinSpy(() => undefined)).toBe(false)
    expect(isBuiltinSpy(null)).toBe(false)
  })

  it('rejects a non-function implementation', () => {
    expect(() => createSpy('nope' as never)).toThrow(TypeError)
  })

  it('methods called on something else than a spy throw a TypeError', () => {
    const { mockClear } = createSpy()
    expect(() => mockClear.call({})).toThrow('Not a spy')
  })

  it('is a regular function', () => {
    const spy = createSpy()
    expect(typeof spy).toBe('function')
    expect(spy.bind(null)).toBeInstanceOf(Function)
    expect(spy.apply(null, [])).toBeUndefined()
    expect((spy as unknown as { then?: unknown }).then).toBeUndefined()
  })
})
