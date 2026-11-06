import type { CreateUserInput, User } from './user.js'

import { Injectable } from '@znight/core'

/** Check-only mode of the runner (`BENCH_COUNT_FIND_MANY=1`): one stderr line per `findMany` call, to check batching. */
const COUNT_FIND_MANY = process.env['BENCH_COUNT_FIND_MANY'] === '1'

/** Users 1 to 100 are seeded; created users take the ids 101 to 10000 in turn (bounded memory). */
@Injectable()
export class UserRepository {
  readonly #users = new Map<string, User>()
  #created = 0

  constructor() {
    for (let id = 1; id <= 100; id++) {
      this.#users.set(String(id), { id: String(id), name: `User ${id}`, email: `user${id}@example.com` })
    }
  }

  findById(id: string): User | undefined {
    return this.#users.get(id)
  }

  /** The users of `ids` that exist, in no particular order. */
  findMany(ids: readonly string[]): User[] {
    if (COUNT_FIND_MANY) process.stderr.write('findMany\n')
    const users: User[] = []
    for (const id of ids) {
      const user = this.#users.get(id)
      if (user !== undefined) users.push(user)
    }
    return users
  }

  insert(input: CreateUserInput): User {
    const id = String(101 + (this.#created++ % 9900))
    const user = { id, name: input.name, email: input.email }
    this.#users.set(id, user)
    return user
  }
}
