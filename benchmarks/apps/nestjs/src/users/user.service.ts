import type { CreateUser, User } from './user.js'

import { Injectable } from '@nestjs/common'

// A value import: NestJS reads the constructor parameter types from the decorator metadata
import { UserRepository } from './user.repository.js'

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
