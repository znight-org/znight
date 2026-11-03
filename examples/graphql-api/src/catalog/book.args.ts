import type { Int, StandardSchemaV1 } from '@znight/graphql'
import type { BookSort } from './book.js'

import { z } from 'zod'

import { Genre } from './book.js'

/**
 * Criteria of `Query.books`: `@Args()` spreads each property into an argument. `@default` gives the
 * schema default (printed in the SDL, applied by graphql-js); `?` makes the argument nullable, and a
 * `null` sent by the client arrives as `undefined` (the type does not accept `null`).
 */
export interface BookFilter {
  /** Case-insensitive search in titles. */
  readonly search?: string
  readonly genre?: Genre
  /** @default "title" */
  readonly sort?: BookSort
  /**
   * Page size, at most 100.
   * @default 20
   */
  readonly limit?: Int
  /** @default 0 */
  readonly offset?: Int
}

/**
 * Validates the arguments object after GraphQL coerced it (`@Args(BookFilter)`): GraphQL knows that
 * `limit` is an `Int`, the schema bounds it. A failure is a `BAD_USER_INPUT` error with its issues.
 */
export const BookFilter: StandardSchemaV1<unknown, BookFilter> = z.object({
  search: z.string().trim().max(100).optional(),
  genre: z.enum(Genre).optional(), // the internal value ('fantasy'): GraphQL already mapped the name
  sort: z.enum(['title', 'newest']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
})
