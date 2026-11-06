import type { Book } from './book.js'

import { Injectable } from '@znight/core'

/** Books 1 to 100; book `i` is written by user `((i * 7) % 100) + 1`. */
@Injectable()
export class BookRepository {
  readonly #books: readonly Book[]

  constructor() {
    const books: Book[] = []
    for (let id = 1; id <= 100; id++) {
      books.push({ id: String(id), title: `Book ${id}`, year: 1900 + id, authorId: String(((id * 7) % 100) + 1) })
    }
    this.#books = books
  }

  /** The first `limit` books, by id. */
  list(limit: number): Book[] {
    return this.#books.slice(0, Math.max(0, limit))
  }
}
