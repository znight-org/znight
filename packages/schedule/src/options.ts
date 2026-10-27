/**
 * Options of the job decorators and of dynamic jobs (RFC 0004 §4.2).
 */
import type { Duration } from './duration.ts'

/** What happens when an occurrence fires while the previous run of the job still runs. */
export type OverlapPolicy = 'skip' | 'queue' | 'allow'

/** Options shared by `@Cron`, `@Interval` and `@Timeout`. */
export interface JobOptions {
  /** Unique name (logs, metrics, lock keys, registry). Default `<Class>.<method>`. */
  readonly name?: string
  /** `false`: declared, listed by the registry, never scheduled (enable it with the plugin's `jobs` option). Default `true`. */
  readonly enabled?: boolean
  /** Run on one instance only, through the plugin's lock store. Default: `true` when a store is configured and `overlap` is not `'allow'`. */
  readonly lock?: boolean
  /** Aborts `ctx.signal` after this duration (the run keeps its overlap slot until it settles). Default: none. */
  readonly maxDuration?: Duration
}

/** Options of `@Cron`. */
export interface CronOptions extends JobOptions {
  /** IANA name, `'UTC'`, a fixed offset (`'+05:30'`) or `'local'`. Default: the plugin's `timeZone` (`'UTC'`). */
  readonly timeZone?: string
  /** Default `'skip'`. */
  readonly overlap?: OverlapPolicy
  /** Also run once when the scheduler starts. Default `false`. */
  readonly runOnStart?: boolean
}

/** Options of `@Interval`. */
export interface IntervalOptions extends JobOptions {
  /** Default `'skip'`. */
  readonly overlap?: OverlapPolicy
  /** Also run once when the scheduler starts. Default `false`. */
  readonly runOnStart?: boolean
}

/** Options of `@Timeout`. */
export type TimeoutOptions = JobOptions

/** Overlap policies, for validation. */
export const OVERLAP_POLICIES: readonly OverlapPolicy[] = Object.freeze(['skip', 'queue', 'allow'])
