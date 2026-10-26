import { email, object, optional, type Schema, text, timestamp } from '../validation/schema.js'

/** A user, as stored by {@link UserDirectory} and returned by the APIs (dates are ISO 8601 strings). */
export interface User {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Validates a full {@link User} record (snapshots, events): every service agrees on the shape. */
export const User: Schema<User> = object<User>({
  id: text({ max: 64 }),
  email: email(),
  name: text({ max: 100 }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
})

/** Input of `UserDirectory.register()` and body of `POST /users`. */
export interface CreateUserInput {
  readonly email: string
  readonly name: string
}

export const CreateUserInput: Schema<CreateUserInput> = object<CreateUserInput>({
  email: email(),
  name: text({ max: 100 }),
})

/** Input of `UserDirectory.update()` and body of `PATCH /users/:id`: only the given fields change. */
export interface UpdateUserInput {
  readonly email?: string | undefined
  readonly name?: string | undefined
}

export const UpdateUserInput: Schema<UpdateUserInput> = object<UpdateUserInput>({
  email: optional(email()),
  name: optional(text({ max: 100 })),
})

/** No user has this id. Services map it to their protocol (`users-api`: 404). */
export class UserNotFoundError extends Error {
  override readonly name = 'UserNotFoundError'
  readonly userId: string

  constructor(userId: string) {
    super(`User ${userId} not found`)
    this.userId = userId
  }
}

/** Another user already has this email address (`users-api`: 409). */
export class EmailAlreadyUsedError extends Error {
  override readonly name = 'EmailAlreadyUsedError'
  readonly email: string

  constructor(email: string) {
    super(`Email ${email} is already used`)
    this.email = email
  }
}
