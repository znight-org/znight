import type { Review } from '../reviews/review.js'
import type { EmailAddress } from '../shared/scalars.js'
import type { Author, Book } from './book.js'

import { Genre } from './book.js'

/*
 * The data the in-memory repositories start with. Each application instance gets its own copy, so
 * that tests never share state. The data layer is the subject of examples/rest-api (Drizzle on
 * PostgreSQL): here it stays out of the way.
 */

export const AUTHORS: readonly Author[] = [
  { kind: 'author', id: 'a1', name: 'Frank Herbert', born: 1920 },
  { kind: 'author', id: 'a2', name: 'Ursula K. Le Guin', born: 1929 },
  { kind: 'author', id: 'a3', name: 'J. R. R. Tolkien', born: 1892 },
  { kind: 'author', id: 'a4', name: 'Agatha Christie', born: 1890 },
]

const book = (
  id: string,
  title: string,
  isbn: string,
  publishedYear: number | null,
  genre: Genre,
  authorId: string,
  tags: readonly string[],
  day: number,
): Book => ({
  kind: 'book',
  id,
  title,
  isbn,
  publishedYear,
  genre,
  tags,
  createdAt: new Date(Date.UTC(2026, 0, day)),
  authorId,
})

export const BOOKS: readonly Book[] = [
  {
    ...book('b1', 'Dune', '9780441013593', 1965, Genre.ScienceFiction, 'a1', ['desert', 'politics'], 1),
    category: 'classics',
  },
  book('b2', 'Children of Dune', '9780593098240', 1976, Genre.ScienceFiction, 'a1', ['desert'], 2),
  book('b3', 'A Wizard of Earthsea', '9780547773742', 1968, Genre.Fantasy, 'a2', ['magic'], 3),
  book('b4', 'The Left Hand of Darkness', '9780441478125', 1969, Genre.ScienceFiction, 'a2', ['politics'], 4),
  book('b5', 'The Hobbit', '9780547928227', 1937, Genre.Fantasy, 'a3', ['dragons', 'magic'], 5),
  book('b6', 'Murder on the Orient Express', '9780062693662', null, Genre.Mystery, 'a4', ['train'], 6),
]

const review = (id: string, bookId: string, rating: number, comment: string | null, day: number): Review => ({
  id,
  bookId,
  rating,
  comment,
  reviewer: `reader${id.slice(1)}@books.example` as EmailAddress,
  createdAt: new Date(Date.UTC(2026, 1, day)),
})

export const REVIEWS: readonly Review[] = [
  review('r1', 'b1', 5, 'The spice must flow.', 1),
  review('r2', 'b1', 4, null, 2),
  review('r3', 'b3', 5, 'A school of wizards, before it was cool.', 3),
  review('r4', 'b5', 4, 'There and back again.', 4),
]
