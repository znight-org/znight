import type { Lazy } from '@znight/core'
import type { CurrentUser } from '../auth/current-user.js'
import type { AuthorsById } from './authors-by-id.loader.js'
import type { Author, Book, Genre, Page } from './book.js'
import type { CatalogEvents } from './catalog.events.js'
import type { CatalogService } from './catalog.service.js'

import {
  Args,
  Ctx,
  type GraphQLContext,
  type ID,
  Loader,
  Mutation,
  Parent,
  type PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from '@znight/graphql'

import { Authenticated, Public, Roles } from '../auth/access.js'
import { BookFilter } from './book.args.js'
import { NewBookInput } from './book.inputs.js'

/**
 * The book fields of the schema. A resolver is a provider (a singleton here): constructor injection,
 * scopes and interceptors work as everywhere else. Methods stay thin: they map GraphQL to the
 * catalog service.
 */
@Resolver()
@Public() // the default access decision of every field of this class
export class BookResolver {
  constructor(
    private readonly catalog: CatalogService,
    private readonly events: PubSub<CatalogEvents>,
    // a singleton: the request-scoped CurrentUser is read through Lazy (injecting it directly is ZNIGHT003)
    private readonly user: Lazy<CurrentUser>,
  ) {}

  /** Books of the catalog, filtered, sorted and paginated. */
  @Query()
  books(@Args(BookFilter) filter: BookFilter): Promise<Page<Book>> {
    return this.catalog.list(filter)
  }

  /**
   * One book, `null` when there is none.
   * @param id The id of the book.
   */
  @Query()
  book(@Args('id') id: ID): Promise<Book | null> {
    return this.catalog.find(id)
  }

  /** Adds a book to the catalog. */
  @Mutation()
  @Roles(['editor']) // replaces the class decision
  async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    const book = await this.catalog.add(input, this.user.get().principal.name)
    await this.events.publish('bookAdded', book)
    return book
  }

  /** Who wrote the book. Batched: one repository call per execution, whatever the number of books. */
  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }

  /**
   * Books added from now on, optionally of one genre.
   * @param genre Only books of this genre.
   */
  @Subscription()
  @Authenticated()
  async *bookAdded(@Args('genre') genre: Genre | undefined, @Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
    // ctx.signal aborts when the client leaves, on shutdown, or after subscriptions.maxDuration
    for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) {
      if (genre === undefined || book.genre === genre) yield book
    }
  }
}
