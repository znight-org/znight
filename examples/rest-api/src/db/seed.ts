import type { Database } from './database.js'

import { count } from 'drizzle-orm'

import { books } from './schema.js'

/** A few books, so that a development server is not empty. */
const SAMPLE_BOOKS = [
  {
    isbn: '9780547928227',
    title: 'The Hobbit',
    author: 'J. R. R. Tolkien',
    publishedYear: 1937,
    tags: ['fantasy', 'classic'],
  },
  {
    isbn: '9780441172719',
    title: 'Dune',
    author: 'Frank Herbert',
    publishedYear: 1965,
    tags: ['science-fiction', 'classic'],
  },
  {
    isbn: '9780262510875',
    title: 'Structure and Interpretation of Computer Programs',
    author: 'Harold Abelson, Gerald Jay Sussman',
    publishedYear: 1985,
    tags: ['programming'],
  },
]

/** Inserts the sample books when the table is empty; returns the number of inserted books. */
export async function seedBooks(db: Database): Promise<number> {
  const [existing] = await db.select({ total: count() }).from(books)
  if ((existing?.total ?? 0) > 0) return 0
  await db.insert(books).values(SAMPLE_BOOKS.map(book => ({ ...book, createdBy: 'seed' })))
  return SAMPLE_BOOKS.length
}
