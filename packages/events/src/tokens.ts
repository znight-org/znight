import type { TypedToken } from '@znight/core'
import type { EventPublisher } from './publisher.ts'

/** Tokens of the externals provided by `EventsPlugin` (declared in the package manifest). */
export const EventsTokens: {
  /** The {@link EventPublisher} singleton. */
  readonly EventPublisher: TypedToken<EventPublisher>
} = Object.freeze({
  EventPublisher: '@znight/events#EventPublisher',
})
