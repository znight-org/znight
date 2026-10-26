// Runs on Node.js with --expose-gc: the prom-client registries (and their metrics) of registries
// collecting the default process metrics (one per application) must be garbage collected once
// dropped. prom-client's collectors (GC PerformanceObserver) are never released: they must not
// retain them.
// Usage: node --expose-gc --conditions=@znight/source test/fixtures/node-metrics-gc.mjs

import { Application } from '@znight/core'

import { MetricsRegistry, ObservabilityPlugin } from '../../src/index.ts'

const COUNT = 10
const metadata = { version: 1, compiler: '0.1.0', providers: {}, resolutionOrder: [], externals: [] }

/** Weak references to the prom-client registries of dropped `MetricsRegistry`s and applications. */
async function createAndDrop() {
  const registries = []
  for (let index = 0; index < COUNT; index++) registries.push(new WeakRef(new MetricsRegistry().registry))
  const applications = []
  for (let index = 0; index < COUNT; index++) {
    const plugin = ObservabilityPlugin.configure({
      logging: { destination: { write: () => undefined } },
      tracing: false,
      metrics: { server: false },
    })
    const app = await Application.create({ metadata, plugins: [plugin], shutdown: { signals: false } })
    await app.start()
    await plugin.metrics.metrics()
    await app.stop()
    applications.push(new WeakRef(plugin.metrics.registry))
  }
  return { registries, applications }
}

// in a function: the suspended top-level await must not hold the last application in a register
const { registries, applications } = await createAndDrop()
for (let round = 0; round < 3; round++) {
  await new Promise(resolve => setTimeout(resolve, 10))
  globalThis.gc()
}
const alive = refs => refs.filter(ref => ref.deref() !== undefined).length
process.stdout.write(JSON.stringify({ registries: alive(registries), applications: alive(applications) }))
