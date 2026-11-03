import type { Author, Book } from '../../src/catalog/book.js'
import type { Review } from '../../src/reviews/review.js'

import { AUTHORS, BOOKS, REVIEWS } from '../../src/catalog/seed.js'

function find<T extends { readonly id: string }>(items: readonly T[], id: string): T {
  const item = items.find(candidate => candidate.id === id)
  if (item === undefined) throw new Error(`No seed item ${id}`)
  return item
}

/** Seed data used by name in the tests. */
export const herbert: Author = find(AUTHORS, 'a1')
export const leGuin: Author = find(AUTHORS, 'a2')
export const tolkien: Author = find(AUTHORS, 'a3')
export const dune: Book = find(BOOKS, 'b1')
export const earthsea: Book = find(BOOKS, 'b3')
export const hobbit: Book = find(BOOKS, 'b5')
export const duneReviews: readonly Review[] = REVIEWS.filter(review => review.bookId === dune.id)

/** A book that is not in the catalog yet, as `NewBookInput` variables (enum names on the wire). */
export const FELLOWSHIP = {
  title: 'The Fellowship of the Ring',
  isbn: '978-0-547-92821-0',
  authorId: tolkien.id,
  genre: 'Fantasy',
  publishedYear: 1954,
  tags: ['Rings', ' Quest '],
} as const

/** Another one, of another genre. */
export const DISPOSSESSED = {
  title: 'The Dispossessed',
  isbn: '9780061054884',
  authorId: leGuin.id,
  genre: 'ScienceFiction',
} as const

export const ADD_BOOK = /* GraphQL */ `
  mutation AddBook($input: NewBookInput!) {
    addBook(input: $input) { id title isbn genre publishedYear tags author { name } }
  }
`
