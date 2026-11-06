import type { CreateUserInput, User } from './user.js'
import type { UserRepository } from './user.repository.js'

import { Injectable } from '@znight/core'

@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}

  findById(id: string): User | undefined {
    return this.users.findById(id)
  }

  findMany(ids: readonly string[]): User[] {
    return this.users.findMany(ids)
  }

  create(input: CreateUserInput): User {
    return this.users.insert(input)
  }
}
