/**
 * Events section of the generated metadata (`__ZNIGHT_METADATA__.extensions.events`), produced by the
 * `@znight/events/compiler` extension and consumed by `EventsPlugin` (RFC 0011 §5.5, architecture
 * §9.8). The plugin checks it at boot, because metadata can be hand-written.
 */
import type { Token } from '@znight/core'

/** A class an event can be an instance of (abstract classes included). */
export type EventClass = abstract new (...args: never[]) => object

/** The listeners of the application. The section is absent when there is none. */
export interface EventsMetadata {
  /** Sorted by (`order`, `token`, `method`, `eventName`). */
  readonly listeners: readonly EventListenerDefinition[]
}

/** One `@OnEvent` method, for one listened class (a union of classes gives one entry per member). */
export interface EventListenerDefinition {
  /** The listened class: instances of it and of its subclasses are delivered. */
  readonly event: EventClass
  /** Class name of {@link event} (messages). */
  readonly eventName: string
  /** Provider token of the host class. */
  readonly token: Token
  readonly method: string
  /** Integer, `0` by default. */
  readonly order: number
  readonly detached: boolean
  /** `(c: Host, e: Event) => c.method(e)`. */
  // biome-ignore lint/suspicious/noExplicitAny: generated invokers receive the concrete host and event classes
  readonly invoke: (host: any, event: any) => unknown
}

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly events?: EventsMetadata
  }
}
