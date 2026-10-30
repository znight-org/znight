/**
 * Schedule section of the generated metadata (`__ZNIGHT_METADATA__.extensions.schedule`), produced
 * by the `@znight/schedule/compiler` extension and consumed by `SchedulePlugin` (RFC 0004 §6). The
 * plugin validates it at boot, because metadata can be hand-written.
 */
import type { Token } from '@znight/core'
import type { JobContext } from './context.ts'

/** The jobs of the application. */
export interface ScheduleMetadata {
  /** Sorted by name. */
  readonly jobs: readonly ScheduledJobDefinition[]
}

/** One `@Cron`, `@Interval` or `@Timeout` decorator. */
export type ScheduledJobDefinition = CronJobDefinition | IntervalJobDefinition | TimeoutJobDefinition

/** What every job definition has. */
export interface JobDefinitionBase {
  readonly name: string
  /** Provider token of the host class. */
  readonly token: Token
  readonly method: string
  /** Absent: `'skip'`. Never present on timeouts. */
  readonly overlap?: 'queue' | 'allow'
  /** Absent: the plugin rule (locked when a store is configured, unless overlap is `'allow'`). */
  readonly lock?: boolean
  /** Milliseconds. */
  readonly maxDuration?: number
  /** Only `false` is emitted. */
  readonly enabled?: false
  /** `(c: Host) => c.method()` or `(c: Host, j: JobContext) => c.method(j)`. */
  // biome-ignore lint/suspicious/noExplicitAny: generated invokers receive the concrete host class
  readonly invoke: (host: any, ctx: JobContext) => unknown
}

/** A `@Cron` job. */
export interface CronJobDefinition extends JobDefinitionBase {
  readonly kind: 'cron'
  /** As written, whitespace collapsed to single spaces. */
  readonly cron: string
  /** As written. Absent: the plugin's `timeZone`. */
  readonly timeZone?: string
  readonly runOnStart?: true
}

/** An `@Interval` job. */
export interface IntervalJobDefinition extends JobDefinitionBase {
  readonly kind: 'interval'
  /** Milliseconds. */
  readonly every: number
  readonly runOnStart?: true
}

/** A `@Timeout` job. */
export interface TimeoutJobDefinition extends JobDefinitionBase {
  readonly kind: 'timeout'
  /** Milliseconds after the scheduler started. */
  readonly delay: number
}

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly schedule?: ScheduleMetadata
  }
}
