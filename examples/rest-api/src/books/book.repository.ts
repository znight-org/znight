import type { Book, BookChanges, BookQuery, Cover, NewBook, Page } from './book.js'

/**
 * Persistence of the books, as the service needs it.
 *
 * Services depend on this **interface**, never on Drizzle: the compiler binds the injection to the
 * single provider implementing it (`DrizzleBookRepository`), and tests replace it with a mock or an
 * in-memory implementation. With several implementations, mark one `@Primary()` or qualify them with
 * `@Named()` / `@Inject()`.
 */
export interface BookRepository {
  list(query: BookQuery): Promise<Page<Book>>
  findById(id: number): Promise<Book | undefined>
  /** @throws DuplicateIsbnError */
  create(book: NewBook, createdBy: string): Promise<Book>
  /** `undefined` when the book does not exist. @throws DuplicateIsbnError */
  update(id: number, changes: BookChanges): Promise<Book | undefined>
  /** `false` when the book does not exist. */
  delete(id: number): Promise<boolean>
  /** Creates or replaces the cover; `false` when the book does not exist. */
  saveCover(id: number, cover: Omit<Cover, 'updatedAt'>): Promise<boolean>
  findCover(id: number): Promise<Cover | undefined>
}
