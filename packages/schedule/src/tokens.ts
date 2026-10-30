import type { TypedToken } from '@znight/core'
import type { JobContext } from './context.ts'
import type { SchedulerRegistry } from './registry.ts'

/** Tokens of the externals provided by `SchedulePlugin` (declared in the package manifest). */
export const ScheduleTokens: {
  /** The {@link SchedulerRegistry} singleton. */
  readonly SchedulerRegistry: TypedToken<SchedulerRegistry>
  /** The {@link JobContext} of the current run (request-scoped). */
  readonly JobContext: TypedToken<JobContext>
} = Object.freeze({
  SchedulerRegistry: '@znight/schedule#SchedulerRegistry',
  JobContext: '@znight/schedule#JobContext',
})
