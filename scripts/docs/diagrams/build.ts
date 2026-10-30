import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Generates the documentation diagrams (docs/public/diagrams/*.svg).
 * Usage: bun scripts/docs/diagrams/build.ts [outDir] [name,name...]
 */
const out = process.argv[2] ?? join(import.meta.dir, '../../../docs/public/diagrams')
const only = process.argv[3]
const diagrams: Record<string, () => Promise<string>> = {
  'lifecycle-states': async () => (await import('./lifecycle-states.ts')).lifecycleStates(),
  'compiler-pipeline': async () => (await import('./compiler-pipeline.ts')).compilerPipeline(),
  'lifecycle-sequence': async () => (await import('./lifecycle-sequence.ts')).lifecycleSequence(),
  'feature-package': async () => (await import('./feature-package.ts')).featurePackage(),
  scopes: async () => (await import('./scopes.ts')).scopes(),
  'messaging-delivery': async () => (await import('./messaging.ts')).messagingDelivery(),
  'http-pipeline': async () => (await import('./http-pipeline.ts')).httpPipeline(),
  binding: async () => (await import('./binding.ts')).binding(),
  overview: async () => (await import('./overview.ts')).overview(),
}
for (const [name, make] of Object.entries(diagrams)) {
  if (only && !only.split(',').includes(name)) continue
  writeFileSync(join(out, `${name}.svg`), await make())
  console.log('wrote', name)
}
