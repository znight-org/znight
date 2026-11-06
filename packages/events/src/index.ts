/**
 * `@znight/events`: in-process application events with listeners wired at build time (RFC 0011).
 * Events are class instances, listeners are provider methods marked `@OnEvent()` whose parameter type
 * is the event class; inline listeners run in the publisher's scope and fail its operation, detached
 * ones run after it in their own scope with errors reported.
 */

export type { PublicationObserver } from './dispatcher.ts'
export type * from './metadata.ts'

export { type EventListenerMarker, OnEvent, type OnEventOptions } from './decorators.ts'
export {
  DEFAULT_DRAIN_TIMEOUT_MS,
  type EventErrorHandler,
  type EventErrorInfo,
  type EventsPluginOptions,
} from './options.ts'
export {
  EVENTS_PLUGIN_NAME,
  EventsPlugin,
  type EventsPluginInstance,
  type EventsPluginState,
} from './plugin.ts'
export { EventPublisher } from './publisher.ts'
export { EventsTokens } from './tokens.ts'
