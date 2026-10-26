import {
  Container,
  ErrorCode,
  getSuppressedErrors,
  InstantiationError,
  type Lazy,
  type MethodInterceptor,
  ZnightError,
} from '../src/index.ts'
import { caught, caughtSync, classDef, factoryDef, later, meta, sleep, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const LOGGER = '@znight/observability#Logger'

function recorder(): { log: string[]; def: (name: string, deps?: string[], extra?: object) => object } {
  const log: string[] = []
  return {
    log,
    def: (name, deps = [], extra = {}) =>
      factoryDef(
        () => {
          log.push(name)
          return { name }
        },
        deps,
        extra,
      ),
  }
}

describe('init order', () => {
  it('instantiates singletons in resolutionOrder (dependencies first)', async () => {
    const { log, def } = recorder()
    const container = Container.create(
      meta(
        {
          [t('C')]: def('C', [t('B')]),
          [t('A')]: def('A'),
          [t('B')]: def('B', [t('A')]),
          [t('D')]: def('D'),
        } as never,
        { order: [t('D'), t('A'), t('B'), t('C')] },
      ),
    )
    await container.init()
    expect(log).toEqual(['D', 'A', 'B', 'C'])
  })

  it('does not instantiate request-scoped or transient providers at init', async () => {
    const { log, def } = recorder()
    const container = Container.create(
      meta({ [t('R')]: def('R', [], { scope: 'request' }), [t('T')]: def('T', [], { scope: 'transient' }) } as never),
    )
    await container.init()
    expect(log).toEqual([])
  })

  it('inserts runtime definitions right before their first dependent', async () => {
    const { log, def } = recorder()
    const container = Container.create(
      meta({ [t('A')]: def('A'), [t('B')]: def('B', [LOGGER]), [t('C')]: def('C') } as never, {
        order: [t('A'), t('B'), t('C')],
        externals: [{ token: LOGGER }],
      }),
    )
    container.register(LOGGER, def('Logger') as never)
    await container.init()
    expect(log).toEqual(['A', 'Logger', 'B', 'C'])
    expect(container.instances().map(instance => instance.displayName)).toEqual(['A', 'Logger', 'B', 'C'])
  })
})

describe('concurrent initialisation', () => {
  const delayed = (ms: number, log: string[], name: string, deps: string[] = []) =>
    factoryDef(
      async () => {
        log.push(`start ${name}`)
        await sleep(ms)
        log.push(`end ${name}`)
        return name
      },
      deps,
      { async: true },
    )

  it('runs independent async singletons concurrently', async () => {
    const log: string[] = []
    const container = Container.create(
      meta({ [t('A')]: delayed(50, log, 'A'), [t('B')]: delayed(50, log, 'B'), [t('C')]: delayed(50, log, 'C') }),
    )
    const started = performance.now()
    await container.init()
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(120)
    expect(log.slice(0, 3).sort()).toEqual(['start A', 'start B', 'start C'])
    expect(container.get(t('A'))).toBe('A')
  })

  it('starts a factory as soon as its own dependencies settle', async () => {
    const log: string[] = []
    const times = new Map<string, number>()
    const origin = performance.now()
    const container = Container.create(
      meta({
        [t('Fast')]: delayed(10, log, 'Fast'),
        [t('Slow')]: delayed(80, log, 'Slow'),
        [t('Dependent')]: factoryDef(
          async d => {
            times.set('dependent', performance.now() - origin)
            await sleep(1)
            return `after ${String(d[0])}`
          },
          [t('Fast')],
          { async: true },
        ),
        [t('Last')]: factoryDef(d => `${String(d[0])}+${String(d[1])}`, [t('Dependent'), t('Slow')]),
      }),
    )
    await container.init()
    expect(times.get('dependent')).toBeLessThan(60)
    expect(container.get(t('Last'))).toBe('after Fast+Slow')
    expect(log.indexOf('end Fast')).toBeLessThan(log.indexOf('end Slow'))
  })

  it('waits for async singletons reached through transient providers', async () => {
    const log: string[] = []
    const container = Container.create(
      meta({
        [t('Pool')]: delayed(20, log, 'Pool'),
        [t('Helper')]: factoryDef(d => `helper(${String(d[0])})`, [t('Pool')], { scope: 'transient' }),
        [t('Service')]: factoryDef(d => `service(${String(d[0])})`, [t('Helper')]),
      }),
    )
    await container.init()
    expect(container.get(t('Service'))).toBe('service(helper(Pool))')
  })

  it('awaits thenables returned by singleton factories even without async: true', async () => {
    const container = Container.create(meta({ [t('A')]: factoryDef(() => Promise.resolve('value')) }))
    await container.init()
    expect(container.get(t('A'))).toBe('value')
  })
})

describe('init({ only })', () => {
  it('instantiates only the dependency closure of the roots', async () => {
    const { log, def } = recorder()
    const container = Container.create(
      meta({
        [t('Db')]: def('Db'),
        [t('Repo')]: def('Repo', [t('Db')]),
        [t('Controller')]: def('Controller', [t('Repo')], { scope: 'request' }),
        [t('Unrelated')]: def('Unrelated'),
      } as never),
    )
    await container.init({ only: ['Controller'] })
    expect(log).toEqual(['Db', 'Repo'])
    expect(container.instances().map(instance => instance.displayName)).toEqual(['Db', 'Repo'])
    // other singletons are created on first use
    expect(container.get(t('Unrelated'))).toEqual({ name: 'Unrelated' })
    expect(log).toEqual(['Db', 'Repo', 'Unrelated'])
  })

  it('includes lazy targets in the closure', async () => {
    const { log, def } = recorder()
    const container = Container.create(
      meta({ [t('Target')]: def('Target'), [t('Root')]: def('Root', [{ lazy: t('Target') }] as never) } as never),
    )
    await container.init({ only: [t('Root')] })
    expect(log.sort()).toEqual(['Root', 'Target'])
  })

  it('does not report missing providers outside of the closure, until they are used', async () => {
    const container = Container.create(
      meta({ [t('Ok')]: factoryDef(() => 'ok'), [t('Broken')]: factoryDef(() => 'never', [LOGGER]) }),
    )
    await container.init({ only: [t('Ok')] })
    expect(container.get(t('Ok'))).toBe('ok')
    const error = caughtSync(() => container.get(t('Broken'))) as ZnightError
    expect(error.code).toBe(ErrorCode.MissingProvider)
  })

  it('refuses to create async singletons on demand', async () => {
    const container = Container.create(
      meta({ [t('Ok')]: factoryDef(() => 'ok'), [t('Async')]: factoryDef(async () => 'x', [], { async: true }) }),
    )
    await container.init({ only: [t('Ok')] })
    const error = caughtSync(() => container.get(t('Async'))) as ZnightError
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.hints.join(' ')).toContain('init({ only })')
  })

  it('refuses on-demand factories that return a promise without declaring it', async () => {
    const container = Container.create(
      meta({ [t('Ok')]: factoryDef(() => 'ok'), [t('Sneaky')]: factoryDef(() => Promise.resolve('x')) }),
    )
    await container.init({ only: [t('Ok')] })
    expect((caughtSync(() => container.get(t('Sneaky'))) as ZnightError).message).toContain('returned a promise')
  })

  it('rejects unknown roots with ZNIGHT001', async () => {
    const container = Container.create(meta({}))
    const error = (await caught(() => container.init({ only: ['src/nope.ts#Nope'] }))) as ZnightError
    expect(error.code).toBe(ErrorCode.MissingProvider)
  })

  it('reports unbound roots as missing', async () => {
    const container = Container.create(meta({}, { externals: [{ token: LOGGER, providedBy: 'ObservabilityPlugin' }] }))
    const error = (await caught(() => container.init({ only: [LOGGER] }))) as ZnightError
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('requested by init({ only })')
  })
})

describe('graph validation', () => {
  it('reports every missing dependency at once (ZNIGHT001 with providedBy)', async () => {
    const container = Container.create(
      meta(
        {
          [t('Users')]: factoryDef(() => 1, [LOGGER, '@znight/metrics#Registry']),
          [t('Orders')]: factoryDef(() => 1, [LOGGER, { multi: ['src/x.ts#Missing'] }]),
          [t('Audit')]: factoryDef(() => 1, [{ lazy: 'src/y.ts#AlsoMissing' }]),
          [t('Opt')]: factoryDef(() => 1, [{ token: 'src/z.ts#Optional', optional: true }]),
        },
        {
          externals: [
            { token: LOGGER, providedBy: 'ObservabilityPlugin' },
            { token: '@znight/metrics#Registry', providedBy: 'MetricsPlugin' },
            { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
          ],
        },
      ),
    )
    const error = (await caught(() => container.init())) as ZnightError
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('4 required providers are missing')
    expect(error.message).toContain('Logger (@znight/observability#Logger), provided by ObservabilityPlugin')
    expect(error.message).toContain('required by Orders, Users')
    expect(error.message).toContain('Missing (src/x.ts#Missing)')
    expect(error.message).toContain('AlsoMissing')
    expect(error.message).not.toContain('Optional')
    expect(error.message).not.toContain('HttpContext')
    expect(error.hints).toContain('Add ObservabilityPlugin to Application.create({ plugins })')
    expect(error.hints).toContain('Add MetricsPlugin to Application.create({ plugins })')
  })

  it('injects undefined for missing optional dependencies and optional externals', async () => {
    const container = Container.create(
      meta(
        {
          [t('A')]: factoryDef(d => d, [{ token: 'src/x.ts#X', optional: true }, '@x/y#OptionalExternal']),
        },
        { externals: [{ token: '@x/y#OptionalExternal', optional: true }] },
      ),
    )
    await container.init()
    expect(container.get(t('A'))).toEqual([undefined, undefined])
  })

  it('detects cycles introduced by runtime definitions (ZNIGHT002)', async () => {
    const container = Container.create(meta({ [t('A')]: factoryDef(() => 'a', [t('B')]) }))
    container.register(t('B'), factoryDef(() => 'b', [t('C')]) as never)
    container.register(t('C'), factoryDef(() => 'c', [t('A')]) as never)
    const error = (await caught(() => container.init())) as ZnightError
    expect(error.code).toBe(ErrorCode.CircularDependency)
    expect(error.message).toContain('A -> B -> C -> A')
    expect(error.hints[0]).toContain('Lazy<T>')
  })

  it('accepts cycles broken by Lazy<T>', async () => {
    class A {
      readonly b: Lazy<B>
      constructor(b: Lazy<B>) {
        this.b = b
      }
    }
    class B {
      readonly a: A
      constructor(a: A) {
        this.a = a
      }
    }
    const container = Container.create(
      meta({ [t('A')]: classDef(A, [{ lazy: t('B') }]), [t('B')]: classDef(B, [t('A')]) }),
    )
    await container.init()
    expect(container.get(A).b.get()).toBe(container.get(B))
    expect(container.get(B).a).toBe(container.get(A))
  })

  it('rejects a singleton depending on a request-scoped provider (ZNIGHT003)', async () => {
    const container = Container.create(
      meta({
        [t('Ctx')]: factoryDef(() => 'ctx', [], { scope: 'request' }),
        [t('Helper')]: factoryDef(d => d[0], [t('Ctx')], { scope: 'transient' }),
        [t('Service')]: factoryDef(d => d[0], [t('Helper')]),
      }),
    )
    const error = (await caught(() => container.init())) as ZnightError
    expect(error.code).toBe(ErrorCode.ScopeMismatch)
    expect(error.message).toContain('Service -> Helper -> Ctx')
    expect(error.hints[0]).toContain('Lazy<T>')
  })

  it('rejects a singleton depending on a request-scoped external (ZNIGHT003)', async () => {
    const container = Container.create(
      meta(
        { [t('Service')]: factoryDef(d => d[0], ['@znight/http#HttpContext']) },
        { externals: [{ token: '@znight/http#HttpContext', scope: 'request' }] },
      ),
    )
    expect(((await caught(() => container.init())) as ZnightError).code).toBe(ErrorCode.ScopeMismatch)
  })

  it('allows a singleton to reach request-scoped state lazily', async () => {
    const container = Container.create(
      meta({
        [t('Ctx')]: factoryDef(() => ({ id: Math.random() }), [], { scope: 'request' }),
        [t('Service')]: factoryDef(d => d[0], [{ lazy: t('Ctx') }]),
      }),
    )
    await container.init()
    const lazy = container.get<Lazy<{ id: number }>>(t('Service'))
    const [a, b] = await Promise.all([
      container.runInScope(() => [lazy.get(), lazy.get()]),
      container.runInScope(() => lazy.get()),
    ])
    expect(a[0]).toBe(a[1])
    expect(a[0]).not.toBe(b)
    expect((caughtSync(() => lazy.get()) as ZnightError).code).toBe(ErrorCode.NoActiveScope)
  })

  it('rejects malformed dependency references (ZNIGHT005)', async () => {
    const container = Container.create(meta({ [t('A')]: factoryDef(() => 1, [{ nope: true } as never]) }))
    const error = (await caught(() => container.init())) as ZnightError
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
    expect(error.message).toContain('Invalid dependency #0')
  })
})

describe('instantiation failures', () => {
  it('wraps factory errors in ZNIGHT015 with token, dependency path, source and cause', async () => {
    const cause = new Error('connection refused')
    const container = Container.create(
      meta({
        [t('Pool')]: factoryDef(
          () => {
            throw cause
          },
          [],
          { source: { file: 'src/db.ts', line: 12, column: 3 } },
        ),
        [t('Repo')]: factoryDef(d => d[0], [t('Pool')]),
        [t('Service')]: factoryDef(d => d[0], [t('Repo')]),
      }),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect(error).toBeInstanceOf(InstantiationError)
    expect(error).toBeInstanceOf(ZnightError)
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.token).toBe(t('Pool'))
    expect(error.path).toEqual([t('Service'), t('Repo'), t('Pool')])
    expect(error.source).toEqual({ file: 'src/db.ts', line: 12, column: 3 })
    expect(error.cause).toBe(cause)
    expect(error.message).toContain('Failed to instantiate Pool: connection refused')
    expect(error.message).toContain('src/db.ts:12:3')
    expect(error.message).toContain('Service -> Repo -> Pool')
  })

  it('wraps async rejections too', async () => {
    const container = Container.create(
      meta({ [t('A')]: factoryDef(() => Promise.reject(new Error('nope')), [], { async: true }) }),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect((error.cause as Error).message).toBe('nope')
  })

  it('includes transient providers in the path of a failure', async () => {
    const container = Container.create(
      meta({
        [t('Helper')]: factoryDef(
          () => {
            throw new Error('bad helper')
          },
          [],
          { scope: 'transient' },
        ),
        [t('Service')]: factoryDef(d => d[0], [t('Helper')]),
      }),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect(error.token).toBe(t('Helper'))
    expect(error.path).toEqual([t('Service'), t('Helper')])
  })

  it('rolls back created instances in reverse creation order, after in-flight factories settle', async () => {
    const disposed: string[] = []
    const disposable = (name: string) => ({
      name,
      [Symbol.asyncDispose]: () => {
        disposed.push(name)
        return Promise.resolve()
      },
    })
    let dependentCreated = false
    const container = Container.create(
      meta({
        [t('A')]: factoryDef(() => disposable('A')),
        [t('B')]: factoryDef(() => later(5, () => disposable('B')), [], { async: true }),
        [t('C')]: factoryDef(() => later(40, () => disposable('C')), [], { async: true }),
        [t('D')]: factoryDef(() => (dependentCreated = true), [t('C')]),
        [t('Fail')]: factoryDef(
          async () => {
            await sleep(15)
            throw new Error('fail')
          },
          [],
          { async: true },
        ),
      }),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect(error.token).toBe(t('Fail'))
    expect(disposed).toEqual(['C', 'B', 'A'])
    expect(dependentCreated).toBe(false)
    expect(container.instances()).toEqual([])
  })

  it('stops launching factories after a synchronous failure', async () => {
    const { log, def } = recorder()
    const container = Container.create(
      meta(
        {
          [t('A')]: def('A'),
          [t('Fail')]: factoryDef(() => {
            throw new Error('x')
          }),
          [t('Z')]: def('Z'),
        } as never,
        { order: [t('A'), t('Fail'), t('Z')] },
      ),
    )
    await caught(() => container.init())
    expect(log).toEqual(['A'])
  })

  it('attaches cleanup errors and concurrent failures to the rethrown error', async () => {
    const container = Container.create(
      meta(
        {
          [t('A')]: factoryDef(() => ({
            [Symbol.dispose]() {
              throw new Error('cannot close A')
            },
          })),
          [t('F1')]: factoryDef(
            async () => {
              await sleep(5)
              throw new Error('first')
            },
            [],
            { async: true },
          ),
          [t('F2')]: factoryDef(
            async () => {
              await sleep(15)
              throw new Error('second')
            },
            [],
            { async: true },
          ),
        },
        { order: [t('A'), t('F1'), t('F2')] },
      ),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect((error.cause as Error).message).toBe('first')
    const suppressed = getSuppressedErrors(error) as ZnightError[]
    expect(suppressed).toHaveLength(2)
    expect((suppressed[0] as InstantiationError).token).toBe(t('F2'))
    expect(suppressed[1]?.code).toBe(ErrorCode.LifecycleFailed)
    expect(suppressed[1]?.message).toContain('cannot close A')
  })

  it('disposes an instance whose interceptors cannot be applied', async () => {
    const disposed: string[] = []
    const container = Container.create(
      meta({
        [t('Interceptor')]: factoryDef(() => ({}) as MethodInterceptor),
        [t('Service')]: factoryDef(
          () => ({ run: () => 1, [Symbol.dispose]: () => disposed.push('Service') }),
          [t('Interceptor')],
          { interceptors: { run: { async: false, chain: [{ dep: 0 }] } } },
        ),
      }),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect((error.cause as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    expect(disposed).toEqual(['Service'])
  })
})

describe('lazy access during initialisation', () => {
  it('creates a lazily referenced singleton on demand when its dependencies are ready', async () => {
    const { log, def } = recorder()
    const container = Container.create(
      meta(
        {
          [t('Early')]: factoryDef(
            d => {
              log.push('Early')
              return (d[0] as Lazy<{ name: string }>).get().name
            },
            [{ lazy: t('Late') }],
          ),
          [t('Late')]: def('Late'),
        } as never,
        { order: [t('Early'), t('Late')] },
      ),
    )
    await container.init()
    expect(container.get(t('Early'))).toBe('Late')
    expect(log).toEqual(['Early', 'Late'])
  })

  it('reports a cycle when a lazy reference is used during the construction it depends on', async () => {
    class A {
      readonly b: unknown
      constructor(b: Lazy<unknown>) {
        this.b = b.get()
      }
    }
    const container = Container.create(
      meta({ [t('A')]: classDef(A, [{ lazy: t('B') }]), [t('B')]: factoryDef(d => d[0], [t('A')]) }),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect((error.cause as ZnightError).code).toBe(ErrorCode.CircularDependency)
  })

  it('reports an async lazy target that is not ready yet', async () => {
    const container = Container.create(
      meta(
        {
          [t('Slow')]: factoryDef(() => later(10, 'slow'), [], { async: true }),
          [t('Eager')]: factoryDef(d => (d[0] as Lazy<string>).get(), [{ lazy: t('Slow') }]),
        },
        { order: [t('Slow'), t('Eager')] },
      ),
    )
    const error = (await caught(() => container.init())) as InstantiationError
    expect((error.cause as ZnightError).message).toContain('not ready yet')
  })
})
