import type { BatchLoad, ID } from '@znight/graphql'
import type { Review } from './review.js'
import type { ReviewRepository } from './review.repository.js'

import { Injectable } from '@znight/core'

/** Loads the reviews of books, newest first, in batches: one repository query per execution. */
@Injectable()
export class ReviewsByBook implements BatchLoad<ID, readonly Review[]> {
  constructor(private readonly reviews: ReviewRepository) {}

  async load(bookIds: readonly ID[]): Promise<readonly (readonly Review[])[]> {
    const reviews = await this.reviews.findByBooks(bookIds)
    return bookIds.map(id => reviews.filter(review => review.bookId === id))
  }
}
