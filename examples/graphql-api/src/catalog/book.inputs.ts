import type { Int, StandardSchemaV1 } from '@znight/graphql'

import { z } from 'zod'

import { Genre } from './book.js'

/** A new book. The interface is the GraphQL input type, the schema of the same name validates it. */
export interface NewBookInput {
  readonly title: string
  /** ISBN-10 or ISBN-13; spaces and hyphens are ignored. */
  readonly isbn: string
  readonly authorId: string
  readonly genre: Genre
  readonly publishedYear?: Int | null | undefined
  readonly tags?: readonly string[] | undefined
}

/**
 * Runs after GraphQL checked the types; the resolver receives its output (trimmed title, normalised
 * ISBN, lower-cased tags). A failure is a `BAD_USER_INPUT` error listing `{ path, message }` issues.
 */
export const NewBookInput: StandardSchemaV1<unknown, NewBookInput> = z.object({
  title: z.string().trim().min(1, 'A title is required').max(200),
  isbn: z
    .string()
    .transform(isbn => isbn.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^(?:\d{9}[\dX]|\d{13})$/, 'An ISBN has 10 or 13 digits')),
  authorId: z.string().min(1),
  genre: z.enum(Genre), // receives the internal value ('fantasy'): GraphQL already mapped the name
  publishedYear: z.number().int().min(-3000).max(2100, 'Not published yet').nullish(),
  tags: z.array(z.string().trim().toLowerCase().min(1)).max(10).optional(),
})
