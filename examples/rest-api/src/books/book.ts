/** A book of the shelf, as the domain sees it (independent of the database and of HTTP). */
export interface Book {
  readonly id: number
  readonly isbn: string
  readonly title: string
  readonly author: string
  readonly publishedYear: number | null
  readonly tags: readonly string[]
  /** Name of the API key that added the book. */
  readonly createdBy: string
  readonly createdAt: Date
  readonly updatedAt: Date
  /** When the cover was last uploaded, `null` without cover. */
  readonly coverUpdatedAt: Date | null
}

/** Fields of a new book. */
export interface NewBook {
  readonly isbn: string
  readonly title: string
  readonly author: string
  readonly publishedYear?: number | undefined
  readonly tags?: readonly string[] | undefined
}

/** Fields of a partial update. */
export type BookChanges = Partial<NewBook>

/** Sort orders of the book list. */
export type BookSort = 'title' | 'author' | 'year' | 'newest'

/** Criteria of the book list. */
export interface BookQuery {
  /** Case-insensitive search in titles and authors. */
  readonly search?: string | undefined
  /** Exact author. */
  readonly author?: string | undefined
  /** Books carrying at least one of these tags. */
  readonly tags?: readonly string[] | undefined
  readonly sort: BookSort
  readonly limit: number
  readonly offset: number
}

/** A page of results. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** A cover image. */
export interface Cover {
  readonly contentType: string
  readonly data: Uint8Array
  readonly updatedAt: Date
}

/** Thrown when a book does not exist: mapped to `404 Not Found` by `DomainErrorMapper`. */
export class BookNotFoundError extends Error {
  readonly bookId: number

  constructor(bookId: number) {
    super(`Book ${bookId} not found`)
    this.name = 'BookNotFoundError'
    this.bookId = bookId
  }
}

/** Thrown when the ISBN is already on the shelf: mapped to `409 Conflict` by `DomainErrorMapper`. */
export class DuplicateIsbnError extends Error {
  readonly isbn: string

  constructor(isbn: string) {
    super(`A book with ISBN ${isbn} is already on the shelf`)
    this.name = 'DuplicateIsbnError'
    this.isbn = isbn
  }
}

/** Thrown when an uploaded cover is not a PNG, JPEG or WebP image: mapped to `415 Unsupported Media Type`. */
export class UnsupportedCoverError extends Error {
  constructor() {
    super('The cover must be a PNG, JPEG or WebP image')
    this.name = 'UnsupportedCoverError'
  }
}

/** Thrown when a book has no cover: mapped to `404 Not Found`. */
export class CoverNotFoundError extends Error {
  readonly bookId: number

  constructor(bookId: number) {
    super(`Book ${bookId} has no cover`)
    this.name = 'CoverNotFoundError'
    this.bookId = bookId
  }
}
