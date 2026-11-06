import type { Book } from './book.model.js'

import { Injectable } from '@nestjs/common'

// A value import: NestJS reads the constructor parameter types from the decorator metadata
import { BookRepository } from './book.repository.js'

@Injectable()
export class BookService {
  constructor(private readonly books: BookRepository) {}

  list(limit: number): Book[] {
    return this.books.list(limit)
  }
}
