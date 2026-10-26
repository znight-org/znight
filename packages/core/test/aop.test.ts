import {
  applyInterceptors,
  Container,
  ErrorCode,
  interceptMethod,
  type MethodInterceptor,
  type MethodInvocation,
  type ZnightError,
} from '../src/index.ts'
import { caught, caughtSync, factoryDef, meta, sleep, t } from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

/** Records `before:<name>` / `after:<name>` around the call. */
class Tracer implements MethodInterceptor<{ name: string }> {
  readonly log: string[]
  constructor(log: string[]) {
    this.log = log
  }

  intercept(invocation: MethodInvocation, options: { name: string }): unknown {
    this.log.push(`before:${options.name}`)
    const result = invocation.proceed()
    if (invocation.isAsync) {
      return (result as Promise<unknown>).then(value => {
        this.log.push(`after:${options.name}`)
        return value
      })
    }
    this.log.push(`after:${options.name}`)
    return result
  }
}

class Calculator {
  readonly #factor = 2
  calls = 0

  multiply(value: number): number {
    this.calls++
    return value * this.#factor
  }

  double(value: number): number {
    return this.multiply(value)
  }

  async slowAdd(a: number, b: number): Promise<number> {
    await sleep(1)
    return a + b + this.#factor - 2
  }

  promiseReturning(): Promise<string> {
    return Promise.resolve('direct')
  }
}

const originalEnv = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = originalEnv
})

describe('interceptMethod', () => {
  it('wraps the method with an own, non-enumerable property (no Proxy)', () => {
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [{ interceptor: new Tracer([]), options: { name: 'x' } }])
    const descriptor = Object.getOwnPropertyDescriptor(calculator, 'multiply')
    expect(typeof descriptor?.value).toBe('function')
    expect(descriptor?.enumerable).toBe(false)
    expect(descriptor?.writable).toBe(true)
    expect((descriptor?.value as { name: string } | undefined)?.name).toBe('multiply')
    expect(Object.keys(calculator)).toEqual(['calls'])
    expect(calculator).toBeInstanceOf(Calculator)
    expect(new Calculator().multiply).toBe(Calculator.prototype.multiply)
  })

  it('keeps #private fields working', () => {
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [{ interceptor: new Tracer([]), options: { name: 'x' } }])
    expect(calculator.multiply(21)).toBe(42)
  })

  it('runs the chain outermost first (first link = top-most decorator)', () => {
    const log: string[] = []
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [
      { interceptor: new Tracer(log), options: { name: 'outer' } },
      { interceptor: new Tracer(log), options: { name: 'inner' } },
    ])
    expect(calculator.multiply(1)).toBe(2)
    expect(log).toEqual(['before:outer', 'before:inner', 'after:inner', 'after:outer'])
  })

  it('intercepts self-invocation through this', () => {
    const log: string[] = []
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [{ interceptor: new Tracer(log), options: { name: 'multiply' } }])
    expect(calculator.double(5)).toBe(10)
    expect(log).toEqual(['before:multiply', 'after:multiply'])
  })

  it('supports async methods', async () => {
    const log: string[] = []
    const calculator = new Calculator()
    interceptMethod(calculator, 'slowAdd', [{ interceptor: new Tracer(log), options: { name: 'add' } }], {
      async: true,
    })
    expect(await calculator.slowAdd(1, 2)).toBe(3)
    expect(log).toEqual(['before:add', 'after:add'])
  })

  it('exposes the invocation and lets interceptors replace arguments', () => {
    const seen: MethodInvocation[] = []
    const calculator = new Calculator()
    interceptMethod(
      calculator,
      'multiply',
      [
        {
          interceptor: {
            intercept(invocation) {
              seen.push(invocation)
              return invocation.proceed([(invocation.args[0] as number) + 1])
            },
          },
        },
      ],
      { className: 'Calc' },
    )
    expect(calculator.multiply(1)).toBe(4)
    const invocation = seen[0] as MethodInvocation
    expect(invocation.target).toBe(calculator)
    expect(invocation.className).toBe('Calc')
    expect(invocation.methodName).toBe('multiply')
    expect(invocation.args).toEqual([1])
    expect(invocation.isAsync).toBe(false)
  })

  it('allows proceed() to be called several times (retries) and short-circuits', () => {
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [
      {
        interceptor: {
          intercept: invocation => {
            invocation.proceed()
            return invocation.proceed()
          },
        },
      },
    ])
    expect(calculator.multiply(3)).toBe(6)
    expect(calculator.calls).toBe(2)

    const cached = new Calculator()
    interceptMethod(cached, 'multiply', [{ interceptor: { intercept: () => 'cached' } }])
    expect(cached.multiply(3) as unknown).toBe('cached')
    expect(cached.calls).toBe(0)
  })

  it('preserves the receiver of the call and falls back to the instance for detached calls', () => {
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [{ interceptor: { intercept: invocation => invocation.proceed() } }])
    const detached = calculator.multiply
    expect(detached(4)).toBe(8)
  })

  it('throws in development when an interceptor returns a promise for a sync method', () => {
    process.env.NODE_ENV = 'development'
    class AsyncInterceptor implements MethodInterceptor {
      intercept(invocation: MethodInvocation): Promise<unknown> {
        return Promise.resolve(invocation.proceed())
      }
    }
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [{ interceptor: new AsyncInterceptor() }])
    const error = caughtSync(() => calculator.multiply(1)) as ZnightError
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
    expect(error.message).toContain('AsyncInterceptor')
    expect(error.message).toContain('Calculator.multiply()')
  })

  it('does not check in production', async () => {
    process.env.NODE_ENV = 'production'
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [{ interceptor: { intercept: async invocation => invocation.proceed() } }])
    expect(await (calculator.multiply(2) as unknown as Promise<number>)).toBe(4)
  })

  it('accepts sync methods returning a promise passed through unchanged', async () => {
    process.env.NODE_ENV = 'development'
    const calculator = new Calculator()
    interceptMethod(calculator, 'promiseReturning', [
      { interceptor: { intercept: invocation => invocation.proceed() } },
    ])
    expect(await calculator.promiseReturning()).toBe('direct')
  })

  it('can disable the check explicitly', async () => {
    process.env.NODE_ENV = 'development'
    const calculator = new Calculator()
    interceptMethod(
      calculator,
      'multiply',
      [{ interceptor: { intercept: async invocation => invocation.proceed() } }],
      {
        checkSync: false,
      },
    )
    expect(await (calculator.multiply(2) as unknown as Promise<number>)).toBe(4)
  })

  it('propagates errors of the method and of interceptors', async () => {
    const calculator = new Calculator()
    calculator.slowAdd = () => Promise.reject(new Error('method failed'))
    interceptMethod(calculator, 'slowAdd', [{ interceptor: { intercept: invocation => invocation.proceed() } }], {
      async: true,
    })
    expect(((await caught(() => calculator.slowAdd(1, 2))) as Error).message).toBe('method failed')

    interceptMethod(calculator, 'multiply', [
      {
        interceptor: {
          intercept: () => {
            throw new Error('denied')
          },
        },
      },
    ])
    expect((caughtSync(() => calculator.multiply(1)) as Error).message).toBe('denied')
  })

  it('rejects invalid targets and interceptors (ZNIGHT005)', () => {
    const calculator = new Calculator()
    expect((caughtSync(() => interceptMethod(calculator, 'calls', [])) as ZnightError).code).toBe(
      ErrorCode.InvalidDecorator,
    )
    expect(
      (caughtSync(() => interceptMethod(calculator, 'multiply', [{ interceptor: {} as never }])) as ZnightError).code,
    ).toBe(ErrorCode.InvalidDecorator)
  })

  it('leaves the method untouched with an empty chain', () => {
    const calculator = new Calculator()
    interceptMethod(calculator, 'multiply', [])
    expect(Object.hasOwn(calculator, 'multiply')).toBe(false)
  })
})

describe('applyInterceptors', () => {
  it('binds interceptors from resolved dependencies and options', () => {
    const log: string[] = []
    const calculator = new Calculator()
    applyInterceptors(
      calculator,
      {
        multiply: {
          async: false,
          chain: [
            { dep: 1, options: { name: 'a' } },
            { dep: 2, options: { name: 'b' } },
          ],
        },
        slowAdd: { async: true, chain: [{ dep: 1, options: { name: 'c' } }] },
      },
      ['not an interceptor', new Tracer(log), new Tracer(log)],
    )
    expect(calculator.multiply(1)).toBe(2)
    expect(log).toEqual(['before:a', 'before:b', 'after:b', 'after:a'])
  })

  it('rejects out-of-range dependency indexes and non-interceptors', () => {
    const calculator = new Calculator()
    expect(
      (
        caughtSync(() =>
          applyInterceptors(calculator, { multiply: { async: false, chain: [{ dep: 3 }] } }, []),
        ) as ZnightError
      ).message,
    ).toContain('#3 does not exist')
    expect(
      (
        caughtSync(() =>
          applyInterceptors(calculator, { multiply: { async: false, chain: [{ dep: 0 }] } }, [{}]),
        ) as ZnightError
      ).code,
    ).toBe(ErrorCode.InvalidDecorator)
  })
})

describe('container integration', () => {
  const log: string[] = []
  const definitions = (scope: 'singleton' | 'request' | 'transient') =>
    meta({
      [t('Tracer')]: factoryDef(() => new Tracer(log)),
      [t('Calculator')]: {
        scope,
        class: Calculator,
        deps: [t('Tracer')],
        factory: () => new Calculator(),
        interceptors: {
          multiply: { async: false, chain: [{ dep: 0, options: { name: 'multiply' } }] },
          slowAdd: { async: true, chain: [{ dep: 0, options: { name: 'slowAdd' } }] },
        },
      },
    })

  for (const scope of ['singleton', 'request', 'transient'] as const) {
    it(`applies definition interceptors right after the factory (${scope})`, async () => {
      log.length = 0
      const container = Container.create(definitions(scope))
      await container.init()
      const result = await container.runInScope(async () => {
        const calculator = container.get(Calculator)
        return [calculator.double(2), await calculator.slowAdd(1, 1)]
      })
      expect(result).toEqual([4, 2])
      expect(log).toEqual(['before:multiply', 'after:multiply', 'before:slowAdd', 'after:slowAdd'])
    })
  }

  it('applies interceptors to async singletons after they resolve', async () => {
    const calls: string[] = []
    const container = Container.create(
      meta({
        [t('Interceptor')]: factoryDef(() => ({
          intercept: (invocation: MethodInvocation) => {
            calls.push(invocation.methodName)
            return invocation.proceed()
          },
        })),
        [t('Service')]: factoryDef(async () => ({ ping: () => 'pong' }), [t('Interceptor')], {
          async: true,
          interceptors: { ping: { async: false, chain: [{ dep: 0 }] } },
        }),
      }),
    )
    await container.init()
    expect(container.get<{ ping(): string }>(t('Service')).ping()).toBe('pong')
    expect(calls).toEqual(['ping'])
  })
})
