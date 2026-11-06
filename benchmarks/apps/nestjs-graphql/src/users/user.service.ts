import type { CreateUserInput, User } from './user.model.js'

import { Injectable } from '@nestjs/common'

// A value import: NestJS reads the constructor parameter types from the decorator metadata
import { UserRepository } from './user.repository.js'

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
