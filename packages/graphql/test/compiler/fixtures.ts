/**
 * Source files of the test applications: the catalog of RFC 0005 §5 (books, authors, loaders,
 * unions, generics, enums, inputs, scalars, subscriptions, access decisions).
 */

/** Route decorators and guards shared by controllers and resolvers (RFC 0005 §5.9). */
export const ACCESS = `import { createRouteDecorator } from '@znight/http'

export type Role = 'reader' | 'editor' | 'admin'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
`

export const ACCESS_GUARD = `import { Injectable } from '@znight/core'
import type { GraphQLGuard, ResolverContext } from '@znight/graphql'

import { Public } from './access.ts'

@Injectable()
export class AccessGuard implements GraphQLGuard {
  static readonly enforces = [Public]

  canResolve(ctx: ResolverContext): boolean {
    return Public.get(ctx) === true
  }
}
`

export const BOOK = `import type { ID, Int } from '@znight/graphql'

/** A book of the catalog. */
export interface Book {
  readonly kind: 'book'
  readonly id: ID
  readonly title: string
  readonly isbn: string
  /** Year of first publication, \`null\` when unknown. */
  readonly publishedYear: Int | null
  readonly genre: Genre
  readonly tags: readonly string[]
  readonly createdAt: Date
  /** @deprecated Use \`tags\`. */
  readonly category?: string
  /** @gqlHidden Exposed as \`author\` by BookResolver. */
  readonly authorId: ID
}

/** Literary genres. */
export enum Genre {
  Fantasy = 'fantasy',
  ScienceFiction = 'science-fiction',
  Mystery = 'mystery',
}

export interface Author {
  readonly kind: 'author'
  readonly id: ID
  readonly name: string
  readonly born: Int | null
}

/** A page of results. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: Int
  readonly hasMore: boolean
}

/** Sort orders of the book list. */
export type BookSort = 'title' | 'newest'

/** A search hit: told apart at runtime by \`kind\`, found by the compiler. */
export type SearchResult = Book | Author
`

export const BOOK_ARGS = `import type { Int } from '@znight/graphql'
import type { BookSort, Genre } from './book.ts'

/** Criteria of \`Query.books\`: each property becomes an argument. */
export interface BookFilter {
  /** Case-insensitive search in titles. */
  readonly search?: string
  readonly genre?: Genre
  /** @default "title" */
  readonly sort?: BookSort
  /** @default 20 */
  readonly limit?: Int
  /** @default 0 */
  readonly offset?: Int
}
`

export const BOOK_INPUTS = `import type { Int, StandardSchemaV1 } from '@znight/graphql'
import type { Genre } from './book.ts'

/** A new book. The interface is the GraphQL input type, the schema of the same name validates it. */
export interface NewBookInput {
  readonly title: string
  readonly isbn: string
  readonly authorId: string
  readonly genre: Genre
  readonly publishedYear?: Int | null | undefined
  readonly tags?: readonly string[] | undefined
}

export const NewBookInput: StandardSchemaV1<unknown, NewBookInput> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => ({ value: value as NewBookInput }),
  },
}
`

export const CATALOG_SERVICE = `import { Injectable } from '@znight/core'
import type { ID } from '@znight/graphql'
import type { Author, Book, Page, SearchResult } from './book.ts'
import type { BookFilter } from './book.args.ts'
import type { NewBookInput } from './book.inputs.ts'

@Injectable()
export class CatalogService {
  readonly books: Book[] = []
  async list(filter: BookFilter): Promise<Page<Book>> {
    void filter
    return { items: this.books, total: this.books.length, hasMore: false }
  }
  async find(id: ID): Promise<Book | null> {
    return this.books.find(book => book.id === id) ?? null
  }
  async add(input: NewBookInput): Promise<Book> {
    void input
    return this.books[0] as Book
  }
  async search(text: string): Promise<readonly SearchResult[]> {
    void text
    return []
  }
  async authors(ids: readonly ID[]): Promise<readonly Author[]> {
    void ids
    return []
  }
}
`

export const AUTHORS_LOADER = `import { Injectable } from '@znight/core'
import type { BatchLoad, ID } from '@znight/graphql'
import type { Author } from './book.ts'
import { CatalogService } from './catalog.service.ts'

@Injectable()
export class AuthorsById implements BatchLoad<ID, Author> {
  constructor(private readonly catalog: CatalogService) {}

  async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
    return this.catalog.authors(ids)
  }
}
`

export const BOOK_RESOLVER = `import {
  Args,
  Ctx,
  type GraphQLContext,
  type ID,
  Loader,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Subscription,
} from '@znight/graphql'

import { Public, Roles } from '../auth/access.ts'
import { AuthorsById } from './authors-by-id.loader.ts'
import type { Author, Book, Genre, Page, SearchResult } from './book.ts'
import type { BookFilter } from './book.args.ts'
import { NewBookInput } from './book.inputs.ts'
import { CatalogService } from './catalog.service.ts'

@Resolver()
@Public()
export class BookResolver {
  constructor(private readonly catalog: CatalogService) {}

  /** Books of the catalog, filtered and paginated. */
  @Query()
  books(@Args() filter: BookFilter): Promise<Page<Book>> {
    return this.catalog.list(filter)
  }

  /**
   * One book.
   * @param id The id of the book.
   */
  @Query()
  book(@Args('id') id: ID): Promise<Book | null> {
    return this.catalog.find(id)
  }

  @Query()
  search(@Args('text') text: string): Promise<readonly SearchResult[]> {
    return this.catalog.search(text)
  }

  /** Adds a book to the catalog. */
  @Mutation()
  @Roles(['editor'])
  addBook(@Args('input', NewBookInput) input: NewBookInput): Promise<Book> {
    return this.catalog.add(input)
  }

  /** Who wrote the book. Batched: one repository call per execution, whatever the number of books. */
  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }

  /** Books added from now on, optionally of one genre. */
  @Subscription()
  async *bookAdded(@Args('genre') genre: Genre | undefined, @Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
    void genre
    void ctx
    yield* []
  }
}
`

/** The catalog application. */
export const CATALOG: Readonly<Record<string, string>> = {
  'src/auth/access.ts': ACCESS,
  'src/auth/access.guard.ts': ACCESS_GUARD,
  'src/catalog/book.ts': BOOK,
  'src/catalog/book.args.ts': BOOK_ARGS,
  'src/catalog/book.inputs.ts': BOOK_INPUTS,
  'src/catalog/catalog.service.ts': CATALOG_SERVICE,
  'src/catalog/authors-by-id.loader.ts': AUTHORS_LOADER,
  'src/catalog/book.resolver.ts': BOOK_RESOLVER,
}
