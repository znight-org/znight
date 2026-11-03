import type { ID } from '@znight/graphql'
import type { Author } from './book.js'

import { Injectable } from '@znight/core'

import { AUTHORS } from './seed.js'

/** Authors, in memory. Asynchronous like a database would be. */
@Injectable()
export class AuthorRepository {
  readonly #authors = new Map(AUTHORS.map(author => [author.id, author]))

  /** The authors among `ids`, in any order: one query, whatever the number of ids. */
  findMany(ids: readonly ID[]): Promise<Author[]> {
    return Promise.resolve(ids.flatMap(id => this.#authors.get(id) ?? []))
  }

  exists(id: ID): Promise<boolean> {
    return Promise.resolve(this.#authors.has(id))
  }

  /** Authors whose name contains `text` (lower-cased). */
  search(text: string): Promise<Author[]> {
    return Promise.resolve([...this.#authors.values()].filter(author => author.name.toLowerCase().includes(text)))
  }
}
