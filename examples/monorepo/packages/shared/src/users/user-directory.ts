import type { IdGenerator } from '../ids/id-generator.js'
import type { Clock } from '../time/clock.js'

import { Injectable } from '@znight/core'

import {
  type CreateUserInput,
  EmailAlreadyUsedError,
  type UpdateUserInput,
  type User,
  UserNotFoundError,
} from './user.js'

/** Options of {@link UserDirectory.list}. */
export interface ListUsersOptions {
  /** Maximum number of users (default 20). */
  readonly limit?: number | undefined
  /** Cursor: only users whose id sorts after this one. */
  readonly after?: string | undefined
}

/** A page of users, sorted by id. `next` is the cursor of the following page, if any. */
export interface UserPage {
  readonly items: readonly User[]
  readonly next?: string
}

/**
 * The users known by a service, with their invariants (unique email addresses).
 *
 * Kept in memory to keep the example self-contained; a real implementation would sit on a database,
 * behind the same API. It is a provider of this library: services inject it **by class**, and the
 * compiler injects its own dependencies (a {@link Clock} interface, an {@link IdGenerator} abstract
 * class) with the providers **of the application using it**. That is why `users-api` gets
 * time-ordered ids here: it declares a `@Primary()` IdGenerator, and binding happens at build time
 * over the whole application, library providers included.
 */
@Injectable()
export class UserDirectory {
  readonly #users = new Map<string, User>()
  /** Normalised email address → user id. */
  readonly #emails = new Map<string, string>()

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Number of users. */
  get size(): number {
    return this.#users.size
  }

  /** Registers a new user with a generated id. */
  register(input: CreateUserInput): User {
    this.#assertEmailAvailable(input.email)
    const now = this.clock.now().toISOString()
    return this.#save({ id: this.ids.next(), email: input.email, name: input.name, createdAt: now, updatedAt: now })
  }

  /**
   * Adds or replaces a user created elsewhere, keeping its id: projections fed by events, snapshots
   * restored at startup. Idempotent.
   */
  upsert(user: User): User {
    this.#assertEmailAvailable(user.email, user.id)
    const previous = this.#users.get(user.id)
    if (previous !== undefined) this.#emails.delete(previous.email)
    return this.#save(user)
  }

  /** The user with this id, or `undefined`. */
  find(id: string): User | undefined {
    return this.#users.get(id)
  }

  /** The user with this id. @throws UserNotFoundError */
  get(id: string): User {
    const user = this.#users.get(id)
    if (user === undefined) throw new UserNotFoundError(id)
    return user
  }

  /** The user with this email address (case-insensitive), or `undefined`. */
  findByEmail(email: string): User | undefined {
    const id = this.#emails.get(email.toLowerCase())
    return id === undefined ? undefined : this.#users.get(id)
  }

  /** A page of users sorted by id (with time-ordered ids: by creation date). */
  list(options: ListUsersOptions = {}): UserPage {
    const { limit = 20, after } = options
    const sorted = [...this.#users.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    const remaining = after === undefined ? sorted : sorted.filter(user => user.id > after)
    const items = remaining.slice(0, limit)
    const last = items.at(-1)
    return remaining.length > limit && last !== undefined ? { items, next: last.id } : { items }
  }

  /** Changes the given fields of a user. @throws UserNotFoundError, EmailAlreadyUsedError */
  update(id: string, changes: UpdateUserInput): User {
    const user = this.get(id)
    if (changes.email !== undefined) this.#assertEmailAvailable(changes.email, id)
    this.#emails.delete(user.email)
    return this.#save({
      ...user,
      email: changes.email ?? user.email,
      name: changes.name ?? user.name,
      updatedAt: this.clock.now().toISOString(),
    })
  }

  /** Removes a user and returns it. @throws UserNotFoundError */
  remove(id: string): User {
    const user = this.get(id)
    this.#users.delete(id)
    this.#emails.delete(user.email)
    return user
  }

  /** Every user, sorted by id (snapshots). */
  all(): User[] {
    return this.list({ limit: Number.POSITIVE_INFINITY }).items.slice()
  }

  #assertEmailAvailable(email: string, ownerId?: string): void {
    const existing = this.#emails.get(email.toLowerCase())
    if (existing !== undefined && existing !== ownerId) throw new EmailAlreadyUsedError(email)
  }

  #save(user: User): User {
    const normalised = { ...user, email: user.email.toLowerCase() }
    this.#users.set(normalised.id, normalised)
    this.#emails.set(normalised.email, normalised.id)
    return normalised
  }
}
