import type { AnyFunction, MockFunction, UntypedFunction } from './types.ts'

type Implementation = (this: unknown, ...args: unknown[]) => unknown

interface MutableResult {
  type: 'return' | 'throw' | 'incomplete'
  value: unknown
}

interface MutableState {
  readonly calls: unknown[][]
  readonly results: MutableResult[]
  readonly instances: unknown[]
  readonly contexts: unknown[]
  readonly invocationCallOrder: number[]
  readonly lastCall: unknown[] | undefined
}

interface SpyInternals {
  name: string
  implementation: Implementation | undefined
  readonly initial: Implementation | undefined
  readonly once: Implementation[]
  readonly state: MutableState
}

const DEFAULT_NAME = 'spy'

/** Global call counter shared by every built-in spy (`mock.invocationCallOrder`). */
let callOrder = 0

const internalsBySpy = new WeakMap<object, SpyInternals>()

function internalsOf(spy: unknown): SpyInternals {
  const internals = typeof spy === 'function' ? internalsBySpy.get(spy) : undefined
  if (internals === undefined) throw new TypeError('[znight] Not a spy created by createSpy()')
  return internals
}

function createState(): MutableState {
  const calls: unknown[][] = []
  return {
    calls,
    results: [],
    instances: [],
    contexts: [],
    invocationCallOrder: [],
    get lastCall(): unknown[] | undefined {
      return calls[calls.length - 1]
    },
  }
}

function clearState(state: MutableState): void {
  state.calls.length = 0
  state.results.length = 0
  state.instances.length = 0
  state.contexts.length = 0
  state.invocationCallOrder.length = 0
}

function isObjectLike(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function invoke(internals: SpyInternals, self: unknown, args: unknown[], isNew: boolean): unknown {
  const state = internals.state
  state.calls.push(args)
  state.contexts.push(self)
  state.instances.push(self)
  state.invocationCallOrder.push(++callOrder)
  const result: MutableResult = { type: 'incomplete', value: undefined }
  state.results.push(result)
  const implementation = internals.once.shift() ?? internals.implementation
  try {
    const value = implementation === undefined ? undefined : implementation.apply(self, args)
    const returned = isNew && !isObjectLike(value) ? self : value
    result.type = 'return'
    result.value = returned
    return returned
  } catch (error) {
    result.type = 'throw'
    result.value = error
    throw error
  }
}

function returning(value: unknown): Implementation {
  return () => value
}

function resolving(value: unknown): Implementation {
  return () => Promise.resolve(value)
}

function rejecting(error: unknown): Implementation {
  return () => Promise.reject(error)
}

function returnThis(this: unknown): unknown {
  return this
}

/** Methods shared by every built-in spy (the prototype of the spy functions). */
const spyPrototype: object = Object.create(Function.prototype, {
  _isMockFunction: { value: true },
  mock: {
    get(this: unknown): MutableState {
      return internalsOf(this).state
    },
  },
  mockImplementation: {
    value(this: unknown, implementation: Implementation): unknown {
      internalsOf(this).implementation = implementation
      return this
    },
  },
  mockImplementationOnce: {
    value(this: unknown, implementation: Implementation): unknown {
      internalsOf(this).once.push(implementation)
      return this
    },
  },
  mockReturnValue: {
    value(this: unknown, value: unknown): unknown {
      internalsOf(this).implementation = returning(value)
      return this
    },
  },
  mockReturnValueOnce: {
    value(this: unknown, value: unknown): unknown {
      internalsOf(this).once.push(returning(value))
      return this
    },
  },
  mockResolvedValue: {
    value(this: unknown, value: unknown): unknown {
      internalsOf(this).implementation = resolving(value)
      return this
    },
  },
  mockResolvedValueOnce: {
    value(this: unknown, value: unknown): unknown {
      internalsOf(this).once.push(resolving(value))
      return this
    },
  },
  mockRejectedValue: {
    value(this: unknown, error: unknown): unknown {
      internalsOf(this).implementation = rejecting(error)
      return this
    },
  },
  mockRejectedValueOnce: {
    value(this: unknown, error: unknown): unknown {
      internalsOf(this).once.push(rejecting(error))
      return this
    },
  },
  mockReturnThis: {
    value(this: unknown): unknown {
      internalsOf(this).implementation = returnThis
      return this
    },
  },
  mockName: {
    value(this: unknown, name: string): unknown {
      internalsOf(this).name = String(name)
      return this
    },
  },
  getMockName: {
    value(this: unknown): string {
      return internalsOf(this).name
    },
  },
  getMockImplementation: {
    value(this: unknown): Implementation | undefined {
      return internalsOf(this).implementation
    },
  },
  mockClear: {
    value(this: unknown): unknown {
      clearState(internalsOf(this).state)
      return this
    },
  },
  mockReset: {
    value(this: unknown): unknown {
      const internals = internalsOf(this)
      clearState(internals.state)
      internals.once.length = 0
      internals.implementation = internals.initial
      return this
    },
  },
  mockRestore: {
    value(this: unknown): void {
      const internals = internalsOf(this)
      clearState(internals.state)
      internals.once.length = 0
      internals.implementation = internals.initial
    },
  },
})

/**
 * Creates the built-in, dependency-free, Jest-compatible spy. It records `mock.calls`,
 * `mock.results`, `mock.instances`, `mock.contexts`, `mock.invocationCallOrder` and `mock.lastCall`,
 * supports `mockReturnValue(Once)`, `mockResolvedValue(Once)`, `mockRejectedValue(Once)`,
 * `mockImplementation(Once)`, `mockReturnThis`, `mockName`, `mockClear`, `mockReset` and
 * `mockRestore`, and is recognised by Jest's and Vitest's `expect` (`_isMockFunction`).
 *
 * `mockReset()` restores the implementation given to `createSpy()` (Vitest semantics).
 *
 * ```ts
 * const find = createSpy((id: string) => ({ id }))
 * find.mockReturnValueOnce({ id: 'x' })
 * find('1')
 * find.mock.calls // [['1']]
 * ```
 */
export function createSpy<F extends AnyFunction = UntypedFunction>(implementation?: F): MockFunction<F> {
  if (implementation !== undefined && typeof implementation !== 'function') {
    throw new TypeError('[znight] createSpy() expects a function implementation')
  }
  const initial = implementation as Implementation | undefined
  const internals: SpyInternals = {
    name: DEFAULT_NAME,
    implementation: initial,
    initial,
    once: [],
    state: createState(),
  }
  const spy = function (this: unknown, ...args: unknown[]): unknown {
    return invoke(internals, this, args, new.target !== undefined)
  }
  Object.setPrototypeOf(spy, spyPrototype)
  internalsBySpy.set(spy, internals)
  return spy as unknown as MockFunction<F>
}

/** Whether `value` is a spy created by {@link createSpy}. */
export function isBuiltinSpy(value: unknown): boolean {
  return typeof value === 'function' && internalsBySpy.has(value)
}
