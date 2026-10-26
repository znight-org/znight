/**
 * Drizzle schema: the TypeScript description of the tables, used to build type-safe queries. The
 * tables themselves are created by the SQL migrations of `drizzle/` (applied at startup by
 * `DatabaseFactory`): keep both in sync, or generate the migrations from this file with drizzle-kit.
 */
import { sql } from 'drizzle-orm'
import { customType, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** PostgreSQL `bytea`, read and written as `Uint8Array` (PGlite's representation). */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
})

export const books = pgTable(
  'books',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    isbn: text('isbn').notNull().unique(),
    title: text('title').notNull(),
    author: text('author').notNull(),
    publishedYear: integer('published_year'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Name of the API key that added the book. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('books_author_idx').on(table.author)],
)

/** Cover images, apart from the books so that listing books never reads image bytes. */
export const bookCovers = pgTable('book_covers', {
  bookId: integer('book_id')
    .primaryKey()
    .references(() => books.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  data: bytea('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
