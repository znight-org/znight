/** A notification sent to a user. */
export interface Notification {
  readonly id: string
  readonly to: string
  readonly template: 'welcome' | 'goodbye'
  readonly subject: string
  readonly createdAt: string
}

/**
 * Where notifications go (email provider, push service...). An interface of the worker: the
 * compiler binds it to its single implementation (`LogNotificationChannel`); tests replace it.
 */
export interface NotificationChannel {
  send(notification: Notification): Promise<void>
}
