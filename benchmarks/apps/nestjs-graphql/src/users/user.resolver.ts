import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql'

import { CreateUserInput, CreateUserSchema, User } from './user.model.js'
import { UserService } from './user.service.js'
import { ZodPipe } from './zod.pipe.js'

/** Value imports: NestJS reads the constructor parameter types from the decorator metadata. */
@Resolver(() => User)
export class UserResolver {
  constructor(private readonly users: UserService) {}

  @Query(() => User, { nullable: true })
  user(@Args('id', { type: () => ID }) id: string): User | null {
    return this.users.findById(id) ?? null
  }

  /** An invalid input is a GraphQL error (the Zod schema of the HTTP benchmark). */
  @Mutation(() => User)
  createUser(
    @Args('input', { type: () => CreateUserInput }, new ZodPipe(CreateUserSchema)) input: CreateUserInput,
  ): User {
    return this.users.create(input)
  }
}
