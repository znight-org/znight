import type { Logger } from '@znight/observability'
import type { Clock, IdGenerator, UserDeleted, UserDirectory, UserRegistered } from '@znight-examples/shared'
import type { Notification, NotificationChannel } from './notification.js'

import { Injectable } from '@znight/core'

/**
 * Turns user events into notifications.
 *
 * Every dependency but the channel comes from the shared library, injected three ways:
 * `UserDirectory` by class, `Clock` by interface (→ SystemClock) and `IdGenerator` by abstract class
 * (→ RandomIdGenerator: unlike users-api, the worker keeps the library default).
 *
 * The worker keeps its own `UserDirectory`, a projection of the user events: `user.deleted` only
 * carries an id, the directory gives the address to write to.
 */
@Injectable()
export class NotificationService {
  #sent = 0

  constructor(
    private readonly users: UserDirectory,
    private readonly channel: NotificationChannel,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
  ) {}

  /** Notifications sent since the start. */
  get sent(): number {
    return this.#sent
  }

  /**
   * Welcomes a new user. Idempotent: delivery is at-least-once, so a redelivered event (already in
   * the directory) sends nothing. The user is recorded only once the notification is sent: when
   * the channel fails, the retried event sends it again.
   */
  async welcome(event: UserRegistered): Promise<Notification | undefined> {
    if (this.users.find(event.id) !== undefined) {
      this.logger.info('Duplicate user.registered ignored', { userId: event.id })
      return undefined
    }
    const notification = await this.#send(event.email, 'welcome', `Welcome aboard, ${event.name}!`)
    this.users.upsert({ id: event.id, email: event.email, name: event.name, createdAt: event.at, updatedAt: event.at })
    return notification
  }

  /** Says goodbye to a deleted user, then forgets them. Unknown (or already deleted) users are ignored. */
  async goodbye(event: UserDeleted): Promise<Notification | undefined> {
    const user = this.users.find(event.id)
    if (user === undefined) {
      this.logger.warn('user.deleted for an unknown user ignored', { userId: event.id })
      return undefined
    }
    const notification = await this.#send(user.email, 'goodbye', `Goodbye, ${user.name}`)
    this.users.remove(user.id)
    return notification
  }

  async #send(to: string, template: Notification['template'], subject: string): Promise<Notification> {
    const notification: Notification = {
      id: this.ids.next(),
      to,
      template,
      subject,
      createdAt: this.clock.now().toISOString(),
    }
    await this.channel.send(notification)
    this.#sent += 1
    return notification
  }
}
