/**
 * Source files of the end-to-end application (`e2e.test.ts`): a library catalog compiled with
 * `compile()` and served by `HttpPlugin` + `GraphQLPlugin`. It covers queries, a mutation validated
 * with Zod, field resolvers batched by a singleton and a request-scoped loader, a TypeScript enum, a
 * literal-union enum, a union told apart by `kind`, a generic `Page<T>`, a custom scalar, JSDoc
 * descriptions and deprecations, a required route decorator group enforced by a guard, and a
 * subscription over the default `PubSub`.
 */

const ACCESS = `import { createRouteDecorator } from '@znight/http'

export type Role = 'reader' | 'editor'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
`

/** Reads the role from the \`x-role\` header: none is UNAUTHENTICATED, a role not listed is FORBIDDEN. */
const ACCESS_GUARD = `import { Injectable } from '@znight/core'
import { GraphQLException, type GraphQLGuard, type ResolverContext } from '@znight/graphql'

import { Authenticated, Public, type Role, Roles } from './access.ts'

@Injectable()
export class AccessGuard implements GraphQLGuard {
  static readonly enforces = [Public, Authenticated, Roles]

  canResolve(ctx: ResolverContext): boolean {
    if (Public.get(ctx) === true) return true
    const role = ctx.http?.header('x-role')
    if (role === undefined) throw new GraphQLException('Sign in first', { code: 'UNAUTHENTICATED' })
    const roles = Roles.get(ctx)
    return roles === undefined ? Authenticated.get(ctx) === true : roles.includes(role as Role)
  }
}
`

const ISBN = `import { scalar } from '@znight/graphql'

export type Isbn = string & { readonly __brand: 'Isbn' }

export const IsbnScalar = scalar<Isbn>('Isbn', {
  description: 'An ISBN-13, thirteen digits.',
  specifiedByURL: 'https://www.isbn-international.org/content/what-isbn',
  serialize: value => value,
  parseValue: value => {
    if (typeof value !== 'string' || !/^[0-9]{13}$/.test(value)) throw new TypeError('An ISBN has 13 digits')
    return value as Isbn
  },
})
`

const MODEL = `import type { ID, Int } from '@znight/graphql'
import type { Isbn } from './isbn.ts'

/** A book of the catalog. */
export interface Book {
  readonly kind: 'book'
  readonly id: ID
  readonly title: string
  readonly isbn: Isbn
  /** Year of first publication, \`null\` when unknown. */
  readonly publishedYear: Int | null
  readonly genre: Genre
  readonly createdAt: Date
  /** @deprecated Use \`genre\`. */
  readonly category?: string
  /** @gqlHidden Exposed as \`author\` by BookResolver. */
  readonly authorId: ID
}

/** Literary genres. */
export enum Genre {
  Fantasy = 'fantasy',
  ScienceFiction = 'science-fiction',
}

export interface Author {
  readonly kind: 'author'
  readonly id: ID
  readonly name: string
}

/** A reader's review. */
export interface Review {
  readonly id: ID
  readonly stars: Int
}

/** A page of results. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: Int
}

/** Sort orders of the book list. */
export type BookSort = 'title' | 'newest'

/** A search hit, told apart by \`kind\`. */
export type SearchResult = Book | Author

/** Events of the catalog. */
export interface CatalogEvents {
  bookAdded: Book
}
`

const ARGS = `import type { Int } from '@znight/graphql'
import type { BookSort, Genre } from './model.ts'

/** Criteria of \`Query.books\`. */
export interface BookFilter {
  /** Case-insensitive search in titles. */
  readonly search?: string
  readonly genre?: Genre
  /** @default "title" */
  readonly sort?: BookSort
  /** @default 10 */
  readonly limit?: Int
}
`

const INPUTS = `import type { Int, StandardSchemaV1 } from '@znight/graphql'
import type { Isbn } from './isbn.ts'
import { Genre } from './model.ts'

import { z } from 'zod'

/** A new book: the interface is the input type, the schema of the same name validates it. */
export interface NewBookInput {
  readonly title: string
  readonly isbn: Isbn
  readonly authorId: string
  readonly genre: Genre
  readonly publishedYear?: Int | null | undefined
}

export const NewBookInput: StandardSchemaV1<unknown, NewBookInput> = z.object({
  title: z.string().trim().min(1, 'A title is required'),
  isbn: z.custom<Isbn>(value => typeof value === 'string'),
  authorId: z.string(),
  genre: z.enum(Genre),
  publishedYear: z.number().int().max(2100, 'Not published yet').nullish(),
})
`

/** In-memory data, plus the batches the loaders received. */
const STORE = `import { Injectable } from '@znight/core'
import type { ID } from '@znight/graphql'
import type { Isbn } from './isbn.ts'
import { type Author, type Book, Genre, type Review } from './model.ts'

@Injectable()
export class CatalogStore {
  readonly authors: Author[] = [
    { kind: 'author', id: 'a1', name: 'Frank Herbert' },
    { kind: 'author', id: 'a2', name: 'Ursula K. Le Guin' },
  ]
  readonly books: Book[] = [
    {
      kind: 'book',
      id: 'b1',
      title: 'Dune',
      isbn: '9780441013593' as Isbn,
      publishedYear: 1965,
      genre: Genre.ScienceFiction,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      category: 'classics',
      authorId: 'a1',
    },
    {
      kind: 'book',
      id: 'b2',
      title: 'A Wizard of Earthsea',
      isbn: '9780547773742' as Isbn,
      publishedYear: 1968,
      genre: Genre.Fantasy,
      createdAt: new Date('2024-01-02T00:00:00.000Z'),
      authorId: 'a2',
    },
    {
      kind: 'book',
      id: 'b3',
      title: 'Children of Dune',
      isbn: '9780593098240' as Isbn,
      publishedYear: null,
      genre: Genre.ScienceFiction,
      createdAt: new Date('2024-01-03T00:00:00.000Z'),
      authorId: 'a1',
    },
  ]
  readonly reviews: ReadonlyMap<ID, readonly Review[]> = new Map([
    ['b1', [{ id: 'r1', stars: 5 }, { id: 'r2', stars: 4 }]],
    ['b2', [{ id: 'r3', stars: 5 }]],
  ])
  /** Keys of every batch of AuthorsById, and of ReviewsByBook. */
  readonly authorBatches: (readonly ID[])[] = []
  readonly reviewBatches: (readonly ID[])[] = []
  /** Instances of ReviewsByBook created (one per request). */
  reviewLoaders = 0
}
`

const AUTHORS = `import { Injectable } from '@znight/core'
import { type BatchLoad, type ID, orderByKeys } from '@znight/graphql'
import { CatalogStore } from './catalog.store.ts'
import type { Author } from './model.ts'

/** Singleton loader. */
@Injectable()
export class AuthorsById implements BatchLoad<ID, Author> {
  constructor(private readonly store: CatalogStore) {}

  async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
    this.store.authorBatches.push([...ids])
    return orderByKeys(ids, this.store.authors.filter(author => ids.includes(author.id)), author => author.id)
  }
}
`

const REVIEWS = `import { Injectable } from '@znight/core'
import type { BatchLoad, ID } from '@znight/graphql'
import { CatalogStore } from './catalog.store.ts'
import type { Review } from './model.ts'

/** Request-scoped loader. */
@Injectable({ scope: 'request' })
export class ReviewsByBook implements BatchLoad<ID, readonly Review[]> {
  constructor(private readonly store: CatalogStore) {
    store.reviewLoaders++
  }

  async load(ids: readonly ID[]): Promise<readonly (readonly Review[])[]> {
    this.store.reviewBatches.push([...ids])
    return ids.map(id => this.store.reviews.get(id) ?? [])
  }
}
`

const BOOK_RESOLVER = `import {
  Args,
  Ctx,
  type GraphQLContext,
  type ID,
  Loader,
  Mutation,
  Parent,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
  UseGuard,
} from '@znight/graphql'

import { Public, Roles } from '../auth/access.ts'
import { AccessGuard } from '../auth/access.guard.ts'
import { AuthorsById } from './authors-by-id.loader.ts'
import type { BookFilter } from './book.args.ts'
import { NewBookInput } from './book.inputs.ts'
import { CatalogStore } from './catalog.store.ts'
import type { Author, Book, CatalogEvents, Genre, Page, Review, SearchResult } from './model.ts'
import { ReviewsByBook } from './reviews-by-book.loader.ts'

@Resolver()
@UseGuard(AccessGuard)
@Public()
export class BookResolver {
  constructor(
    private readonly store: CatalogStore,
    private readonly events: PubSub<CatalogEvents>,
  ) {}

  /** Books of the catalog, filtered and paginated. */
  @Query()
  books(@Args() filter: BookFilter): Page<Book> {
    const search = filter.search?.toLowerCase()
    const items = this.store.books
      .filter(book => search === undefined || book.title.toLowerCase().includes(search))
      .filter(book => filter.genre === undefined || book.genre === filter.genre)
      .sort((a, b) =>
        filter.sort === 'newest' ? b.createdAt.getTime() - a.createdAt.getTime() : a.title.localeCompare(b.title),
      )
    return { items: items.slice(0, filter.limit ?? 10), total: items.length }
  }

  /**
   * One book.
   * @param id The id of the book.
   */
  @Query()
  book(@Args('id') id: ID): Book | null {
    return this.store.books.find(book => book.id === id) ?? null
  }

  /** Books whose title, and authors whose name, contain the text. */
  @Query()
  search(@Args('text') text: string): readonly SearchResult[] {
    const needle = text.toLowerCase()
    return [
      ...this.store.books.filter(book => book.title.toLowerCase().includes(needle)),
      ...this.store.authors.filter(author => author.name.toLowerCase().includes(needle)),
    ]
  }

  /** Adds a book to the catalog. */
  @Mutation()
  @Roles(['editor'])
  async addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    const book: Book = {
      kind: 'book',
      id: \`b\${this.store.books.length + 1}\`,
      title: input.title,
      isbn: input.isbn,
      publishedYear: input.publishedYear ?? null,
      genre: input.genre,
      createdAt: new Date('2024-02-01T00:00:00.000Z'),
      authorId: input.authorId,
    }
    this.store.books.push(book)
    await this.events.publish('bookAdded', book)
    return book
  }

  /** Who wrote the book: one batch per execution. */
  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }

  /** Reviews of the book: one batch per execution, a loader instance per request. */
  @ResolveField()
  reviews(@Parent() book: Book, @Loader() reviews: Loader<ReviewsByBook>): Promise<readonly Review[]> {
    return reviews.load(book.id)
  }

  /** Books added from now on, optionally of one genre. */
  @Subscription()
  async *bookAdded(@Args('genre') genre: Genre | undefined, @Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
    for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) {
      if (genre === undefined || book.genre === genre) yield book
    }
  }
}
`

const ACCOUNT_RESOLVER = `import { Ctx, type GraphQLContext, Query, Resolver, UseGuard } from '@znight/graphql'

import { Authenticated } from '../auth/access.ts'
import { AccessGuard } from '../auth/access.guard.ts'

@Resolver()
@UseGuard(AccessGuard)
export class AccountResolver {
  /** The role of the caller. */
  @Query()
  @Authenticated()
  whoami(@Ctx() ctx: GraphQLContext): string {
    return ctx.http?.header('x-role') ?? 'nobody'
  }
}
`

/** The application, by path. */
export const LIBRARY: Readonly<Record<string, string>> = {
  'src/auth/access.ts': ACCESS,
  'src/auth/access.guard.ts': ACCESS_GUARD,
  'src/auth/account.resolver.ts': ACCOUNT_RESOLVER,
  'src/catalog/isbn.ts': ISBN,
  'src/catalog/model.ts': MODEL,
  'src/catalog/book.args.ts': ARGS,
  'src/catalog/book.inputs.ts': INPUTS,
  'src/catalog/catalog.store.ts': STORE,
  'src/catalog/authors-by-id.loader.ts': AUTHORS,
  'src/catalog/reviews-by-book.loader.ts': REVIEWS,
  'src/catalog/book.resolver.ts': BOOK_RESOLVER,
}
