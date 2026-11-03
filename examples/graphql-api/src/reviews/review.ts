import type { ID, Int, StandardSchemaV1 } from '@znight/graphql'
import type { EmailAddress } from '../shared/scalars.js'

import { z } from 'zod'

/** A reader's review of a book. */
export interface Review {
  readonly id: ID
  /** From 1 to 5. */
  readonly rating: Int
  readonly comment: string | null
  /** Who wrote it. */
  readonly reviewer: EmailAddress
  readonly createdAt: Date
  /** @gqlHidden The reviewed book: `Book.reviews` is the way in. */
  readonly bookId: ID
}

// `reviewer` is an `EmailAddress` scalar: GraphQL checks and lower-cases it before the schema runs.
/** A new review, signed with the reviewer's e-mail address. */
export interface NewReviewInput {
  readonly bookId: ID
  /** From 1 to 5. */
  readonly rating: Int
  readonly comment?: string | null | undefined
  readonly reviewer: EmailAddress
}

export const NewReviewInput: StandardSchemaV1<unknown, NewReviewInput> = z.object({
  bookId: z.string().min(1),
  rating: z.number().int().min(1, 'From 1 to 5').max(5, 'From 1 to 5'),
  comment: z.string().trim().max(2000).nullish(),
  reviewer: z.custom<EmailAddress>(value => typeof value === 'string'), // the scalar already parsed it
})

/** Arguments of `Book.reviews`. */
export interface ReviewsArgs {
  /**
   * How many reviews, newest first (at most 50).
   * @default 5
   */
  readonly first?: Int
}
