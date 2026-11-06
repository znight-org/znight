import type { Book } from './book.js'

/**
 * Published by `BookService.add()` once the book is stored. An application event is an instance of
 * any class: listeners are matched on its class (`@OnEvent()` methods typed `event: BookAdded`).
 */
export class BookAdded {
  constructor(
    readonly book: Book,
    readonly addedBy: string,
  ) {}
}
