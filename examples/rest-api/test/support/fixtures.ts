import type { Book } from '../../src/books/book.js'

import { fileURLToPath } from 'node:url'

/** API keys used by the tests. */
export const ADMIN_KEY = 'test-admin-key'
export const READER_KEY = 'test-reader-key'

/** The browser front-end allowed by CORS in the tests (`CORS_ORIGINS`). */
export const BROWSER_ORIGIN = 'https://shelf.test'

/** The SQL migrations of the application (absolute: tests may run from any directory). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** The 8-byte PNG signature followed by a few bytes: enough for the content sniffing of covers. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])

export function pngFile(name = 'cover.png', type = 'image/png'): File {
  return new File([PNG_BYTES], name, { type })
}

/** A domain book, for unit tests. */
export function aBook(fields: Partial<Book> = {}): Book {
  return {
    id: 1,
    isbn: '9780547928227',
    title: 'The Hobbit',
    author: 'J. R. R. Tolkien',
    publishedYear: 1937,
    tags: ['fantasy'],
    createdBy: 'admin',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    coverUpdatedAt: null,
    ...fields,
  }
}
