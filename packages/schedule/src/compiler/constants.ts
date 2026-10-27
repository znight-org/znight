/**
 * Constants shared by the compiler extension modules. This module must stay free of runtime imports:
 * the extension entry is loaded by the compiler, which must never load the schedule runtime.
 */
import type { ErrorCode } from '@znight/core'

/** Name of the extension, also the key of `metadata.extensions.schedule`. */
export const EXTENSION_NAME = 'schedule'

/** Module the generated code imports its types from. */
export const RUNTIME_MODULE = '@znight/schedule'

/** Canonical identities of the decorators owned by the extension. */
export const ScheduleDecorator: {
  readonly Cron: '@znight/schedule#Cron'
  readonly Interval: '@znight/schedule#Interval'
  readonly Timeout: '@znight/schedule#Timeout'
} = Object.freeze({
  Cron: '@znight/schedule#Cron',
  Interval: '@znight/schedule#Interval',
  Timeout: '@znight/schedule#Timeout',
})

/** The job decorators, by identity, with the kind of job they declare. */
export const JOB_DECORATORS: ReadonlyMap<string, 'cron' | 'interval' | 'timeout'> = new Map([
  [ScheduleDecorator.Cron, 'cron'],
  [ScheduleDecorator.Interval, 'interval'],
  [ScheduleDecorator.Timeout, 'timeout'],
])

/** Identity of the `JobContext` interface (the parameter of job methods). */
export const JOB_CONTEXT_IDENTITY = '@znight/schedule#JobContext'

/** Request values of other plugins that do not exist during a scheduled run. */
export const FOREIGN_REQUEST_VALUES: ReadonlyMap<string, string> = new Map([
  ['@znight/http#HttpContext', 'HttpContext'],
  ['@znight/http#RequestId', 'RequestId'],
  ['@znight/messaging#InboundMessage', 'InboundMessage'],
])

/** ZNIGHT005: invalid decorator usage (target, method shape, abstract host...). */
export const INVALID_DECORATOR: ErrorCode = 'ZNIGHT005'
/** ZNIGHT040: invalid schedule (expression, duration, zone, options, name, signature). */
export const INVALID_SCHEDULE: ErrorCode = 'ZNIGHT040'
/** ZNIGHT041: two jobs share a name. */
export const DUPLICATE_JOB: ErrorCode = 'ZNIGHT041'

/** Root reason given to `AnalyzeContext.addRoot()`. */
export const ROOT_REASON = 'scheduled job host'

/** Deterministic string comparison (never `localeCompare`). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
