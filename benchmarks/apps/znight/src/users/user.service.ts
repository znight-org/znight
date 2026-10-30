import type { CreateUser, User } from './user.js'
import type { UserRepository } from './user.repository.js'

import { Injectable } from '@znight/core'

@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}

  findById(id: number): User | undefined {
    return this.users.findById(id)
  }

  create(input: CreateUser): User {
    return this.users.insert(input)
  }
}
