import type { ID } from '@znight/graphql'
import type { User } from './user.js'
import type { UserService } from './user.service.js'

import { Args, Mutation, Query, Resolver } from '@znight/graphql'

import { CreateUserInput } from './user.js'

@Resolver()
export class UserResolver {
  constructor(private readonly users: UserService) {}

  /** One user, `null` when there is none. */
  @Query()
  user(@Args('id') id: ID): User | null {
    return this.users.findById(id) ?? null
  }

  /** Creates a user; an invalid input is a `BAD_USER_INPUT` error (the Zod schema of `CreateUserInput`). */
  @Mutation()
  createUser(@Args('input', CreateUserInput) input: CreateUserInput): User {
    return this.users.create(input)
  }
}
