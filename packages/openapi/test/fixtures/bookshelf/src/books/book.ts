/** Sort orders of the list. */
export type BookSort = 'title' | 'author' | 'year'

/** Literary genres. */
export enum Genre {
  Novel = 'novel',
  Poetry = 'poetry',
}

/** A book of the shelf. */
export interface BookResponse {
  /** @format int64 */
  readonly id: number
  /**
   * The title.
   * @minLength 1
   * @example "Dune"
   */
  readonly title: string
  readonly isbn: string
  readonly genre: Genre
  readonly publishedYear: number | null
  readonly tags: readonly string[]
  readonly createdAt: Date
  readonly coverUrl?: string
  /** @deprecated Use tags. */
  readonly labels?: string[]
}

/** A page of results. */
export interface Page<T> {
  readonly items: T[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** Statistics of the shelf. */
export interface ShelfReport {
  readonly books: number
  readonly genres: Readonly<Record<string, number>>
}

export interface Card {
  readonly method: 'card'
  readonly last4: string
}

export interface Transfer {
  readonly method: 'transfer'
  readonly iban: string
}

/** How an order is paid. */
export type Payment = Card | Transfer

export interface SearchParams {
  /** Free text. */
  readonly text?: string
  readonly page: number
}
