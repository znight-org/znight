/**
 * The headline numbers of the benchmarks, derived from the results file: the docs home page, the
 * benchmarks page and the root README show these strings, and `docs/test/benchmarks.test.ts`
 * checks that they still match the results. Pure functions: the docs theme imports them.
 *
 * Every comparison is Znight against NestJS with the same adapter (Fastify) on Node.js. A ratio is
 * rounded down (never overstated), and a comparison that Znight does not clearly win is left out.
 */
import type { BootResult, DiResult, Results } from './results.ts'

export interface Highlight {
  /** The big number: `1.9×`, `27%`. */
  readonly value: string
  /** What it measures: `faster cold start than NestJS`. */
  readonly label: string
  /** The two measurements behind it: `133 ms vs 253 ms to the first response`. */
  readonly detail: string
}

export interface Highlights {
  readonly items: readonly Highlight[]
  /** Where and how: `Medians on an Apple M5 with Node.js 24.21.0 · HTTP applications on Fastify`. */
  readonly context: string
}

/** Below this ratio, a comparison is not put forward. */
const MIN_RATIO = 1.2

/** `value` rounded down to one decimal: 1.97 → `1.9`. */
export function floorRatio(value: number): string {
  return (Math.floor(value * 10) / 10).toFixed(1)
}

/** `1000` → `1,000`. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

function boot(results: Results, variant: string): BootResult | undefined {
  return results.boot?.results.find(r => r.variant === variant && r.runtime === 'node')
}

function container(results: Results, framework: string, providers: number): DiResult | undefined {
  return results.di?.results.find(r => r.framework === framework && r.providers === providers && r.runtime === 'node')
}

/** The largest generated graph of the dependency injection suite. */
function largestGraph(results: Results): number | undefined {
  const sizes = results.di?.settings.sizes ?? []
  return sizes.length === 0 ? undefined : Math.max(...sizes)
}

export function highlights(results: Results): Highlights {
  const items: Highlight[] = []

  const znight = boot(results, 'znight-fastify')
  const nest = boot(results, 'nestjs-fastify')
  if (znight !== undefined && nest !== undefined) {
    const ratio = nest.readyMs.median / znight.readyMs.median
    if (ratio >= MIN_RATIO) {
      items.push({
        value: `${floorRatio(ratio)}×`,
        label: 'faster cold start than NestJS',
        detail: `${Math.round(znight.readyMs.median)} ms vs ${Math.round(nest.readyMs.median)} ms to the first response`,
      })
    }
    const saved = 1 - znight.rssMiB.median / nest.rssMiB.median
    if (saved * 100 >= 10) {
      items.push({
        value: `${Math.floor(saved * 100)}%`,
        label: 'less memory than NestJS',
        detail: `${Math.round(znight.rssMiB.median)} MiB vs ${Math.round(nest.rssMiB.median)} MiB resident at idle`,
      })
    }
  }

  const providers = largestGraph(results)
  const ours = providers === undefined ? undefined : container(results, 'znight', providers)
  const theirs = providers === undefined ? undefined : container(results, 'nestjs', providers)
  if (providers !== undefined && ours !== undefined && theirs !== undefined) {
    const ratio = theirs.containerMs.median / ours.containerMs.median
    if (ratio >= MIN_RATIO) {
      items.push({
        value: `${floorRatio(ratio)}×`,
        label: 'faster DI container than NestJS',
        detail: `${Math.round(ours.containerMs.median)} ms vs ${Math.round(theirs.containerMs.median)} ms to create ${formatCount(providers)} providers`,
      })
    }
  }

  const environment = results.boot?.environment ?? results.di?.environment
  const context =
    environment === undefined
      ? ''
      : `Medians on an ${environment.machine} with Node.js ${environment.runtimes.node} · HTTP applications on Fastify`
  return { items, context }
}
