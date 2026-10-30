import type { CreateUser, User } from './user.js'

import { Injectable } from '@znight/core'

/** Users 1 to 1000 are seeded; created users take the ids 1001 to 10000 in turn (bounded memory). */
@Injectable()
export class UserRepository {
  readonly #users = new Map<number, User>()
  #created = 0

  constructor() {
    for (let id = 1; id <= 1000; id++) this.#users.set(id, { id, name: `User ${id}`, email: `user${id}@example.com` })
  }

  findById(id: number): User | undefined {
    return this.#users.get(id)
  }

  insert(input: CreateUser): User {
    const user = { id: 1001 + (this.#created++ % 9000), name: input.name, email: input.email }
    this.#users.set(user.id, user)
    return user
  }
}
