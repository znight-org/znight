import type { Logger } from '@znight/observability'
import type { Notification, NotificationChannel } from './notification.js'

import { Injectable } from '@znight/core'

/**
 * Development channel: notifications are written to the logs (one JSON line each). Replace it with
 * an email provider client implementing {@link NotificationChannel}: nothing else changes.
 */
@Injectable()
export class LogNotificationChannel implements NotificationChannel {
  constructor(private readonly logger: Logger) {}

  send(notification: Notification): Promise<void> {
    this.logger.info('Notification sent', { notification })
    return Promise.resolve()
  }
}
