/**
 * Marker decorators of `@znight/schedule`. Like every Znight decorator they do nothing at runtime:
 * the compiler extension (`@znight/schedule/compiler`) reads them from the source code, validates
 * them and generates `metadata.extensions.schedule`. Every argument is _static_ (literals, `const`
 * references, simple expressions); values that depend on the environment go through the plugin's
 * `jobs` option.
 */
import type { JobContext } from './context.ts'
import type { Duration } from './duration.ts'
import type { CronOptions, IntervalOptions, TimeoutOptions } from './options.ts'

/** Type-checks the decorated method: `(ctx: JobContext) => unknown` (a method without parameter fits). */
export type JobMethodMarker = <F extends (ctx: JobContext) => unknown>(
  target: object,
  propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext<unknown, F>,
  descriptor?: TypedPropertyDescriptor<F>,
) => void

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const jobMarker: JobMethodMarker = marker

/**
 * Runs the method on a cron schedule: 5 fields (`minute hour day-of-month month day-of-week`), 6 with
 * the seconds first, or a nickname (`@daily`). Evaluated on the wall clock of `timeZone` (default:
 * the plugin's `timeZone`, `'UTC'`).
 *
 * ```ts
 * @Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
 * async sendDaily(ctx: JobContext): Promise<void> {}
 * ```
 */
export function Cron(_expression: string, _options?: CronOptions): JobMethodMarker {
  return jobMarker
}

/**
 * Runs the method every `every` (`'1m'`, `30_000`), at the multiples of `every` since the Unix epoch:
 * every instance and every restart agree on the occurrences.
 */
export function Interval(_every: Duration, _options?: IntervalOptions): JobMethodMarker {
  return jobMarker
}

/** Runs the method once, `delay` after the scheduler started (`@Timeout(0)`: right at start). */
export function Timeout(_delay: Duration, _options?: TimeoutOptions): JobMethodMarker {
  return jobMarker
}
