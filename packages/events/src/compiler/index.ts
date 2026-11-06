/**
 * `@znight/events/compiler`: the compiler extension of `@znight/events` (RFC 0011 §6).
 *
 * Loaded by `@znight/compiler` through the package manifest (`package.json#znight.compiler`). It reads
 * the `@OnEvent` methods and the event classes their parameter names (ZNIGHT005, ZNIGHT070), declares
 * their hosts as roots and generates `metadata.extensions.events`.
 *
 * This entry only `import type`s from `@znight/compiler` and never loads the events runtime.
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { EventsData } from './data.ts'

import { analyzeEventsClass } from './analyze.ts'
import { EXTENSION_NAME, ON_EVENT } from './constants.ts'
import { generateEvents } from './generate.ts'
import { validateEvents } from './validate.ts'

export type { EventsData, ListenerData } from './data.ts'

/** Decorators owned by the extension: the options are static. */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [ON_EVENT]: { targets: ['method'], params: ['static'] },
} satisfies Record<string, DecoratorSpec>)

/** The `@znight/events` compiler extension. */
export const eventsCompilerExtension: CompilerExtension<EventsData> = Object.freeze({
  apiVersion: 1,
  name: EXTENSION_NAME,
  decorators,
  analyzeClass: analyzeEventsClass,
  validate: validateEvents,
  generate: generateEvents,
})

export default eventsCompilerExtension
