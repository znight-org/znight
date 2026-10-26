import type { Logger } from '@znight/observability'
import type { NotificationService } from './notification.service.js'

import { Consumer, type InboundMessage, Message, OnError, OnMessage, Retry } from '@znight/messaging'
import { USER_EVENTS_QUEUE, UserDeleted, UserEventType, UserRegistered } from '@znight-examples/shared'

/**
 * Consumes the user events. The queue name, the message types and the payload schemas come from
 * the shared package: the compiler evaluates `USER_EVENTS_QUEUE` and `UserEventType.Registered`
 * across packages at build time, and imports the schemas from '@znight-examples/shared'.
 *
 * Messages of a queue are handled one at a time by default (concurrency 1), so a user's
 * `user.deleted` never overtakes its `user.registered`.
 */
@Consumer(USER_EVENTS_QUEUE)
export class UserEventsConsumer {
  constructor(
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
  ) {}

  /** A failure (the channel is down...) is retried twice, 200 ms then 400 ms later. */
  @OnMessage(UserEventType.Registered)
  @Retry({ attempts: 3, backoff: 'exponential', delay: 200 })
  async registered(@Message(UserRegistered) event: UserRegistered): Promise<void> {
    await this.notifications.welcome(event)
  }

  @OnMessage(UserEventType.Deleted)
  @Retry({ attempts: 3, backoff: 'exponential', delay: 200 })
  async deleted(@Message(UserDeleted) event: UserDeleted): Promise<void> {
    await this.notifications.goodbye(event)
  }

  /**
   * Called when a message will not be retried anymore: invalid payload, unknown type, last attempt
   * failed. Returning nothing dead-letters it (`user-events.dlq`); returning 'ack' would drop it.
   */
  @OnError()
  failed(error: unknown, message: InboundMessage): void {
    this.logger.error('User event dead-lettered', {
      messageId: message.id,
      type: message.type,
      attempt: message.attempt,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
