/**
 * GraphQL over HTTP (RFC 0005 §8.3): statuses, media types, CSRF safety, GET rules, body limit and
 * GraphiQL, in memory through `HttpPlugin.inject()` (the adapter matrix runs in
 * `transport-runtime.test.ts`).
 */
import type { InjectRequest, InjectResponse } from '@znight/http'
import type { LibraryApp } from './support/library.ts'

import { createRouteDecorator } from '@znight/http'

import { GRAPHIQL_ASSETS } from '../src/transport/graphiql.ts'
import { observed, startLibrary } from './support/library.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const Public = createRouteDecorator('public')

const JSON_TYPE = 'application/json; charset=utf-8'
const GRAPHQL_JSON = 'application/graphql-response+json; charset=utf-8'

let library: LibraryApp

beforeAll(async () => {
  library = await startLibrary()
})

afterAll(async () => {
  await library.stop()
})

function post(body: unknown, headers: Record<string, string> = {}): Promise<InjectResponse> {
  return library.http.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function get(query: Record<string, string>, headers: Record<string, string> = {}): Promise<InjectResponse> {
  return library.http.inject({ method: 'GET', url: '/graphql', query, headers })
}

describe('POST', () => {
  it('executes a query: 200 application/json without accept header', async () => {
    const res = await post({ query: '{ hello }' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe(JSON_TYPE)
    expect(res.json()).toEqual({ data: { hello: 'Hello world' } })
  })

  it('answers application/graphql-response+json when the client lists it', async () => {
    const res = await post(
      { query: 'query Q($name: String) { hello(name: $name) }', variables: { name: 'Ada' }, operationName: 'Q' },
      { accept: 'application/graphql-response+json, application/json;q=0.9' },
    )
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe(GRAPHQL_JSON)
    expect(res.json()).toEqual({ data: { hello: 'Hello Ada' } })
  })

  it('executes mutations', async () => {
    const res = await post({ query: 'mutation { addBook(title: "Emma") { title } }' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ data: { addBook: { title: 'Emma' } } })
  })

  it('answers request errors with 200 in application/json and 400 in application/graphql-response+json', async () => {
    const cases = [
      { query: '{ hello' }, // parse
      { query: '{ nope }' }, // validation
      { query: 'query Q($n: String!) { hello(name: $n) }', variables: {} }, // variable coercion
      { query: 'query A { hello } query B { hello }' }, // operation selection
      { query: 'subscription { countdown(from: 1) }' }, // a subscription without SSE
      { query: '' },
    ]
    for (const body of cases) {
      const json = await post(body, { accept: 'application/json' })
      expect({ body, status: json.status }).toEqual({ body, status: 200 })
      expect(json.headers['content-type']).toBe(JSON_TYPE)
      expect(json.json<{ errors: unknown[] }>().errors.length).toBeGreaterThan(0)
      expect(json.json()).not.toHaveProperty('data')
      const graphql = await post(body, { accept: 'application/graphql-response+json' })
      expect({ body, status: graphql.status }).toEqual({ body, status: 400 })
      expect(graphql.headers['content-type']).toBe(GRAPHQL_JSON)
    }
    const hint = await post({ query: 'subscription { countdown(from: 1) }' })
    expect(hint.json<{ errors: { message: string }[] }>().errors[0]?.message).toContain('text/event-stream')
  })

  it('answers field errors with 200 and data in every media type', async () => {
    for (const accept of ['application/json', 'application/graphql-response+json']) {
      const res = await post({ query: '{ hello fail }' }, { accept })
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({
        data: { hello: 'Hello world', fail: null },
        errors: [
          {
            message: 'Unexpected error.',
            locations: [{ line: 1, column: 9 }],
            path: ['fail'],
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      })
    }
  })

  it('rejects malformed requests with 400 and a GraphQL error body', async () => {
    const cases: [body: string, message: string][] = [
      ['', 'Missing request body'],
      ['{ "not json', 'Malformed JSON body'],
      ['"query"', 'The body must be a JSON object'],
      ['null', 'The body must be a JSON object'],
      ['[{"query":"{ hello }"}]', 'Operation batching is not supported'],
      ['{"qeury":"{ hello }"}', 'Missing query'],
      ['{"query":1}', 'The query must be a string'],
      ['{"query":"{ hello }","operationName":1}', 'operationName must be a string'],
      ['{"query":"{ hello }","variables":"{}"}', 'variables must be an object'],
      ['{"query":"{ hello }","variables":[]}', 'variables must be an object'],
      ['{"query":"{ hello }","extensions":1}', 'extensions must be an object'],
    ]
    for (const accept of ['application/json', 'application/graphql-response+json']) {
      for (const [body, message] of cases) {
        const res = await post(body, { accept })
        expect({ body, status: res.status }).toEqual({ body, status: 400 })
        expect(res.headers['content-type']).toBe(accept === 'application/json' ? JSON_TYPE : GRAPHQL_JSON)
        expect(res.json<{ errors: { message: string; extensions: unknown }[] }>().errors).toEqual([
          { message: expect.stringContaining(message), extensions: { code: 'BAD_REQUEST' } },
        ])
      }
    }
  })

  it('accepts null parameters and maps', async () => {
    const res = await post({ query: '{ hello }', variables: null, operationName: null, extensions: null })
    expect(res.json()).toEqual({ data: { hello: 'Hello world' } })
    const maps = await post({ query: '{ hello }', variables: {}, extensions: { persistedQuery: null } })
    expect(maps.json()).toEqual({ data: { hello: 'Hello world' } })
  })

  it('only accepts application/json bodies (415, CSRF safety)', async () => {
    const cases: (string | undefined)[] = [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/graphql',
      'application/json; charset=latin1',
      undefined,
    ]
    for (const contentType of cases) {
      const request: InjectRequest = {
        method: 'POST',
        url: '/graphql',
        headers: contentType === undefined ? {} : { 'content-type': contentType },
        body: new TextEncoder().encode('{"query":"mutation { addBook(title: \\"CSRF\\") { title } }"}'),
      }
      const res = await library.http.inject(request)
      expect({ contentType, status: res.status }).toEqual({ contentType, status: 415 })
      expect(res.json<{ errors: { message: string }[] }>().errors[0]?.message).toContain('application/json')
    }
    expect(
      (await post({ query: '{ books { title } }' })).json<{ data: { books: unknown[] } }>().data.books,
    ).not.toEqual(expect.arrayContaining([{ title: 'CSRF' }]))
    const charset = await post({ query: '{ hello }' }, { 'content-type': 'Application/JSON; Charset="UTF-8"' })
    expect(charset.status).toBe(200)
    const gzip = await post({ query: '{ hello }' }, { 'content-encoding': 'gzip' })
    expect(gzip.status).toBe(415)
  })

  it('answers 406 when nothing acceptable can be produced', async () => {
    for (const accept of ['text/html', 'image/png', 'application/json;q=0, */*;q=0.5', 'application/xml']) {
      const res = await post({ query: '{ hello }' }, { accept })
      expect({ accept, status: res.status }).toEqual({ accept, status: 406 })
      expect(res.headers['content-type']).toBe(JSON_TYPE)
    }
    for (const accept of ['*/*', 'application/*', 'text/html, */*;q=0.1', 'application/json;charset=utf-8']) {
      const res = await post({ query: '{ hello }' }, { accept })
      expect({ accept, status: res.status, type: res.headers['content-type'] }).toEqual({
        accept,
        status: 200,
        type: JSON_TYPE,
      })
    }
  })

  it('answers 413 with a GraphQL error past the body limit (100 KiB by default)', async () => {
    const big = JSON.stringify({ query: `{ hello(name: "${'x'.repeat(110_000)}") }` })
    const res = await post(big, { accept: 'application/graphql-response+json' })
    expect(res.status).toBe(413)
    expect(res.headers['content-type']).toBe(GRAPHQL_JSON)
    expect(res.json<{ errors: { message: string }[] }>().errors[0]).toMatchObject({
      extensions: { code: 'BAD_REQUEST' },
    })
    const fits = JSON.stringify({ query: `{ hello(name: "${'x'.repeat(90_000)}") }` })
    expect((await post(fits)).status).toBe(200)
  })

  it('stops an asynchronous query whose client went away (a real socket)', async () => {
    await using app = await startLibrary()
    const abort = new AbortController()
    observed.aborts.length = 0
    const pending = fetch(app.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ slow(ms: 5000) }' }),
      signal: abort.signal,
    }).catch(() => undefined)
    for (let attempt = 0; attempt < 100 && app.http.inflight === 0; attempt++) await Bun.sleep(5)
    abort.abort()
    await pending
    for (let attempt = 0; attempt < 200 && observed.aborts.length === 0; attempt++) await Bun.sleep(5)
    expect(observed.aborts).toEqual(['client'])
    for (let attempt = 0; attempt < 200 && app.http.inflight > 0; attempt++) await Bun.sleep(5)
    expect(app.http.inflight).toBe(0)
    // an asynchronous query that completes is answered normally
    const res = await fetch(app.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ slow(ms: 1) }' }),
    })
    expect(await res.json()).toEqual({ data: { slow: 'slow' } })
  })
})

describe('GET', () => {
  it('executes queries from the query string', async () => {
    const res = await get({
      query: 'query Q($name: String) { hello(name: $name) }',
      variables: '{"name":"Ada"}',
      operationName: 'Q',
      extensions: '{}',
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe(JSON_TYPE)
    expect(res.json()).toEqual({ data: { hello: 'Hello Ada' } })
    const graphql = await get({ query: '{ hello }' }, { accept: 'application/graphql-response+json' })
    expect(graphql.headers['content-type']).toBe(GRAPHQL_JSON)
    expect(graphql.json()).toEqual({ data: { hello: 'Hello world' } })
  })

  it('refuses mutations and subscriptions with 405 and allow: POST', async () => {
    for (const query of ['mutation { addBook(title: "GET") { title } }', 'subscription { countdown(from: 1) }']) {
      for (const accept of ['application/json', 'application/graphql-response+json']) {
        const res = await get({ query }, { accept })
        expect(res.status).toBe(405)
        expect(res.headers['allow']).toBe('POST')
        expect(res.json<{ errors: unknown[] }>().errors).toHaveLength(1)
      }
    }
  })

  it('answers request errors like POST', async () => {
    expect((await get({ query: '{ nope }' })).status).toBe(200)
    expect((await get({ query: '{ nope }' }, { accept: 'application/graphql-response+json' })).status).toBe(400)
    const missing = await get({})
    expect(missing.status).toBe(400)
    expect(missing.json<{ errors: { message: string }[] }>().errors[0]?.message).toContain('Missing query')
    expect((await get({ query: '{ hello }', variables: '{oops' })).status).toBe(400)
    expect((await get({ query: '{ hello }', variables: '[1]' })).status).toBe(400)
    const repeated = await library.http.inject({ method: 'GET', url: '/graphql?query=a&query=b' })
    expect(repeated.status).toBe(400)
  })

  it('answers HEAD like GET without a body', async () => {
    const res = await library.http.inject({ method: 'HEAD', url: '/graphql?query=%7B%20hello%20%7D' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
  })
})

describe('options', () => {
  it('http.get: false answers GET with 405', async () => {
    await using app = await startLibrary({ graphql: { http: { get: false } } })
    const res = await app.http.inject({ method: 'GET', url: '/graphql?query={hello}' })
    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('POST, OPTIONS')
    expect(app.http.routes.map(route => `${route.method} ${route.path} ${route.handler}`)).toEqual([
      'POST /graphql handle',
    ])
  })

  it('serves the endpoint on path, under the HttpPlugin prefix, with meta, guards and bodyLimit', async () => {
    let checked = 0
    const guard = {
      canActivate: (ctx: { route?: { meta: Readonly<Record<string, unknown>> } }) => {
        checked++
        return Public.get(ctx as never) === true
      },
    }
    await using app = await startLibrary({
      http: { prefix: '/api' },
      graphql: { path: '/gql', http: { meta: [Public.meta()], guards: [guard], bodyLimit: '1kb' } },
    })
    expect(app.http.routes.map(route => `${route.method} ${route.path} ${route.controller}.${route.handler}`)).toEqual([
      'HEAD /api/gql graphql.handle',
      'GET /api/gql graphql.handle',
      'POST /api/gql graphql.handle',
    ])
    const res = await app.http.inject({
      method: 'POST',
      url: '/api/gql',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    })
    expect(res.json()).toEqual({ data: { hello: 'Hello world' } })
    expect(checked).toBe(1)
    const big = await app.http.inject({
      method: 'POST',
      url: '/api/gql',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ hello(name: "${'x'.repeat(2_000)}") }` }),
    })
    expect(big.status).toBe(413)
  })

  it('http: false contributes no route', async () => {
    await using app = await startLibrary({ graphql: { http: false } })
    expect(app.http.routes).toEqual([])
  })

  it('rejects invalid SSE options at boot (ZNIGHT066)', async () => {
    await expect(startLibrary({ graphql: { subscriptions: { heartbeat: 10 } } })).rejects.toMatchObject({
      code: 'ZNIGHT066',
    })
  })
})

describe('GraphiQL', () => {
  it('is served to browsers when enabled, with its own content-security-policy', async () => {
    await using app = await startLibrary({ http: { prefix: '/api' }, graphql: { graphiql: true } })
    const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    const res = await app.http.inject({ method: 'GET', url: '/api/graphql', headers: { accept: browser } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('GraphiQL.createFetcher({ url: "/api/graphql" })')
    for (const asset of GRAPHIQL_ASSETS) expect(res.body).toContain(`integrity="${asset.integrity}"`)
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toMatch(/script-src https:\/\/cdn\.jsdelivr\.net 'sha256-[A-Za-z0-9+/=]+'/)
    expect(csp).toContain("connect-src 'self'")
    // the strict default of the API is kept elsewhere
    const api = await app.http.inject({ method: 'GET', url: '/api/graphql?query={hello}' })
    expect(api.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
    // a GET for JSON still executes queries
    const json = await app.http.inject({ method: 'GET', url: '/api/graphql?query={hello}', headers: { accept: '*/*' } })
    expect(json.json()).toEqual({ data: { hello: 'Hello world' } })
  })

  it('is not served when disabled (the default outside development): 406 for HTML only', async () => {
    const res = await get({ query: '{ hello }' }, { accept: 'text/html' })
    expect(res.status).toBe(406)
    const browser = await get({ query: '{ hello }' }, { accept: 'text/html,*/*;q=0.8' })
    expect(browser.status).toBe(200)
    expect(browser.json()).toEqual({ data: { hello: 'Hello world' } })
  })

  it('is served with http.get: false', async () => {
    await using app = await startLibrary({ graphql: { graphiql: true, http: { get: false } } })
    const page = await app.http.inject({ method: 'GET', url: '/graphql', headers: { accept: 'text/html' } })
    expect(page.status).toBe(200)
    const query = await app.http.inject({ method: 'GET', url: '/graphql?query={hello}' })
    expect(query.status).toBe(405)
    expect(query.headers['allow']).toBe('POST')
  })
})
