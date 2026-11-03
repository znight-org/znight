import type { ID } from '@znight/graphql'
import type { Book } from './book.js'

import { Injectable } from '@znight/core'

import { BOOKS } from './seed.js'

/** Books, in memory. Asynchronous like a database would be. */
@Injectable()
export class BookRepository {
  readonly #books = new Map(BOOKS.map(book => [book.id, book]))
  #next = BOOKS.length + 1

  all(): Promise<Book[]> {
    return Promise.resolve([...this.#books.values()])
  }

  findById(id: ID): Promise<Book | undefined> {
    return Promise.resolve(this.#books.get(id))
  }

  findByIsbn(isbn: string): Promise<Book | undefined> {
    return Promise.resolve([...this.#books.values()].find(book => book.isbn === isbn))
  }

  /** The books of the authors among `authorIds`: one query, whatever the number of authors. */
  findByAuthors(authorIds: readonly ID[]): Promise<Book[]> {
    return Promise.resolve([...this.#books.values()].filter(book => authorIds.includes(book.authorId)))
  }

  /** Stores a new book under the next id. */
  insert(book: Omit<Book, 'id'>): Promise<Book> {
    const stored: Book = { ...book, id: `b${this.#next++}` }
    this.#books.set(stored.id, stored)
    return Promise.resolve(stored)
  }
}
