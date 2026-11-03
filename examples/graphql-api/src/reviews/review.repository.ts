import type { ID } from '@znight/graphql'
import type { Review } from './review.js'

import { Injectable } from '@znight/core'

import { REVIEWS } from '../catalog/seed.js'

/** Reviews, in memory. Asynchronous like a database would be. */
@Injectable()
export class ReviewRepository {
  readonly #reviews: Review[] = [...REVIEWS]

  /** The reviews of the books among `bookIds`, newest first: one query, whatever the number of books. */
  findByBooks(bookIds: readonly ID[]): Promise<Review[]> {
    const reviews = this.#reviews.filter(review => bookIds.includes(review.bookId))
    return Promise.resolve(reviews.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()))
  }

  /** Stores a new review under the next id. */
  insert(review: Omit<Review, 'id'>): Promise<Review> {
    const stored: Review = { ...review, id: `r${this.#reviews.length + 1}` }
    this.#reviews.push(stored)
    return Promise.resolve(stored)
  }
}
