import type { Principal } from '../src/auth/principal.js'
import type { Book } from '../src/catalog/book.js'
import type { ReviewsByBook } from '../src/reviews/reviews-by-book.loader.js'
import type { EmailAddress } from '../src/shared/scalars.js'

import { GraphQLException, PubSub } from '@znight/graphql'
import { fakeLoader } from '@znight/graphql/testing'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { CurrentUser } from '../src/auth/current-user.js'
import { ViewerResolver } from '../src/auth/viewer.resolver.js'
import { AuthorRepository } from '../src/catalog/author.repository.js'
import { AuthorsById } from '../src/catalog/authors-by-id.loader.js'
import { Genre } from '../src/catalog/book.js'
import { BookResolver } from '../src/catalog/book.resolver.js'
import { CatalogService } from '../src/catalog/catalog.service.js'
import { BookNotFoundError, DuplicateIsbnError } from '../src/catalog/errors.js'
import { ReviewResolver } from '../src/reviews/review.resolver.js'
import { CatalogErrorMapper } from '../src/shared/catalog-error.mapper.js'
import { dune, duneReviews, earthsea, herbert, tolkien } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/*
 * Resolvers are providers: TestBed builds one with its generated factory and auto-mocks its direct
 * dependencies (the PubSub included). Loaders are plain parameters: fakeLoader() stands for the
 * DataLoader of an execution. No schema, no HTTP: these are unit tests.
 */

const editor: Principal = { name: 'editor', email: 'editor@books.example' as EmailAddress, roles: ['editor'] }

function signedIn(principal: Principal): CurrentUser {
  const user = new CurrentUser()
  user.authenticate(principal)
  return user
}

async function* events<T>(...values: readonly T[]): AsyncGenerator<T> {
  yield* values
}

describe('BookResolver', () => {
  it('book() returns what the catalog finds', async () => {
    const { instance, mocks } = await TestBed.create(BookResolver, { metadata })
    mocks.get(CatalogService).find.mockResolvedValue(dune)

    expect(await instance.book(dune.id)).toBe(dune)
    expect(mocks.get(CatalogService).find).toHaveBeenCalledWith(dune.id)
  })

  it('author() goes through the loader of the execution', async () => {
    const { instance } = await TestBed.create(BookResolver, { metadata })
    const authors = fakeLoader<AuthorsById>({ [herbert.id]: herbert })

    expect(await instance.author(dune, authors)).toBe(herbert)
    expect(authors.load).toHaveBeenCalledWith(herbert.id)
  })

  it('addBook() adds as the caller, then publishes bookAdded', async () => {
    const { instance, mocks } = await TestBed.create(BookResolver, {
      metadata,
      provide: [[CurrentUser, signedIn(editor)]],
    })
    mocks.get(CatalogService).add.mockResolvedValue(dune)
    const input = { title: dune.title, isbn: dune.isbn, authorId: herbert.id, genre: Genre.ScienceFiction }

    expect(await instance.addBook(input)).toBe(dune)
    expect(mocks.get(CatalogService).add).toHaveBeenCalledWith(input, 'editor')
    expect(mocks.get(PubSub).publish).toHaveBeenCalledWith('bookAdded', dune)
  })

  it('bookAdded() filters the events by genre, and subscribes with the signal of the operation', async () => {
    const { instance, mocks } = await TestBed.create(BookResolver, { metadata })
    mocks.get(PubSub).subscribe.mockReturnValue(events<Book>(dune, earthsea))
    const signal = new AbortController().signal
    const ctx = { signal } as Parameters<BookResolver['bookAdded']>[1]

    const received: Book[] = []
    for await (const book of instance.bookAdded(Genre.Fantasy, ctx)) received.push(book)

    expect(received).toEqual([earthsea])
    expect(mocks.get(PubSub).subscribe).toHaveBeenCalledWith('bookAdded', { signal })
  })
})

describe('ReviewResolver', () => {
  it('reviews() slices what the loader returns, 5 by default', async () => {
    const { instance } = await TestBed.create(ReviewResolver, { metadata })
    const reviews = fakeLoader<ReviewsByBook>({ [dune.id]: duneReviews })

    expect(await instance.reviews(dune, { first: 1 }, reviews)).toEqual(duneReviews.slice(0, 1))
    expect(await instance.reviews(dune, {}, reviews)).toEqual(duneReviews)
    expect(await instance.reviews(dune, { first: 1_000 }, reviews)).toEqual(duneReviews) // at most 50
    expect(reviews.load).toHaveBeenCalledTimes(3)
  })
})

describe('ViewerResolver', () => {
  it('me() is the caller of the request', async () => {
    const { instance } = await TestBed.create(ViewerResolver, { metadata, provide: [[CurrentUser, signedIn(editor)]] })

    expect(instance.me()).toEqual({ name: 'editor', email: 'editor@books.example' as EmailAddress, roles: ['editor'] })
  })
})

describe('AuthorsById', () => {
  it('answers one value per key, in the order of the keys, and NOT_FOUND for a missing one', async () => {
    const { instance, mocks } = await TestBed.create(AuthorsById, { metadata })
    mocks.get(AuthorRepository).findMany.mockResolvedValue([tolkien, herbert]) // any order

    const [first, second, third] = await instance.load([herbert.id, tolkien.id, 'a404'])

    expect([first, second]).toEqual([herbert, tolkien])
    expect(third).toBeInstanceOf(GraphQLException)
    expect((third as GraphQLException).code).toBe('NOT_FOUND')
    expect(mocks.get(AuthorRepository).findMany).toHaveBeenCalledTimes(1)
  })
})

describe('CatalogErrorMapper', () => {
  const mapper = new CatalogErrorMapper()

  it('maps domain errors to GraphQL codes', () => {
    expect(mapper.map(new DuplicateIsbnError(dune.isbn))).toMatchObject({
      code: 'CONFLICT',
      extensions: { isbn: dune.isbn },
    })
    expect(mapper.map(new BookNotFoundError('b404'))).toMatchObject({
      code: 'NOT_FOUND',
      extensions: { bookId: 'b404' },
    })
  })

  it('leaves other errors to the next mapper (then masking)', () => {
    expect(mapper.map(new Error('connection reset'))).toBeUndefined()
  })
})
