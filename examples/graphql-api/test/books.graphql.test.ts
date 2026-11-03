import type { TestApp } from '@znight/testing'

import { executeOperation } from '@znight/graphql/testing'

import { createTestApp, EDITOR, READER } from './support/app.js'
import { ADD_BOOK, DISPOSSESSED, dune, FELLOWSHIP, herbert } from './support/fixtures.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/*
 * Operations through the whole stack: `executeOperation()` sends a POST through `app.inject()`, so
 * the HTTP guards, the Hono adapter, GraphQL validation, the access guard, Standard Schema validation
 * and the error mapper all run as in production. Read-only tests share one application; tests that
 * add data create their own.
 */

let app: TestApp

beforeAll(async () => {
  app = await createTestApp()
})

afterAll(async () => {
  await app.close()
})

const BOOKS = /* GraphQL */ `
  query Books($genre: Genre, $sort: BookSort, $limit: Int, $offset: Int) {
    books(genre: $genre, sort: $sort, limit: $limit, offset: $offset) {
      total
      hasMore
      items { id title genre }
    }
  }
`

describe('Query.books', () => {
  it('filters by an enum, sent and answered by name', async () => {
    const res = await executeOperation(app, { query: BOOKS, variables: { genre: 'Fantasy' } })

    expect(res.status).toBe(200)
    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({
      books: {
        total: 2,
        hasMore: false,
        items: [
          { id: 'b3', title: 'A Wizard of Earthsea', genre: 'Fantasy' },
          { id: 'b5', title: 'The Hobbit', genre: 'Fantasy' },
        ],
      },
    })
  })

  it('applies the schema defaults: sorted by title, 20 per page, from the first one', async () => {
    const res = await executeOperation<{ books: { total: number; hasMore: boolean; items: { title: string }[] } }>(
      app,
      { query: '{ books { total hasMore items { title } } }' },
    )

    expect(res.data?.books.total).toBe(6)
    expect(res.data?.books.hasMore).toBe(false)
    expect(res.data?.books.items.map(book => book.title)).toEqual([
      'A Wizard of Earthsea',
      'Children of Dune',
      'Dune',
      'Murder on the Orient Express',
      'The Hobbit',
      'The Left Hand of Darkness',
    ])
  })

  it('paginates and sorts with the literal-union enum', async () => {
    const res = await executeOperation(app, { query: BOOKS, variables: { sort: 'newest', limit: 2, offset: 1 } })

    expect(res.data).toEqual({
      books: {
        total: 6,
        hasMore: true,
        items: [
          { id: 'b5', title: 'The Hobbit', genre: 'Fantasy' },
          { id: 'b4', title: 'The Left Hand of Darkness', genre: 'ScienceFiction' },
        ],
      },
    })
  })

  it('validates the whole arguments object with its schema (BAD_USER_INPUT with the issues)', async () => {
    const res = await executeOperation(app, { query: BOOKS, variables: { limit: 500, offset: -1 } })

    expect(res.status).toBe(200) // a field error: the request itself was valid
    expect(res.data).toBeNull()
    expect(res.errors?.[0]).toMatchObject({
      path: ['books'],
      extensions: {
        code: 'BAD_USER_INPUT',
        issues: [
          { path: 'limit', message: expect.any(String) },
          { path: 'offset', message: expect.any(String) },
        ],
      },
    })
  })

  it('rejects an unknown enum value before execution', async () => {
    const res = await executeOperation(app, { query: BOOKS, variables: { genre: 'fantasy' } }) // the internal value

    expect(res.status).toBe(400)
    expect(res.data).toBeUndefined()
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT')
  })
})

describe('Query.book', () => {
  it('serves properties, DateTime, deprecated fields, field resolvers and their arguments', async () => {
    const res = await executeOperation(app, {
      query: /* GraphQL */ `
        query Book($id: ID!) {
          book(id: $id) {
            title isbn publishedYear tags createdAt category
            author { name born }
            reviews(first: 1) { rating comment reviewer }
          }
        }
      `,
      variables: { id: dune.id },
    })

    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({
      book: {
        title: 'Dune',
        isbn: '9780441013593',
        publishedYear: 1965,
        tags: ['desert', 'politics'],
        createdAt: '2026-01-01T00:00:00.000Z',
        category: 'classics',
        author: { name: herbert.name, born: 1920 },
        reviews: [{ rating: 4, comment: null, reviewer: 'reader2@books.example' }], // newest first
      },
    })
  })

  it('is null for an unknown id: a nullable lookup, not an error', async () => {
    const res = await executeOperation(app, { query: '{ book(id: "b404") { title } }' })

    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({ book: null })
  })

  it('hides @gqlHidden properties', async () => {
    const res = await executeOperation(app, { query: '{ book(id: "b1") { authorId } }' })

    expect(res.status).toBe(400)
    expect(res.errors?.[0]?.message).toContain('Cannot query field "authorId" on type "Book"')
  })
})

describe('Query.search', () => {
  it('returns a union told apart by kind', async () => {
    const res = await executeOperation(app, {
      query: /* GraphQL */ `
        {
          search(text: "le") {
            __typename
            ... on Book { title }
            ... on Author { name books { title } }
          }
        }
      `,
    })

    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({
      search: [
        { __typename: 'Book', title: 'The Left Hand of Darkness' },
        {
          __typename: 'Author',
          name: 'Ursula K. Le Guin',
          books: [{ title: 'A Wizard of Earthsea' }, { title: 'The Left Hand of Darkness' }],
        },
      ],
    })
  })
})

describe('Mutation.addBook', () => {
  it('validates the input with its schema, and the resolver receives the output', async () => {
    await using app = await createTestApp()

    const res = await executeOperation(app, { query: ADD_BOOK, variables: { input: FELLOWSHIP }, headers: EDITOR })

    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({
      addBook: {
        id: 'b7',
        title: 'The Fellowship of the Ring',
        isbn: '9780547928210', // hyphens removed by the schema
        genre: 'Fantasy',
        publishedYear: 1954,
        tags: ['rings', 'quest'], // trimmed and lower-cased
        author: { name: 'J. R. R. Tolkien' },
      },
    })
  })

  it('reports every issue of an invalid input as BAD_USER_INPUT', async () => {
    const res = await executeOperation(app, {
      query: ADD_BOOK,
      variables: { input: { ...FELLOWSHIP, title: '   ', isbn: '12345' } },
      headers: EDITOR,
    })

    expect(res.data).toBeNull()
    expect(res.errors).toEqual([
      expect.objectContaining({
        message: 'Invalid input',
        path: ['addBook'],
        extensions: {
          code: 'BAD_USER_INPUT',
          issues: [
            { path: 'title', message: 'A title is required' },
            { path: 'isbn', message: 'An ISBN has 10 or 13 digits' },
          ],
        },
      }),
    ])
  })

  it('maps a duplicate ISBN to CONFLICT, and an unknown author to NOT_FOUND', async () => {
    const duplicate = await executeOperation(app, {
      query: ADD_BOOK,
      variables: { input: { ...DISPOSSESSED, isbn: dune.isbn } },
      headers: EDITOR,
    })
    const orphan = await executeOperation(app, {
      query: ADD_BOOK,
      variables: { input: { ...DISPOSSESSED, authorId: 'a404' } },
      headers: EDITOR,
    })

    expect(duplicate.errors?.[0]).toMatchObject({
      message: 'A book with the ISBN 9780441013593 is already in the catalog',
      extensions: { code: 'CONFLICT', isbn: dune.isbn },
    })
    expect(orphan.errors?.[0]).toMatchObject({ extensions: { code: 'NOT_FOUND', authorId: 'a404' } })
  })

  it('needs the editor role', async () => {
    const res = await executeOperation(app, { query: ADD_BOOK, variables: { input: DISPOSSESSED }, headers: READER })

    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN')
  })
})

describe('Mutation.addReview', () => {
  const ADD_REVIEW = /* GraphQL */ `
    mutation AddReview($input: NewReviewInput!) {
      addReview(input: $input) { id rating comment reviewer }
    }
  `

  it('parses the EmailAddress scalar (lower-cased), then shows the review first', async () => {
    await using app = await createTestApp()

    const res = await executeOperation(app, {
      query: ADD_REVIEW,
      variables: {
        input: { bookId: dune.id, rating: 5, comment: '  Fear is the mind-killer.  ', reviewer: 'Ada@Example.ORG' },
      },
      headers: READER,
    })
    const book = await executeOperation(app, { query: '{ book(id: "b1") { reviews { reviewer } } }' })

    expect(res.errors).toBeUndefined()
    expect(res.data).toEqual({
      addReview: { id: 'r5', rating: 5, comment: 'Fear is the mind-killer.', reviewer: 'ada@example.org' },
    })
    expect(book.data).toEqual({
      book: {
        reviews: [
          { reviewer: 'ada@example.org' },
          { reviewer: 'reader2@books.example' },
          { reviewer: 'reader1@books.example' },
        ],
      },
    })
  })

  it('refuses an invalid address before the resolver runs', async () => {
    const res = await executeOperation(app, {
      query: ADD_REVIEW,
      variables: { input: { bookId: dune.id, rating: 5, reviewer: 'not an address' } },
      headers: READER,
    })

    expect(res.status).toBe(400)
    expect(res.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT')
    expect(res.errors?.[0]?.message).toContain('Expected an e-mail address')
  })

  it('validates the rating with the schema, and maps an unknown book to NOT_FOUND', async () => {
    const zero = await executeOperation(app, {
      query: ADD_REVIEW,
      variables: { input: { bookId: dune.id, rating: 0, reviewer: 'ada@example.org' } },
      headers: READER,
    })
    const missing = await executeOperation(app, {
      query: ADD_REVIEW,
      variables: { input: { bookId: 'b404', rating: 3, reviewer: 'ada@example.org' } },
      headers: READER,
    })

    expect(zero.errors?.[0]?.extensions).toEqual({
      code: 'BAD_USER_INPUT',
      issues: [{ path: 'rating', message: 'From 1 to 5' }],
    })
    expect(missing.errors?.[0]).toMatchObject({
      message: 'No book b404',
      extensions: { code: 'NOT_FOUND', bookId: 'b404' },
    })
  })
})
