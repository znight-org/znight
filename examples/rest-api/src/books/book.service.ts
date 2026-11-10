import type { EventPublisher } from '@znight/events'
import type { BookRepository } from './book.repository.js'

import { Injectable } from '@znight/core'
import { Logged, type Logger, Metric } from '@znight/observability'

import { BookAdded } from './book.events.js'
import {
  type Book,
  type BookChanges,
  BookNotFoundError,
  type BookQuery,
  CoverChangedError,
  type CoverInfo,
  CoverNotFoundError,
  type NewBook,
  type Page,
  UnsupportedCoverError,
} from './book.js'
import { detectImageType } from './image-type.js'

/**
 * The use cases of the shelf. It knows nothing about HTTP nor about the database: it speaks the
 * domain (`Book`, `BookNotFoundError`...) and persists through the `BookRepository` interface.
 *
 * Its dependencies are resolved at build time from the constructor parameter types: `BookRepository`
 * is bound to `DrizzleBookRepository` (the class implementing it), `Logger` is provided at runtime by
 * `ObservabilityPlugin`.
 */
@Injectable()
export class BookService {
  constructor(
    private readonly books: BookRepository,
    private readonly logger: Logger,
    private readonly events: EventPublisher,
  ) {}

  list(query: BookQuery): Promise<Page<Book>> {
    return this.books.list(query)
  }

  async get(id: number): Promise<Book> {
    const book = await this.books.findById(id)
    if (book === undefined) throw new BookNotFoundError(id)
    return book
  }

  /**
   * `@Logged` writes one log entry per call (`BookService.add() completed`, with its duration and,
   * here, its arguments; `BookService.add() failed` with the error, as a warning: a duplicate ISBN is
   * a client mistake, not an incident) and `@Metric` counts the calls in Prometheus, labelled by
   * outcome. Both are method interceptors: the compiler wires them, nothing is wrapped by hand.
   *
   * Once the book is stored, `BookAdded` is published: the listeners of `book.listeners.ts` react to
   * it without this service knowing them (`@znight/events`).
   */
  @Logged({ level: 'info', errorLevel: 'warn', args: true })
  @Metric({ type: 'counter', name: 'bookshelf_books_added_total', help: 'Books added to the shelf' })
  async add(book: NewBook, createdBy: string): Promise<Book> {
    const created = await this.books.create(book, createdBy)
    await this.events.publish(new BookAdded(created, createdBy))
    return created
  }

  async update(id: number, changes: BookChanges): Promise<Book> {
    const book = await this.books.update(id, changes)
    if (book === undefined) throw new BookNotFoundError(id)
    return book
  }

  async remove(id: number): Promise<void> {
    if (!(await this.books.delete(id))) throw new BookNotFoundError(id)
    this.logger.info('Book removed', { bookId: id })
  }

  /** Stores an uploaded cover, typed from its content (never from what the client declared). */
  async setCover(id: number, file: File): Promise<void> {
    const data = new Uint8Array(await file.arrayBuffer())
    const contentType = detectImageType(data)
    if (contentType === undefined) throw new UnsupportedCoverError()
    if (!(await this.books.saveCover(id, { contentType, data }))) throw new BookNotFoundError(id)
    this.logger.info('Cover uploaded', { bookId: id, contentType, size: data.byteLength })
  }

  /** The type, size and date of a cover: enough to answer a conditional request. */
  async getCoverInfo(id: number): Promise<CoverInfo> {
    const cover = await this.books.findCoverInfo(id)
    if (cover === undefined) throw new CoverNotFoundError(id)
    return cover
  }

  /**
   * The bytes of the cover version that `info` describes. The cover may have been replaced since
   * `info` was read: its bytes would not match the size, type and validators already chosen (and a
   * resumed download would mix two images), so that is an error the client retries.
   */
  async getCoverData(id: number, info: CoverInfo): Promise<Uint8Array> {
    const data = await this.books.findCoverData(id, info.updatedAt)
    if (data === undefined) throw new CoverChangedError(id)
    return data
  }
}
