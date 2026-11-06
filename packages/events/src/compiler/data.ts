/**
 * Data stored by the extension during analysis (`ctx.store()`), read back by `validate` and
 * `generate`. Classes are kept as their `ClassInfo`, so that compiled libraries record their public
 * identities (`znight.providers.json`).
 */
import type { ClassInfo, Location } from '@znight/compiler'

/** One `@OnEvent` method, for one listened class (a union gives one entry per member). */
export interface ListenerData {
  readonly kind: 'listener'
  /** The class declaring the method. Abstract: its listeners are inherited by its concrete providers. */
  readonly host: ClassInfo
  readonly method: string
  /** The listened class. */
  readonly event: ClassInfo
  readonly order: number
  readonly detached: boolean
  /** Location of the decorator. */
  readonly location: Location
}

/** Everything the extension stores. */
export type EventsData = ListenerData
