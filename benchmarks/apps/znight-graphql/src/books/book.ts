import type { ID, Int } from '@znight/graphql'

/** A book: the GraphQL `Book` type (`author` is resolved by BookResolver). */
export interface Book {
  readonly id: ID
  readonly title: string
  readonly year: Int
  /** @gqlHidden Exposed as `author` by BookResolver. */
  readonly authorId: ID
}
