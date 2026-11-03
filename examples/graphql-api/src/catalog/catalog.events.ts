import type { Review } from '../reviews/review.js'
import type { Book } from './book.js'

/** Topics of the application `PubSub` and their payloads. */
export interface CatalogEvents {
  bookAdded: Book
  reviewAdded: Review
}
