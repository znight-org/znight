import { Container, ErrorCode, ZnightAggregateError, type ZnightError } from '../src/index.ts'
import { caught, caughtSync, factoryDef, later, meta, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('Container.dispose', () => {
  it('disposes singletons in reverse resolution order with the right mechanism', async () => {
    const log: string[] = []
    const container = Container.create(
      meta(
        {
          [t('Pool')]: factoryDef(() => ({ end: () => later(1, () => log.push('Pool.end')) }), [], {
            dispose: 'end',
          }),
          [t('Cache')]: factoryDef(
            () => ({
              [Symbol.asyncDispose]: async () => log.push('Cache.asyncDispose'),
              [Symbol.dispose]: () => log.push('Cache.dispose (must not run)'),
            }),
            [t('Pool')],
          ),
          [t('Timer')]: factoryDef(() => ({ [Symbol.dispose]: () => log.push('Timer.dispose') }), [t('Cache')]),
          [t('Plain')]: factoryDef(() => ({ value: 1 }), [t('Timer')]),
        },
        { order: [t('Pool'), t('Cache'), t('Timer'), t('Plain')] },
      ),
    )
    await container.init()
    await container.dispose()
    expect(log).toEqual(['Timer.dispose', 'Cache.asyncDispose', 'Pool.end'])
  })

  it('does not dispose registered values or overrides', async () => {
    let disposed = 0
    const value = { [Symbol.dispose]: () => disposed++ }
    const container = Container.create(meta({ [t('Real')]: factoryDef(() => 'real') }))
    container.registerValue('@x/y#External', value)
    container.override(t('Real'), value)
    await container.init()
    await container.dispose()
    expect(disposed).toBe(0)
  })

  it('aggregates failures (ZNIGHT021) and still disposes the others', async () => {
    const log: string[] = []
    const container = Container.create(
      meta(
        {
          [t('A')]: factoryDef(() => ({ [Symbol.dispose]: () => log.push('A') })),
          [t('B')]: factoryDef(() => ({
            [Symbol.dispose]: () => {
              throw new Error('B failed')
            },
          })),
          [t('C')]: factoryDef(() => ({ close: 1 }), [], { dispose: 'close' }),
        },
        { order: [t('A'), t('B'), t('C')] },
      ),
    )
    await container.init()
    const error = (await caught(() => container.dispose())) as ZnightAggregateError
    expect(error).toBeInstanceOf(ZnightAggregateError)
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.errors).toHaveLength(2)
    expect(error.message).toContain('has no method "close"')
    expect(error.message).toContain('B failed')
    expect(log).toEqual(['A'])
  })

  it('is idempotent and blocks later resolutions', async () => {
    let disposed = 0
    const container = Container.create(
      meta({
        [t('A')]: factoryDef(() => ({ [Symbol.dispose]: () => disposed++ })),
        [t('Unused')]: factoryDef(() => 'unused'),
      }),
    )
    await container.init({ only: [t('A')] })
    const first = container.dispose()
    expect(container.dispose()).toBe(first)
    await first
    expect(disposed).toBe(1)
    for (const key of [t('A'), t('Unused')]) {
      const error = caughtSync(() => container.get(key)) as ZnightError
      expect(error.code).toBe(ErrorCode.InstantiationFailed)
      expect(error.message).toContain('disposed')
    }
    expect(container.instances()).toEqual([])
  })

  it('waits for an in-progress init and disposes what it created', async () => {
    let disposed = false
    const container = Container.create(
      meta({
        [t('Slow')]: factoryDef(() => later(10, { [Symbol.dispose]: () => (disposed = true) }), [], {
          async: true,
        }),
      }),
    )
    const init = container.init()
    await container.dispose()
    await init
    expect(disposed).toBe(true)
  })

  it('works on a container that was never initialised', async () => {
    const container = Container.create(meta({ [t('A')]: factoryDef(() => 'a') }))
    await container.dispose()
    expect(container.instances()).toEqual([])
    const error = (await caught(() => container.init())) as ZnightError
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.message).toContain('disposed')
  })
})

describe('instances()', () => {
  it('lists instantiated singletons in resolution order with an idempotent dispose()', async () => {
    let disposed = 0
    const container = Container.create(
      meta(
        {
          [t('A')]: factoryDef(() => ({ [Symbol.dispose]: () => disposed++ })),
          [t('B')]: factoryDef(() => 'b', [t('A')]),
          [t('Request')]: factoryDef(() => 'r', [], { scope: 'request' }),
        },
        { order: [t('A'), t('B'), t('Request')] },
      ),
    )
    container.registerValue('@x/y#Value', 1)
    expect(container.instances()).toEqual([])
    await container.init()
    const instances = container.instances()
    expect(instances.map(instance => instance.token)).toEqual([t('A'), t('B')])
    expect(instances[1]?.instance).toBe('b')
    expect(instances[1]?.definition.deps).toEqual([t('A')])
    await instances[0]?.dispose()
    await instances[0]?.dispose()
    expect(disposed).toBe(1)
    expect(container.instances().map(instance => instance.displayName)).toEqual(['B'])
  })
})
