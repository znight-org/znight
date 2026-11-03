import type { BookRepository } from '../catalog/book.repository.js'
import type { NewReviewInput, Review } from './review.js'
import type { ReviewRepository } from './review.repository.js'

import { Injectable } from '@znight/core'

import { BookNotFoundError } from '../catalog/errors.js'

/** Reviews, independent of GraphQL. */
@Injectable()
export class ReviewService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly books: BookRepository,
  ) {}

  /** Adds a review to an existing book (a `BookNotFoundError` otherwise). */
  async add(input: NewReviewInput): Promise<Review> {
    if ((await this.books.findById(input.bookId)) === undefined) throw new BookNotFoundError(input.bookId)
    return await this.reviews.insert({
      bookId: input.bookId,
      rating: input.rating,
      comment: input.comment ?? null,
      reviewer: input.reviewer,
      createdAt: new Date(),
    })
  }
}
