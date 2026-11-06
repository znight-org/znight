import type { Book } from './book.js'
import type { BookRepository } from './book.repository.js'

import { Injectable } from '@znight/core'

@Injectable()
export class BookService {
  constructor(private readonly books: BookRepository) {}

  list(limit: number): Book[] {
    return this.books.list(limit)
  }
}
