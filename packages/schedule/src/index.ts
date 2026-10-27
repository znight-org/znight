/**
 * `@znight/schedule`: cron, interval and timeout jobs validated at build time, with distributed
 * locks and graceful shutdown (RFC 0004).
 */
export type { JobContext, JobHandler, RunOutcome, RunTrigger } from './context.ts'
export type { CronField } from './cron/fields.ts'
export type * from './metadata.ts'
export type { CronOptions, IntervalOptions, JobOptions, OverlapPolicy, TimeoutOptions } from './options.ts'
export type { JobOverride, SchedulePluginOptions } from './prepare.ts'
export type { JobRunResult, JobState, ScheduledJob } from './registry.ts'

export { MAX_TIMER_DELAY, type ScheduleClock, systemClock } from './clock.ts'
export { type CronSchedule, type ParseCronOptions, parseCron, parseDuration } from './cron.ts'
export { Cron, Interval, type JobMethodMarker, Timeout } from './decorators.ts'
export { type Duration, formatDuration, MAX_DURATION_MS } from './duration.ts'
export {
  type InvalidScheduleDetails,
  InvalidScheduleError,
  JobAbortedError,
  type JobAbortReason,
} from './errors.ts'
export {
  type LockClaim,
  type LockLease,
  type MemoryLockStoreOptions,
  memoryLockStore,
  type ScheduleLockOptions,
  type ScheduleLockStore,
} from './lock.ts'
export { isJobName, JOB_NAME_PATTERN } from './names.ts'
export {
  SCHEDULE_PLUGIN_NAME,
  SchedulePlugin,
  type SchedulePluginInstance,
  type SchedulePluginState,
} from './plugin.ts'
export { SchedulerRegistry } from './registry.ts'
export { ScheduleTokens } from './tokens.ts'
