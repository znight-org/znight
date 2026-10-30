/**
 * Cold start: the time from spawning `node dist/main.js` (or `bun dist/main.js`) to the first `200`
 * of `GET /users/1`, and the resident memory of the idle server right after.
 */
import type { BootResult, BootSettings, Suite } from './results.ts'
import type { Runtime, Variant } from './variants.ts'

import { environment } from './environment.ts'
import { rssMiB, start, stop } from './process.ts'
import { summarize } from './stats.ts'

export interface BootOptions {
  readonly variants: readonly Variant[]
  readonly runtimes: readonly Runtime[]
  readonly runs: number
  readonly idleMs: number
  readonly log: (message: string) => void
}

/** `items` rotated by `offset`: each run starts with another variant, so that no one always goes first. */
export function rotate<T>(items: readonly T[], offset: number): T[] {
  const shift = offset % Math.max(items.length, 1)
  return [...items.slice(shift), ...items.slice(0, shift)]
}

export async function bootSuite(options: BootOptions): Promise<Suite<BootSettings, BootResult>> {
  const samples = new Map<string, { ready: number[]; rss: number[] }>()
  const key = (variant: Variant, runtime: Runtime): string => `${variant.id}@${runtime}`
  const startVariant = (variant: Variant, runtime: Runtime) =>
    start({ runtime, cwd: variant.dir, entry: variant.entry, env: variant.env, probe: '/users/1' })

  // One discarded start of each application: the file system cache is warm for every measured run
  for (const runtime of options.runtimes) {
    for (const variant of options.variants) {
      const { child } = await startVariant(variant, runtime)
      await stop(child)
      samples.set(key(variant, runtime), { ready: [], rss: [] })
    }
  }

  for (let run = 0; run < options.runs; run++) {
    for (const runtime of rotate(options.runtimes, run)) {
      for (const variant of rotate(options.variants, run)) {
        const { child, readyMs } = await startVariant(variant, runtime)
        await Bun.sleep(options.idleMs)
        const rss = rssMiB(child.pid)
        await stop(child)
        const entry = samples.get(key(variant, runtime))
        entry?.ready.push(readyMs)
        entry?.rss.push(rss)
      }
    }
    options.log(`boot: run ${run + 1}/${options.runs}`)
  }

  const results: BootResult[] = []
  for (const runtime of options.runtimes) {
    for (const variant of options.variants) {
      const entry = samples.get(key(variant, runtime)) ?? { ready: [], rss: [] }
      results.push({
        variant: variant.id,
        framework: variant.framework,
        adapter: variant.adapter,
        runtime,
        readyMs: summarize(entry.ready, 1),
        rssMiB: summarize(entry.rss, 1),
      })
    }
  }
  return {
    environment: environment(),
    settings: { runs: options.runs, idleMs: options.idleMs },
    results,
  }
}
