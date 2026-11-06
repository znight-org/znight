import type { Int } from '@znight/graphql'
import type { User } from '../users/user.js'
import type { UsersById } from '../users/users-by-id.loader.js'
import type { Book } from './book.js'
import type { BookService } from './book.service.js'

import { Args, Loader, Parent, Query, ResolveField, Resolver } from '@znight/graphql'

@Resolver()
export class BookResolver {
  constructor(private readonly catalog: BookService) {}

  /** The first `limit` books. */
  @Query()
  books(@Args('limit') limit: Int): readonly Book[] {
    return this.catalog.list(limit)
  }

  /** Who wrote the book. Batched: one `UserService.findMany` per request, whatever the number of books. */
  @ResolveField()
  author(@Parent() book: Book, @Loader() users: Loader<UsersById>): Promise<User> {
    return users.load(book.authorId)
  }
}
