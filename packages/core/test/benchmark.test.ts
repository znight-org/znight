import { Container, type ProviderDefinition } from '../src/index.ts'
import { classDef, factoryDef, meta, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

/**
 * Micro-benchmarks. They log throughput and only assert very loose bounds (they must not be flaky
 * on slow CI machines): their purpose is to make regressions visible in the test output.
 */

class Service {
  readonly value = 1
}

function chain(size: number): Record<string, ProviderDefinition> {
  const providers: Record<string, ProviderDefinition> = {}
  for (let index = 0; index < size; index++) {
    providers[t(`P${index}`)] = factoryDef(d => ({ index, previous: d[0] }), index === 0 ? [] : [t(`P${index - 1}`)])
  }
  return providers
}

function rate(operations: number, ms: number): string {
  return `${Math.round(operations / (ms / 1000)).toLocaleString('en-US')} ops/s`
}

describe('benchmarks', () => {
  it('resolves singletons with a couple of Map lookups', async () => {
    const container = Container.create(meta({ [t('Service')]: classDef(Service) }))
    await container.init()
    const iterations = 1_000_000
    let sink = 0
    for (let index = 0; index < 10_000; index++) sink += container.get(Service).value // warm-up
    let started = performance.now()
    for (let index = 0; index < iterations; index++) sink += container.get(Service).value
    const byClass = performance.now() - started
    started = performance.now()
    for (let index = 0; index < iterations; index++) sink += container.get<Service>(t('Service')).value
    const byToken = performance.now() - started
    console.log(`[bench] get(Class): ${rate(iterations, byClass)} | get(token): ${rate(iterations, byToken)}`)
    expect(sink).toBe(2 * iterations + 10_000)
    expect(iterations / (byClass / 1000)).toBeGreaterThan(100_000)
  })

  it('initialises a 10k-provider dependency chain linearly, without deep recursion', async () => {
    const size = 10_000
    const container = Container.create(meta(chain(size)))
    const started = performance.now()
    await container.init()
    const elapsed = performance.now() - started
    console.log(`[bench] init of a ${size}-provider chain: ${elapsed.toFixed(1)}ms`)
    expect((container.get(t(`P${size - 1}`)) as { index: number }).index).toBe(size - 1)
    expect(elapsed).toBeLessThan(5_000)
  })

  it('opens request scopes cheaply', async () => {
    const container = Container.create(
      meta({ [t('Request')]: factoryDef(() => ({ id: 1 }), [], { scope: 'request' }) }),
    )
    await container.init()
    const iterations = 50_000
    const started = performance.now()
    for (let index = 0; index < iterations; index++) {
      await container.runInScope(() => container.get(t('Request')), [['@x/y#Ctx', index]])
    }
    const elapsed = performance.now() - started
    console.log(`[bench] runInScope + request-scoped get: ${rate(iterations, elapsed)}`)
    expect(elapsed).toBeLessThan(10_000)
  })
})
