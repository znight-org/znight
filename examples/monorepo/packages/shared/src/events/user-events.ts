import { email, object, type Schema, text, timestamp } from '../validation/schema.js'

/**
 * The messaging contract between the services: queue name, message types and payload schemas live
 * in the shared package, so producers and consumers cannot drift apart.
 *
 * Decorator arguments are evaluated at build time, across packages:
 * `@Consumer(USER_EVENTS_QUEUE)` and `@OnMessage(UserEventType.Registered)` read these constants.
 */
export const USER_EVENTS_QUEUE = 'user-events'

/** Types of the messages published on {@link USER_EVENTS_QUEUE}. */
export const UserEventType = {
  Registered: 'user.registered',
  Deleted: 'user.deleted',
} as const

/** Payload of `user.registered`. */
export interface UserRegistered {
  readonly id: string
  readonly email: string
  readonly name: string
  /** When the user registered (ISO 8601). */
  readonly at: string
}

export const UserRegistered: Schema<UserRegistered> = object<UserRegistered>({
  id: text({ max: 64 }),
  email: email(),
  name: text({ max: 100 }),
  at: timestamp(),
})

/** Payload of `user.deleted`. */
export interface UserDeleted {
  readonly id: string
  /** When the user was deleted (ISO 8601). */
  readonly at: string
}

export const UserDeleted: Schema<UserDeleted> = object<UserDeleted>({
  id: text({ max: 64 }),
  at: timestamp(),
})
