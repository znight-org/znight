import { Args, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql'

import { User } from '../users/user.model.js'
import { UsersLoader } from '../users/users.loader.js'
import { Book } from './book.model.js'
import { BookService } from './book.service.js'

/**
 * Request-scoped, like the UsersLoader it depends on (NestJS propagates the scope to its dependents).
 * Value imports: NestJS reads the constructor parameter types from the decorator metadata.
 */
@Resolver(() => Book)
export class BookResolver {
  constructor(
    private readonly catalog: BookService,
    private readonly users: UsersLoader,
  ) {}

  @Query(() => [Book])
  books(@Args('limit', { type: () => Int }) limit: number): Book[] {
    return this.catalog.list(limit)
  }

  @ResolveField(() => User)
  author(@Parent() book: Book): Promise<User> {
    return this.users.load(book.authorId)
  }
}
