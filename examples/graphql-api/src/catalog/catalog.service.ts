import type { ID } from '@znight/graphql'
import type { Logger } from '@znight/observability'
import type { SearchResult } from '../search/search.js'
import type { AuthorRepository } from './author.repository.js'
import type { BookFilter } from './book.args.js'
import type { NewBookInput } from './book.inputs.js'
import type { Book, Page } from './book.js'
import type { BookRepository } from './book.repository.js'

import { Injectable } from '@znight/core'

import { AuthorNotFoundError, DuplicateIsbnError } from './errors.js'

/**
 * The catalog, independent of GraphQL: resolvers map GraphQL to it, and a controller, a consumer or a
 * job could call it the same way. It throws domain errors (`errors.ts`).
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly books: BookRepository,
    private readonly authors: AuthorRepository,
    private readonly logger: Logger,
  ) {}

  /** A page of books. The arguments arrive with their schema defaults applied. */
  async list(filter: BookFilter): Promise<Page<Book>> {
    const search = filter.search?.toLowerCase()
    const matching = (await this.books.all())
      .filter(book => search === undefined || book.title.toLowerCase().includes(search))
      .filter(book => filter.genre === undefined || book.genre === filter.genre)
      .sort((a, b) =>
        filter.sort === 'newest' ? b.createdAt.getTime() - a.createdAt.getTime() : a.title.localeCompare(b.title),
      )
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 20
    return {
      items: matching.slice(offset, offset + limit),
      total: matching.length,
      hasMore: offset + limit < matching.length,
    }
  }

  async find(id: ID): Promise<Book | null> {
    return (await this.books.findById(id)) ?? null
  }

  /** Books whose title, and authors whose name, contain `text`: books first. */
  async search(text: string): Promise<SearchResult[]> {
    const needle = text.trim().toLowerCase()
    if (needle === '') return []
    const books = (await this.books.all()).filter(book => book.title.toLowerCase().includes(needle))
    return [...books, ...(await this.authors.search(needle))]
  }

  /** Adds a book (the input is the output of the `NewBookInput` schema: trimmed, normalised). */
  async add(input: NewBookInput, addedBy: string): Promise<Book> {
    if (!(await this.authors.exists(input.authorId))) throw new AuthorNotFoundError(input.authorId)
    if ((await this.books.findByIsbn(input.isbn)) !== undefined) throw new DuplicateIsbnError(input.isbn)
    const book = await this.books.insert({
      kind: 'book',
      title: input.title,
      isbn: input.isbn,
      publishedYear: input.publishedYear ?? null,
      genre: input.genre,
      tags: input.tags ?? [],
      createdAt: new Date(),
      authorId: input.authorId,
    })
    this.logger.info('Book added', { bookId: book.id, isbn: book.isbn, addedBy })
    return book
  }
}
