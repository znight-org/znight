import type { BatchLoad, ID } from '@znight/graphql'
import type { AuthorRepository } from './author.repository.js'
import type { Author } from './book.js'

import { Injectable } from '@znight/core'
import { orderByKeys } from '@znight/graphql'

/**
 * Loads authors by id, in batches: `books { items { author { name } } }` calls
 * `AuthorRepository.findMany` once per execution, whatever the number of books. A loader is a
 * provider; `@Loader() authors: Loader<AuthorsById>` gives a resolver the DataLoader of the current
 * execution (a fresh cache per operation, and per subscription event).
 */
@Injectable()
export class AuthorsById implements BatchLoad<ID, Author> {
  /** DataLoader options, read once. */
  readonly options = { maxBatchSize: 100 }

  constructor(private readonly authors: AuthorRepository) {}

  async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
    // one value per key, in the order of the keys; a missing author fails its key only (NOT_FOUND)
    return orderByKeys(ids, await this.authors.findMany(ids), author => author.id)
  }
}
