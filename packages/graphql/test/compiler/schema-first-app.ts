/**
 * Source files of the schema-first end-to-end application (`schema-first-e2e.test.ts`, RFC 0007):
 * a library catalog whose schema is three `.graphql` files (extensions across files, descriptions,
 * deprecations, defaults, enums, a union, interfaces, input objects, a custom scalar with
 * `@specifiedBy`, the built-in `DateTime`, a custom directive) implemented by resolvers bound by
 * name, NestJS style: root fields by method name or `@Query('name')`, type fields with
 * `@Resolver('Book')` + `@ResolveField`, a loader, a mutation validated with Zod, a subscription.
 * The TypeScript types are written the way graphql-codegen writes them (`__typename`, `Maybe<T>`).
 */

export const BASE_SDL = `"""An ISBN-13, thirteen digits."""
scalar Isbn @specifiedBy(url: "https://www.isbn-international.org/content/what-isbn")

scalar DateTime @specifiedBy(url: "https://datatracker.ietf.org/doc/html/rfc3339")

"""Marks the fields a field resolver computes (graphql-codegen leaves them out of the models)."""
directive @resolved on FIELD_DEFINITION

"""Something with an id."""
interface Node {
  id: ID!
}

type Query {
  """The book of this id."""
  book(id: ID!): Book
  node(id: ID!): Node
}

type Mutation
`

export const CATALOG_SDL = `"""A book of the catalog."""
type Book implements Node {
  id: ID!
  title: String!
  isbn: Isbn!
  genre: Genre!
  category: String @deprecated(reason: "Use \`genre\`.")
  createdAt: DateTime!
  author: Author! @resolved
}

type Author implements Node & Named {
  id: ID!
  name: String!
  "The books of the author, newest first."
  books(limit: Int = 10): [Book!]! @resolved
}

interface Named {
  name: String!
}

enum Genre {
  FANTASY
  SCIENCE_FICTION
  """Essays."""
  ESSAY @deprecated(reason: "Use NON_FICTION.")
  NON_FICTION
}

union SearchResult = Book | Author

input BookFilter {
  genre: Genre
  search: String
  limit: Int = 10
}

input NewBook {
  title: String!
  isbn: Isbn!
  genre: Genre! = FANTASY
  authorId: ID!
}

extend type Query {
  books(filter: BookFilter = { limit: 5 }): [Book!]!
  search(text: String!): [SearchResult!]!
}

extend type Mutation {
  addBook(input: NewBook!): Book!
}
`

export const EVENTS_SDL = `type Subscription {
  """Books added from now on, optionally of one genre."""
  bookAdded(genre: Genre): Book!
}
`

const ISBN = `import { scalar } from '@znight/graphql'

export type Isbn = string & { readonly __brand: 'Isbn' }

export const IsbnScalar = scalar<Isbn>('Isbn', {
  serialize: value => value as Isbn,
  parseValue: value => {
    if (typeof value !== 'string' || !/^[0-9]{13}$/.test(value)) throw new TypeError('An ISBN has 13 digits')
    return value as Isbn
  },
})
`

/** What graphql-codegen's \`typescript\` plugin generates, models without the @resolved fields. */
const TYPES = `import type { Isbn } from './isbn.ts'

export type Maybe<T> = T | null
export type InputMaybe<T> = Maybe<T>

export enum Genre {
  ESSAY = 'ESSAY',
  FANTASY = 'FANTASY',
  NON_FICTION = 'NON_FICTION',
  SCIENCE_FICTION = 'SCIENCE_FICTION',
}

export type Book = {
  __typename: 'Book'
  id: string
  title: string
  isbn: Isbn
  genre: Genre
  category?: Maybe<string>
  createdAt: Date
  authorId: string
}

export type Author = {
  __typename: 'Author'
  id: string
  name: string
}

export type SearchResult = Book | Author

export type BookFilter = {
  genre?: InputMaybe<Genre>
  search?: InputMaybe<string>
  limit?: InputMaybe<number>
}

export type NewBook = {
  title: string
  isbn: Isbn
  genre: Genre
  authorId: string
}

export interface CatalogEvents {
  bookAdded: Book
}
`

const STORE = `import { Injectable } from '@znight/core'
import { Genre, type Author, type Book } from './types.ts'
import type { Isbn } from './isbn.ts'

@Injectable()
export class CatalogStore {
  readonly authors: Author[] = [
    { __typename: 'Author', id: 'a1', name: 'Frank Herbert' },
    { __typename: 'Author', id: 'a2', name: 'Ursula K. Le Guin' },
  ]
  readonly books: Book[] = [
    { __typename: 'Book', id: 'b1', title: 'Dune', isbn: '9780441172719' as Isbn, genre: Genre.SCIENCE_FICTION, category: 'classics', createdAt: new Date('2024-01-01T00:00:00.000Z'), authorId: 'a1' },
    { __typename: 'Book', id: 'b2', title: 'A Wizard of Earthsea', isbn: '9780547773742' as Isbn, genre: Genre.FANTASY, createdAt: new Date('2024-01-02T00:00:00.000Z'), authorId: 'a2' },
    { __typename: 'Book', id: 'b3', title: 'Children of Dune', isbn: '9780593098240' as Isbn, genre: Genre.SCIENCE_FICTION, createdAt: new Date('2024-01-03T00:00:00.000Z'), authorId: 'a1' },
  ]
  readonly authorBatches: (readonly string[])[] = []
}
`

const AUTHORS = `import { Injectable } from '@znight/core'
import { type BatchLoad, orderByKeys } from '@znight/graphql'
import { CatalogStore } from './catalog.store.ts'
import type { Author } from './types.ts'

@Injectable()
export class AuthorsById implements BatchLoad<string, Author> {
  constructor(private readonly store: CatalogStore) {}

  async load(ids: readonly string[]): Promise<readonly (Author | Error)[]> {
    this.store.authorBatches.push([...ids])
    return orderByKeys(ids, this.store.authors.filter(author => ids.includes(author.id)), author => author.id)
  }
}
`

const INPUTS = `import { z } from 'zod'
import { Genre, type NewBook } from './types.ts'
import type { Isbn } from './isbn.ts'

export const NewBookSchema = z.object({
  title: z.string().trim().min(1),
  isbn: z.string().transform(value => value as Isbn),
  genre: z.enum(Genre),
  authorId: z.string(),
}) satisfies z.ZodType<NewBook>
`

const CATALOG_RESOLVER = `import { Args, Ctx, type GraphQLContext, Mutation, PubSub, Query, Resolver, Subscription } from '@znight/graphql'

import { CatalogStore } from './catalog.store.ts'
import { NewBookSchema } from './inputs.ts'
import type { Author, Book, BookFilter, CatalogEvents, Genre, NewBook, SearchResult } from './types.ts'

@Resolver()
export class CatalogResolver {
  constructor(
    private readonly store: CatalogStore,
    private readonly events: PubSub<CatalogEvents>,
  ) {}

  @Query()
  book(@Args('id') id: string): Book | undefined {
    return this.store.books.find(book => book.id === id)
  }

  @Query()
  node(@Args('id') id: string): Book | Author | null {
    return this.store.books.find(book => book.id === id) ?? this.store.authors.find(author => author.id === id) ?? null
  }

  @Query()
  books(@Args('filter') filter: BookFilter | null | undefined): readonly Book[] {
    const search = filter?.search?.toLowerCase()
    return this.store.books
      .filter(book => search == null || book.title.toLowerCase().includes(search))
      .filter(book => filter?.genre == null || book.genre === filter.genre)
      .slice(0, filter?.limit ?? 10)
  }

  @Query('search')
  find(@Args('text') text: string): SearchResult[] {
    const needle = text.toLowerCase()
    return [
      ...this.store.books.filter(book => book.title.toLowerCase().includes(needle)),
      ...this.store.authors.filter(author => author.name.toLowerCase().includes(needle)),
    ]
  }

  @Mutation()
  async addBook(@Args('input', NewBookSchema) input: NewBook): Promise<Book> {
    const book: Book = {
      __typename: 'Book',
      id: \`b\${this.store.books.length + 1}\`,
      title: input.title,
      isbn: input.isbn,
      genre: input.genre,
      createdAt: new Date('2024-02-01T00:00:00.000Z'),
      authorId: input.authorId,
    }
    this.store.books.push(book)
    await this.events.publish('bookAdded', book)
    return book
  }

  @Subscription()
  async *bookAdded(@Args('genre') genre: Genre | null | undefined, @Ctx() ctx: GraphQLContext): AsyncGenerator<Book> {
    for await (const book of this.events.subscribe('bookAdded', { signal: ctx.signal })) {
      if (genre == null || book.genre === genre) yield book
    }
  }
}
`

const FIELD_RESOLVERS = `import { Args, Loader, Parent, ResolveField, Resolver } from '@znight/graphql'

import { AuthorsById } from './authors-by-id.loader.ts'
import { CatalogStore } from './catalog.store.ts'
import type { Author, Book } from './types.ts'

@Resolver('Book')
export class BookFieldResolver {
  @ResolveField()
  author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
    return authors.load(book.authorId)
  }
}

@Resolver('Author')
export class AuthorFieldResolver {
  constructor(private readonly store: CatalogStore) {}

  @ResolveField('books')
  booksOf(@Parent() author: Author, @Args('limit') limit: number | null | undefined): Book[] {
    return this.store.books
      .filter(book => book.authorId === author.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit ?? 10)
  }
}
`

/** The files of the application. */
export const SCHEMA_FIRST_APP: Readonly<Record<string, string>> = {
  'src/schema/base.graphql': BASE_SDL,
  'src/catalog/catalog.graphql': CATALOG_SDL,
  'src/catalog/events.graphql': EVENTS_SDL,
  'src/catalog/isbn.ts': ISBN,
  'src/catalog/types.ts': TYPES,
  'src/catalog/catalog.store.ts': STORE,
  'src/catalog/authors-by-id.loader.ts': AUTHORS,
  'src/catalog/inputs.ts': INPUTS,
  'src/catalog/catalog.resolver.ts': CATALOG_RESOLVER,
  'src/catalog/field.resolvers.ts': FIELD_RESOLVERS,
}
