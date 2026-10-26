import type { Database } from '../db/database.js'
import type { BookRepository } from './book.repository.js'

import { Injectable } from '@znight/core'
import { and, arrayOverlaps, asc, count, desc, eq, getTableColumns, ilike, or, type SQL, sql } from 'drizzle-orm'

import { bookCovers, books } from '../db/schema.js'
import {
  type Book,
  type BookChanges,
  type BookQuery,
  type BookSort,
  type Cover,
  DuplicateIsbnError,
  type NewBook,
  type Page,
} from './book.js'

/** Columns of a book, plus the date of its cover (`null` without cover). */
const BOOK_COLUMNS = { ...getTableColumns(books), coverUpdatedAt: bookCovers.updatedAt }

const ORDER_BY: Record<BookSort, SQL[]> = {
  title: [asc(books.title), asc(books.id)],
  author: [asc(books.author), asc(books.title), asc(books.id)],
  year: [sql`${books.publishedYear} asc nulls last`, asc(books.id)],
  newest: [desc(books.createdAt), desc(books.id)],
}

/** PostgreSQL error codes (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'

/**
 * `BookRepository` implemented with Drizzle. `@Injectable()` + `implements BookRepository` is all the
 * compiler needs to inject it wherever a `BookRepository` is expected.
 */
@Injectable()
export class DrizzleBookRepository implements BookRepository {
  constructor(private readonly db: Database) {}

  async list(query: BookQuery): Promise<Page<Book>> {
    const where = and(
      query.search ? searchCondition(query.search) : undefined,
      query.author ? eq(books.author, query.author) : undefined,
      query.tags?.length ? arrayOverlaps(books.tags, [...query.tags]) : undefined,
    )
    const items = await this.db
      .select(BOOK_COLUMNS)
      .from(books)
      .leftJoin(bookCovers, eq(bookCovers.bookId, books.id))
      .where(where)
      .orderBy(...ORDER_BY[query.sort])
      .limit(query.limit)
      .offset(query.offset)
    const [counted] = await this.db.select({ total: count() }).from(books).where(where)
    return { items, total: counted?.total ?? 0, limit: query.limit, offset: query.offset }
  }

  async findById(id: number): Promise<Book | undefined> {
    if (!isBookId(id)) return undefined
    const [book] = await this.db
      .select(BOOK_COLUMNS)
      .from(books)
      .leftJoin(bookCovers, eq(bookCovers.bookId, books.id))
      .where(eq(books.id, id))
    return book
  }

  async create(book: NewBook, createdBy: string): Promise<Book> {
    try {
      const [created] = await this.db
        .insert(books)
        .values({ ...book, tags: book.tags ? [...book.tags] : [], createdBy })
        .returning()
      if (created === undefined) throw new Error('INSERT returned no row')
      return { ...created, coverUpdatedAt: null }
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) throw new DuplicateIsbnError(book.isbn)
      throw error
    }
  }

  async update(id: number, changes: BookChanges): Promise<Book | undefined> {
    if (!isBookId(id)) return undefined
    const values = {
      ...definedOnly({ ...changes, tags: changes.tags ? [...changes.tags] : undefined }),
      updatedAt: new Date(),
    }
    try {
      const updated = await this.db.update(books).set(values).where(eq(books.id, id)).returning({ id: books.id })
      return updated.length === 0 ? undefined : await this.findById(id)
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION && changes.isbn) throw new DuplicateIsbnError(changes.isbn)
      throw error
    }
  }

  async delete(id: number): Promise<boolean> {
    if (!isBookId(id)) return false
    // the cover goes with the book (ON DELETE CASCADE)
    const deleted = await this.db.delete(books).where(eq(books.id, id)).returning({ id: books.id })
    return deleted.length > 0
  }

  async saveCover(id: number, cover: Omit<Cover, 'updatedAt'>): Promise<boolean> {
    if (!isBookId(id)) return false
    try {
      await this.db
        .insert(bookCovers)
        .values({ bookId: id, contentType: cover.contentType, data: cover.data })
        .onConflictDoUpdate({
          target: bookCovers.bookId,
          set: { contentType: cover.contentType, data: cover.data, updatedAt: sql`now()` },
        })
      return true
    } catch (error) {
      // the book does not exist: no need for a SELECT first (and no race with a DELETE)
      if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) return false
      throw error
    }
  }

  async findCover(id: number): Promise<Cover | undefined> {
    if (!isBookId(id)) return undefined
    const [cover] = await this.db
      .select({ contentType: bookCovers.contentType, data: bookCovers.data, updatedAt: bookCovers.updatedAt })
      .from(bookCovers)
      .where(eq(bookCovers.bookId, id))
    return cover
  }
}

/** Ids are PostgreSQL `integer`s: anything else cannot exist (and would fail the query). */
function isBookId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= 1 && id <= 2_147_483_647
}

function searchCondition(search: string): SQL | undefined {
  const pattern = `%${search.replace(/[\\%_]/g, character => `\\${character}`)}%`
  return or(ilike(books.title, pattern), ilike(books.author, pattern))
}

/** Removes the `undefined` properties (absent from a PATCH body: left unchanged). */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

/**
 * SQLSTATE of a database error. Drizzle wraps driver errors (`DrizzleQueryError`) and keeps the
 * original one as `cause`.
 */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = current.cause
  }
  return undefined
}
