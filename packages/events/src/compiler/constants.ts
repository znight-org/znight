/**
 * Constants shared by the compiler extension modules. This module must stay free of runtime imports:
 * the extension entry is loaded by the compiler, which must never load the events runtime.
 */
import type { ErrorCode } from '@znight/core'

/** Name of the extension, also the key of `metadata.extensions.events`. */
export const EXTENSION_NAME = 'events'

/** Canonical identity of `@OnEvent`. */
export const ON_EVENT = '@znight/events#OnEvent'

/** Options of `@OnEvent`. */
export const OPTION_KEYS: readonly string[] = ['order', 'detached']

/** Options of `@nestjs/event-emitter`'s `@OnEvent`, with what replaces them. */
export const NEST_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['async', 'detached: true runs the listener after the publication, in its own scope'],
  ['suppressErrors', 'detached: true reports the errors of the listener instead of throwing them'],
  ['prependListener', 'order: -1 (or lower) runs the listener before the others'],
  ['nextTick', 'detached: true runs the listener after the publication'],
  ['promisify', 'listeners are always awaited: remove the option'],
])

/** ZNIGHT005: invalid decorator usage (target, method shape, generic host). */
export const INVALID_DECORATOR: ErrorCode = 'ZNIGHT005'
/** ZNIGHT070: invalid event listener. */
export const INVALID_LISTENER: ErrorCode = 'ZNIGHT070'

/** Root reason given to `AnalyzeContext.addRoot()`. */
export const ROOT_REASON = 'event listener host'

/** Deterministic string comparison (never `localeCompare`). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
