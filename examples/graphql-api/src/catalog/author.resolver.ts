import type { Author, Book } from './book.js'
import type { BooksByAuthor } from './books-by-author.loader.js'

import { Loader, Parent, ResolveField, Resolver } from '@znight/graphql'

/**
 * Fields of `Author` that are not properties. A field resolver without access decision is covered by
 * the root field its selection descends from (`book`, `search`...): authorization happens at entry
 * points, so this class needs no `@Public()`.
 */
@Resolver()
export class AuthorResolver {
  /** The books of the author in the catalog. Batched like `Book.author`. */
  @ResolveField()
  books(@Parent() author: Author, @Loader() books: Loader<BooksByAuthor>): Promise<readonly Book[]> {
    return books.load(author.id)
  }
}
