import type { Book } from '../catalog/book.js'
import type { CatalogEvents } from '../catalog/catalog.events.js'
import type { ReviewsArgs } from './review.js'
import type { ReviewService } from './review.service.js'
import type { ReviewsByBook } from './reviews-by-book.loader.js'

import {
  Args,
  Ctx,
  type GraphQLContext,
  type ID,
  Loader,
  Mutation,
  Parent,
  type PubSub,
  ResolveField,
  Resolver,
  Subscription,
} from '@znight/graphql'

import { Authenticated } from '../auth/access.js'
import { NewReviewInput, type Review } from './review.js'

/**
 * Reviews: a field of `Book` (field resolvers may live in any resolver class), a mutation and a
 * subscription. No class-level decision on purpose: a decision on the class would also apply to
 * `Book.reviews`, whose guards would then run once per book; without one, the field is covered by
 * the root field it descends from (`books`, `book`: public).
 */
@Resolver()
export class ReviewResolver {
  constructor(
    private readonly service: ReviewService,
    private readonly events: PubSub<CatalogEvents>,
  ) {}

  /** Reviews of the book, newest first. Batched: one repository call per execution. */
  @ResolveField()
  reviews(
    @Parent() book: Book,
    @Args() args: ReviewsArgs,
    @Loader() reviews: Loader<ReviewsByBook>,
  ): Promise<readonly Review[]> {
    // `first` has a schema default: undefined only when the client sends null explicitly
    const first = Math.min(Math.max(args.first ?? 5, 0), 50)
    return reviews.load(book.id).then(all => all.slice(0, first))
  }

  /** Reviews a book. */
  @Mutation()
  @Authenticated()
  async addReview(@Args('input', NewReviewInput) input: NewReviewInput): Promise<Review> {
    const review = await this.service.add(input)
    await this.events.publish('reviewAdded', review)
    return review
  }

  /**
   * Reviews of one book, from now on.
   * @param bookId The reviewed book.
   */
  @Subscription()
  @Authenticated()
  async *reviewAdded(@Args('bookId') bookId: ID, @Ctx() ctx: GraphQLContext): AsyncGenerator<Review> {
    for await (const review of this.events.subscribe('reviewAdded', { signal: ctx.signal })) {
      if (review.bookId === bookId) yield review
    }
  }
}
