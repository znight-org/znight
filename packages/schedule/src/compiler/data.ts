/**
 * Data stored by the extension during analysis (`ctx.store()`), read back by `validate` and
 * `generate`. The host is kept as its `ClassInfo`, so that compiled libraries record its public
 * identity (`znight.providers.json`).
 */
import type { ClassInfo, Location } from '@znight/compiler'

/** One `@Cron`, `@Interval` or `@Timeout` decorator. */
export interface JobData {
  readonly kind: 'job'
  /** Explicit `name`, or `<Class>.<method>`. */
  readonly name: string
  readonly explicitName: boolean
  /** The host class (its identity is the provider token). */
  readonly host: ClassInfo
  readonly method: string
  readonly trigger: 'cron' | 'interval' | 'timeout'
  /** Cron jobs: the expression, whitespace collapsed (nicknames kept). */
  readonly cron: string | undefined
  /** Intervals: milliseconds. */
  readonly every: number | undefined
  /** Timeouts: milliseconds. */
  readonly delay: number | undefined
  /** Cron jobs: the zone as written. */
  readonly timeZone: string | undefined
  /** Absent: `'skip'`. */
  readonly overlap: 'queue' | 'allow' | undefined
  readonly lock: boolean | undefined
  readonly maxDuration: number | undefined
  readonly enabled: false | undefined
  readonly runOnStart: true | undefined
  /** The method declares the `ctx` parameter. */
  readonly takesContext: boolean
  /** Location of the decorator. */
  readonly location: Location
  /** Location of the `name` option, or of the decorator. */
  readonly nameLocation: Location
}

/** Everything the extension stores. */
export type ScheduleData = JobData
