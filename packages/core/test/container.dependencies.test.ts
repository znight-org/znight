import { Container, ErrorCode, InstantiationError, type Lazy, type ZnightError } from '../src/index.ts'
import { caught, caughtSync, classDef, factoryDef, meta, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

interface Plugin {
  readonly name: string
}

describe('multi dependencies', () => {
  it('injects an array of instances in the given order', async () => {
    const container = Container.create(
      meta({
        [t('B')]: factoryDef(() => ({ name: 'b' })),
        [t('A')]: factoryDef(() => ({ name: 'a' })),
        [t('Registry')]: factoryDef(d => (d[0] as Plugin[]).map(plugin => plugin.name), [{ multi: [t('A'), t('B')] }]),
        [t('Empty')]: factoryDef(d => d[0], [{ multi: [] }]),
      }),
    )
    await container.init()
    expect(container.get(t('Registry'))).toEqual(['a', 'b'])
    expect(container.get(t('Empty'))).toEqual([])
  })

  it('creates a fresh transient for each multi entry', async () => {
    let created = 0
    const container = Container.create(
      meta({
        [t('T')]: factoryDef(() => ++created, [], { scope: 'transient' }),
        [t('Consumer')]: factoryDef(d => d[0], [{ multi: [t('T'), t('T')] }]),
      }),
    )
    await container.init()
    expect(container.get(t('Consumer'))).toEqual([1, 2])
  })
})

describe('optional dependencies', () => {
  it('injects the instance when it exists and undefined otherwise', async () => {
    const container = Container.create(
      meta({
        [t('Present')]: factoryDef(() => 'present'),
        [t('Consumer')]: factoryDef(
          d => d,
          [
            { token: t('Present'), optional: true },
            { token: t('Absent'), optional: true },
          ],
        ),
      }),
    )
    await container.init()
    expect(container.get(t('Consumer'))).toEqual(['present', undefined])
  })

  it('picks up a value registered for an optional token', async () => {
    const container = Container.create(
      meta({ [t('Consumer')]: factoryDef(d => d[0], [{ token: '@acme/cache#Cache', optional: true }]) }),
    )
    container.registerValue('@acme/cache#Cache', 'cache')
    await container.init()
    expect(container.get(t('Consumer'))).toBe('cache')
  })
})

describe('Lazy<T>', () => {
  it('resolves singletons at call time and returns the same instance', async () => {
    class Service {
      readonly dep: Lazy<{ name: string }>
      constructor(dep: Lazy<{ name: string }>) {
        this.dep = dep
      }
    }
    const container = Container.create(
      meta({
        [t('Service')]: classDef(Service, [{ lazy: t('Target') }]),
        [t('Target')]: factoryDef(() => ({ name: 'x' })),
      }),
    )
    await container.init()
    const service = container.get(Service)
    expect(service.dep.get()).toBe(container.get(t('Target')))
    expect(service.dep.get()).toBe(service.dep.get())
  })

  it('creates a new transient on every get()', async () => {
    let created = 0
    const container = Container.create(
      meta({
        [t('T')]: factoryDef(() => ++created, [], { scope: 'transient' }),
        [t('Holder')]: factoryDef(d => d[0], [{ lazy: t('T') }]),
      }),
    )
    await container.init()
    const lazy = container.get<Lazy<number>>(t('Holder'))
    expect(created).toBe(0)
    expect([lazy.get(), lazy.get()]).toEqual([1, 2])
  })

  it('reflects overrides', async () => {
    const container = Container.create(
      meta({ [t('Target')]: factoryDef(() => 'real'), [t('Holder')]: factoryDef(d => d[0], [{ lazy: t('Target') }]) }),
    )
    container.override(t('Target'), 'fake')
    await container.init()
    expect(container.get<Lazy<string>>(t('Holder')).get()).toBe('fake')
  })
})

describe('transient providers', () => {
  it('creates a new instance for every resolution and injection', async () => {
    class Counter {
      static count = 0
      readonly id = ++Counter.count
    }
    const container = Container.create(
      meta({
        [t('Counter')]: classDef(Counter, [], { scope: 'transient' }),
        [t('A')]: factoryDef(d => d[0], [t('Counter')]),
        [t('B')]: factoryDef(d => d[0], [t('Counter')]),
      }),
    )
    await container.init()
    const a = container.get<Counter>(t('A'))
    const b = container.get<Counter>(t('B'))
    expect(a).not.toBe(b)
    expect(container.get(Counter)).not.toBe(container.get(Counter))
    expect(container.get<Counter>(t('A'))).toBe(a)
  })

  it('wraps factory errors in ZNIGHT015 with the resolution path', async () => {
    const container = Container.create(
      meta({
        [t('Leaf')]: factoryDef(
          () => {
            throw new TypeError('leaf failed')
          },
          [],
          { scope: 'transient' },
        ),
        [t('Middle')]: factoryDef(d => d[0], [t('Leaf')], { scope: 'transient' }),
      }),
    )
    await container.init()
    const error = caughtSync(() => container.get(t('Middle'))) as InstantiationError
    expect(error).toBeInstanceOf(InstantiationError)
    expect(error.path).toEqual([t('Middle'), t('Leaf')])
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it('keeps ZNIGHT013 visible when a transient needs a scope', async () => {
    const container = Container.create(
      meta({
        [t('Ctx')]: factoryDef(() => 'ctx', [], { scope: 'request' }),
        [t('Helper')]: factoryDef(d => d[0], [t('Ctx')], { scope: 'transient' }),
      }),
    )
    await container.init()
    expect((caughtSync(() => container.get(t('Helper'))) as ZnightError).code).toBe(ErrorCode.NoActiveScope)
    expect(await container.runInScope(() => container.get(t('Helper')))).toBe('ctx')
  })

  it('does not dispose transient instances (they belong to their consumer)', async () => {
    let disposed = false
    const container = Container.create(
      meta({
        [t('T')]: factoryDef(() => ({ [Symbol.dispose]: () => (disposed = true) }), [], { scope: 'transient' }),
        [t('Owner')]: factoryDef(d => ({ helper: d[0] }), [t('T')]),
      }),
    )
    await container.init()
    await container.runInScope(() => container.get(t('T')))
    await container.dispose()
    expect(disposed).toBe(false)
  })
})

describe('request-scoped factory failures', () => {
  it('wraps errors and does not cache the failed instance', async () => {
    let attempts = 0
    const container = Container.create(
      meta({
        [t('Flaky')]: factoryDef(
          () => {
            attempts++
            if (attempts === 1) throw new Error('first attempt')
            return 'ok'
          },
          [],
          { scope: 'request' },
        ),
      }),
    )
    await container.init()
    const value = await container.runInScope(() => {
      const error = caughtSync(() => container.get(t('Flaky'))) as InstantiationError
      expect(error.code).toBe(ErrorCode.InstantiationFailed)
      return container.get(t('Flaky'))
    })
    expect(value).toBe('ok')
  })

  it('surfaces request failures through runInScope', async () => {
    const container = Container.create(
      meta({
        [t('Broken')]: factoryDef(
          () => {
            throw new Error('nope')
          },
          [],
          { scope: 'request' },
        ),
      }),
    )
    await container.init()
    const error = (await caught(() => container.runInScope(() => container.get(t('Broken'))))) as InstantiationError
    expect(error.token).toBe(t('Broken'))
  })
})
