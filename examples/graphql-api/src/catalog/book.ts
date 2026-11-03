import type { ID, Int } from '@znight/graphql'

/*
 * The types of the catalog are the GraphQL schema: the compiler follows every type the resolvers'
 * signatures reach. Nothing here imports a decorator; descriptions and deprecations come from JSDoc.
 */

/** A book of the catalog. */
export interface Book {
  readonly kind: 'book'
  readonly id: ID
  readonly title: string
  readonly isbn: string
  /** Year of first publication, `null` when unknown. */
  readonly publishedYear: Int | null
  readonly genre: Genre
  readonly tags: readonly string[]
  /** When the book entered the catalog. */
  readonly createdAt: Date
  /** @deprecated Use `tags`. */
  readonly category?: string
  /** @gqlHidden Exposed as `author` by BookResolver. */
  readonly authorId: ID
}

/** Literary genres. */
export enum Genre {
  Fantasy = 'fantasy',
  ScienceFiction = 'science-fiction',
  Mystery = 'mystery',
}

/** A writer. */
export interface Author {
  readonly kind: 'author'
  readonly id: ID
  readonly name: string
  /** Year of birth, `null` when unknown. */
  readonly born: Int | null
}

/** A page of results. */
export interface Page<T> {
  readonly items: readonly T[]
  /** How many results match, across every page. */
  readonly total: Int
  /** `true` when a following page exists. */
  readonly hasMore: boolean
}

/** Sort orders of the book list. */
export type BookSort = 'title' | 'newest'
