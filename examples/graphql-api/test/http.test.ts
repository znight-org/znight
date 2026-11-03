import type { TestApp } from '@znight/testing'

import { executeOperation } from '@znight/graphql/testing'

import { createTestApp, EDITOR } from './support/app.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/*
 * GraphQL over HTTP on this application: the endpoint is a route of HttpPlugin (here on Hono), next
 * to the REST controllers. Requests go through `app.inject()`, the whole pipeline without a socket.
 */

const JSON_TYPE = 'application/json; charset=utf-8'
const GRAPHQL_JSON = 'application/graphql-response+json; charset=utf-8'

let app: TestApp

beforeAll(async () => {
  app = await createTestApp()
})

afterAll(async () => {
  await app.close()
})

/** Runs `create` with `NODE_ENV` set: the GraphQL defaults (introspection, GraphiQL) follow it. */
async function withNodeEnv<T>(value: string, create: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = value
  try {
    return await create()
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
}

/** `{ book(id: "b1") { author { books { author { books { title } } } } } }`: `book`, then `pairs` × 2 levels. */
function deepQuery(pairs: number): string {
  let selection = 'title'
  for (let pair = 0; pair < pairs; pair++) selection = `author { books { ${selection} } }`
  return `{ book(id: "b1") { ${selection} } }`
}

describe('GET', () => {
  it('runs queries from the query string', async () => {
    const res = await app.inject({
      url: '/graphql',
      query: { query: 'query Book($id: ID!) { book(id: $id) { title } }', variables: '{"id":"b1"}' },
    })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe(JSON_TYPE)
    expect(res.json()).toEqual({ data: { book: { title: 'Dune' } } })
  })

  it('refuses mutations: 405, POST only (a link or an image must not change data)', async () => {
    const res = await app.inject({
      url: '/graphql',
      query: { query: 'mutation { addReview(input: { bookId: "b1", rating: 5, reviewer: "a@b.co" }) { id } }' },
      headers: EDITOR,
    })

    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })
})

describe('POST', () => {
  it('accepts JSON only: a form is 415, so cross-site requests are always preflighted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'query=%7B%20books%20%7B%20total%20%7D%20%7D',
    })

    expect(res.status).toBe(415)
  })

  it('answers request errors 400 in application/graphql-response+json, 200 in application/json', async () => {
    const invalid = { query: '{ books { nope } }' }
    const modern = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json' },
      body: invalid,
    })
    const legacy = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: invalid,
    })

    expect([modern.status, modern.headers['content-type']]).toEqual([400, GRAPHQL_JSON])
    expect([legacy.status, legacy.headers['content-type']]).toEqual([200, JSON_TYPE])
    expect(legacy.json<{ errors: { extensions: { code: string } }[] }>().errors[0]?.extensions.code).toBe(
      'GRAPHQL_VALIDATION_FAILED',
    )
  })

  it('refuses batches: one operation per request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      body: [{ query: '{ books { total } }' }, { query: '{ books { total } }' }],
    })

    expect(res.status).toBe(400)
  })
})

describe('limits', () => {
  it('rejects documents deeper than 12 levels before validating them', async () => {
    expect((await executeOperation(app, { query: deepQuery(5) })).errors).toBeUndefined() // 12 levels

    const res = await executeOperation(app, { query: deepQuery(6) }) // 14 levels

    expect(res.status).toBe(400)
    expect(res.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX')
  })

  it('rejects more than 30 aliases', async () => {
    const aliases = Array.from({ length: 31 }, (_, index) => `b${index}: books { total }`).join(' ')

    const res = await executeOperation(app, { query: `{ ${aliases} }` })

    expect(res.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX')
  })

  it('rejects bodies over 100 KiB with 413', async () => {
    const res = await executeOperation(app, { query: `{ books { total } } # ${'x'.repeat(110_000)}` })

    expect(res.status).toBe(413)
  })
})

describe('defaults by environment', () => {
  it('serves introspection out of production', async () => {
    const res = await executeOperation(app, { query: '{ __schema { queryType { name } } }' })

    expect(res.data).toEqual({ __schema: { queryType: { name: 'Query' } } })
  })

  it('turns introspection off with NODE_ENV=production, and hides field suggestions', async () => {
    await using production = await withNodeEnv('production', () => createTestApp())

    const introspection = await executeOperation(production, { query: '{ __schema { queryType { name } } }' })
    const typo = await executeOperation(production, { query: '{ book(id: "b1") { titel } }' })

    expect(introspection.status).toBe(400)
    expect(introspection.errors?.[0]?.message).toContain('introspection')
    expect(typo.errors?.[0]?.message).not.toContain('Did you mean')
    expect((await executeOperation(app, { query: '{ book(id: "b1") { titel } }' })).errors?.[0]?.message).toContain(
      'Did you mean "title"?',
    )
  })

  it('serves GraphiQL to browsers with NODE_ENV=development only', async () => {
    await using development = await withNodeEnv('development', () => createTestApp())
    const browser = { url: '/graphql', headers: { accept: 'text/html' } }

    const page = await development.inject(browser)

    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toStartWith('text/html')
    expect((await app.inject(browser)).status).not.toBe(200)
  })
})

describe('REST next to GraphQL', () => {
  it('serves GET /health from a controller, through the same guards', async () => {
    const res = await app.inject({ url: '/health' })

    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', subscriptions: 0 })
  })
})
