import type { TypedToken } from '@znight/core'
import type { MessageBroker } from './broker.ts'
import type { InboundMessage } from './message.ts'

/** Tokens of the externals provided by `MessagingPlugin` (declared in the package manifest). */
export const MessagingTokens: {
  /** The {@link MessageBroker} singleton. */
  readonly MessageBroker: TypedToken<MessageBroker>
  /** The {@link InboundMessage} of the current delivery (request-scoped). */
  readonly InboundMessage: TypedToken<InboundMessage>
} = Object.freeze({
  MessageBroker: '@znight/messaging#MessageBroker',
  InboundMessage: '@znight/messaging#InboundMessage',
})
