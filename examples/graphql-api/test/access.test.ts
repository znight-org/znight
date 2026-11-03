import type { TestApp } from '@znight/testing'

import { executeOperation, subscribeOperation } from '@znight/graphql/testing'

import { createTestApp, EDITOR, READER } from './support/app.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** A root field and an operation selecting it. */
interface Entry {
  readonly field: string
  readonly operation: 'query' | 'mutation' | 'subscription'
  /** The operation; `n` makes the variables of a mutation unique per call. */
  readonly query: string
  readonly variables?: (n: number) => Record<string, unknown>
}

/** Every root field of the schema, once. */
const ENTRIES: readonly Entry[] = [
  { field: 'Query.books', operation: 'query', query: '{ books { total } }' },
  { field: 'Query.book', operation: 'query', query: '{ book(id: "b1") { title } }' },
  { field: 'Query.search', operation: 'query', query: '{ search(text: "dune") { __typename } }' },
  { field: 'Query.me', operation: 'query', query: '{ me { name } }' },
  {
    field: 'Mutation.addBook',
    operation: 'mutation',
    query: 'mutation Add($input: NewBookInput!) { addBook(input: $input) { id } }',
    variables: n => ({
      input: { title: `Book ${n}`, isbn: String(9_780_000_000_000 + n), authorId: 'a1', genre: 'Mystery' },
    }),
  },
  {
    field: 'Mutation.addReview',
    operation: 'mutation',
    query: 'mutation Add($input: NewReviewInput!) { addReview(input: $input) { id } }',
    variables: () => ({ input: { bookId: 'b1', rating: 4, reviewer: 'ada@example.org' } }),
  },
  { field: 'Subscription.bookAdded', operation: 'subscription', query: 'subscription { bookAdded { id } }' },
  {
    field: 'Subscription.reviewAdded',
    operation: 'subscription',
    query: 'subscription { reviewAdded(bookId: "b1") { id } }',
  },
]

const CALLERS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['anonymous', {}],
  ['reader', READER],
  ['editor', EDITOR],
]

let app: TestApp
let calls = 0

beforeAll(async () => {
  app = await createTestApp()
})

afterAll(async () => {
  await app.close()
})

/** `ok`, or the code of the error of the field. */
async function outcome(entry: Entry, headers: Readonly<Record<string, string>>): Promise<string> {
  const request = { query: entry.query, variables: entry.variables?.(++calls) ?? {}, headers }
  if (entry.operation !== 'subscription') {
    const res = await executeOperation(app, request)
    return String(res.errors?.[0]?.extensions?.code ?? (res.status === 200 ? 'ok' : `HTTP ${res.status}`))
  }
  // a denied subscription answers one result with the error; an allowed one waits for events
  await using stream = await subscribeOperation(app, request)
  try {
    const first = await stream.next({ timeoutMs: 100 })
    return String(first.value?.errors?.[0]?.extensions?.code ?? 'unexpected event')
  } catch {
    return 'ok (streaming)'
  }
}

describe('access', () => {
  /**
   * Who can call which root field, through the whole stack (HTTP guards, then `AccessGuard` per
   * field). A pull request that changes access changes the snapshot (`bun test -u` once reviewed).
   */
  it('access matrix of every root field', async () => {
    const matrix: string[] = []
    for (const entry of ENTRIES) {
      const outcomes: string[] = []
      for (const [caller, headers] of CALLERS) outcomes.push(`${caller}: ${await outcome(entry, headers)}`)
      matrix.push(`${entry.field} → ${outcomes.join(', ')}`)
    }

    expect(matrix).toMatchSnapshot()
  })

  it('denies a field, not the request: one error with its path, standard null propagation', async () => {
    const nullable = await executeOperation(app, { query: '{ me { name } }' })
    const denied = await executeOperation(app, {
      query:
        'mutation { addBook(input: { title: "T", isbn: "9780000000000", authorId: "a1", genre: Mystery }) { id } }',
      headers: READER,
    })

    expect(nullable.status).toBe(200)
    // `me` is non-null (`Viewer!`): its error nulls its parent, here `data`
    expect(nullable.data).toBeNull()
    expect(nullable.errors).toEqual([
      expect.objectContaining({
        message: 'Authentication required',
        path: ['me'],
        extensions: { code: 'UNAUTHENTICATED' },
      }),
    ])
    expect(denied.errors).toEqual([
      expect.objectContaining({
        message: 'Not allowed to resolve Mutation.addBook',
        path: ['addBook'],
        extensions: { code: 'FORBIDDEN' },
      }),
    ])
  })

  it('answers a wrong API key with a 401 on the HTTP request, before any field runs', async () => {
    const res = await executeOperation(app, { query: '{ books { total } }', headers: { 'x-api-key': 'wrong' } })

    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toBe('ApiKey header="x-api-key"')
    expect(res.data).toBeUndefined()
  })

  it('needs no decision on field resolvers: they are covered by their root field', async () => {
    const res = await executeOperation(app, { query: '{ book(id: "b1") { author { name } reviews { rating } } }' })

    expect(res.errors).toBeUndefined()
  })
})
