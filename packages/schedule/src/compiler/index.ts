/**
 * `@znight/schedule/compiler`: the compiler extension of `@znight/schedule` (RFC 0004 §5, §6).
 *
 * Loaded by `@znight/compiler` through the package manifest (`package.json#znight.compiler`). It reads
 * the `@Cron`, `@Interval` and `@Timeout` methods, validates them with the cron engine the runtime
 * uses (ZNIGHT005, ZNIGHT040, ZNIGHT041), declares their classes as roots and generates
 * `metadata.extensions.schedule`.
 *
 * This entry only `import type`s from `@znight/compiler` and never loads the schedule runtime: it
 * reaches the import-free modules `src/cron/*`, `src/duration.ts` and `src/names.ts` only.
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { ScheduleData } from './data.ts'

import { analyzeScheduleClass } from './analyze.ts'
import { EXTENSION_NAME, ScheduleDecorator } from './constants.ts'
import { generateSchedule } from './generate.ts'
import { validateSchedule } from './validate.ts'

export type { JobData, ScheduleData } from './data.ts'

/** Decorators owned by the extension: every argument is static. */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [ScheduleDecorator.Cron]: { targets: ['method'], params: ['static', 'static'] },
  [ScheduleDecorator.Interval]: { targets: ['method'], params: ['static', 'static'] },
  [ScheduleDecorator.Timeout]: { targets: ['method'], params: ['static', 'static'] },
} satisfies Record<string, DecoratorSpec>)

/** The `@znight/schedule` compiler extension. */
export const scheduleCompilerExtension: CompilerExtension<ScheduleData> = Object.freeze({
  apiVersion: 1,
  name: EXTENSION_NAME,
  decorators,
  analyzeClass: analyzeScheduleClass,
  validate: validateSchedule,
  generate: generateSchedule,
})

export default scheduleCompilerExtension
