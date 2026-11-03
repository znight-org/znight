import type { BatchLoad, ID } from '@znight/graphql'
import type { Book } from './book.js'
import type { BookRepository } from './book.repository.js'

import { Injectable } from '@znight/core'

/** Loads the books of authors, in batches: one repository query for every author of a search result. */
@Injectable()
export class BooksByAuthor implements BatchLoad<ID, readonly Book[]> {
  constructor(private readonly books: BookRepository) {}

  async load(authorIds: readonly ID[]): Promise<readonly (readonly Book[])[]> {
    const books = await this.books.findByAuthors(authorIds)
    return authorIds.map(id => books.filter(book => book.authorId === id))
  }
}
