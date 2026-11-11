/**
 * The "Serve the schema with GraphQL Yoga" recipe (`yoga.plugins.ts`): the library application of
 * the compiler end-to-end test plus the plugins of the recipe (the Yoga driver), compiled, booted and
 * queried through Yoga on the endpoint. Guards (and their `ctx.http`), the singleton and the
 * request-scoped loaders, Standard Schema validation, error codes, the `graphql:operation` hook and
 * subscriptions over Yoga's SSE keep working, because the engine executes every operation.
 */
import type { GraphQLOperationEvent, Plugin, ZnightMetadata } from '@znight/core'
import type { GraphQLPlugin } from '../../src/index.ts'
import type { TempApp } from '../compiler/helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TestApp } from '@znight/testing'

import { LIBRARY } from '../compiler/e2e-app.ts'
import { cleanupApps, compileApp, GRAPHQL_ROOT, render, tempApp } from '../compiler/helpers.ts'
import { captureLogger } from '../support/app.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/**
 * The recipe, on a free port for the tests. The access guard of the library is a GraphQL guard: no
 * HTTP guard enforces its group on the endpoint, hence `enforcement: 'warn'`.
 */
const PLUGINS = fs
  .readFileSync(path.join(import.meta.dir, 'yoga.plugins.ts'), 'utf8')
  .replace('HttpPlugin.configure()', "HttpPlugin.configure({ port: 0, host: '127.0.0.1', enforcement: 'warn' })")
const STORE = 'src/catalog/catalog.store.ts#CatalogStore'
const EDITOR = { 'x-role': 'editor' }
const READER = { 'x-role': 'reader' }
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/graphql-response+json' }
const ADD_BOOK = 'mutation Add($input: NewBookInput!) { addBook(input: $input) { id title author { name } } }'

interface Store {
  readonly authorBatches: (readonly string[])[]
  readonly reviewBatches: (readonly string[])[]
  readonly reviewLoaders: number
}

interface Result {
  readonly data?: Record<string, unknown> | null
  readonly errors?: readonly { readonly message: string; readonly extensions?: Record<string, unknown> }[]
}

describe('the Yoga recipe', () => {
  let app: TempApp
  let server: TestApp
  let store: Store
  const operations: GraphQLOperationEvent[] = []

  function post(body: unknown, headers: Record<string, string> = {}) {
    return server.inject({ method: 'POST', url: '/graphql', headers: { ...JSON_HEADERS, ...headers }, body })
  }

  beforeAll(async () => {
    app = tempApp({ ...LIBRARY, 'src/graphql/yoga.plugins.ts': PLUGINS })
    fs.symlinkSync(
      fs.realpathSync.native(path.join(GRAPHQL_ROOT, 'node_modules/graphql-yoga')),
      path.join(app.root, 'node_modules/graphql-yoga'),
      'dir',
    )
    const result = await compileApp(app.root, { mode: 'build' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    const generated = (await import(pathToFileURL(result.outFile).href)) as { metadata: ZnightMetadata }
    const recipe = (await import(pathToFileURL(path.join(app.root, 'src/graphql/yoga.plugins.ts')).href)) as {
      plugins(): Plugin[]
    }
    server = await TestApp.create({
      metadata: generated.metadata,
      plugins: recipe.plugins(),
      logger: captureLogger(),
    })
    server.app.hooks.on('graphql:operation', event => {
      operations.push(event)
    })
    store = server.get(STORE) as Store
  }, 60_000)

  afterAll(async () => {
    await server?.close()
    cleanupApps()
  })

  it('serves queries through Yoga, batching with the singleton and the request-scoped loaders', async () => {
    const authorBatches = store.authorBatches.length
    const reviewLoaders = store.reviewLoaders
    const res = await post({ query: '{ books(limit: 2) { items { title author { name } reviews { stars } } } }' })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/graphql-response+json')
    // the Yoga plugin of the recipe ran
    expect(res.headers['x-graphql-server']).toBe('yoga')
    expect(res.json<Result>()).toEqual({
      data: {
        books: {
          items: [
            { title: 'A Wizard of Earthsea', author: { name: 'Ursula K. Le Guin' }, reviews: [{ stars: 5 }] },
            { title: 'Children of Dune', author: { name: 'Frank Herbert' }, reviews: [] },
          ],
        },
      },
    })
    expect(store.authorBatches.slice(authorBatches)).toEqual([['a2', 'a1']])
    expect(store.reviewLoaders - reviewLoaders).toBe(1)
  })

  it('serves queries over GET, with the operation name and variables', async () => {
    const query = encodeURIComponent('query One($id: ID!) { book(id: $id) { title } }')
    const variables = encodeURIComponent(JSON.stringify({ id: 'b1' }))
    const res = await server.inject({
      url: `/graphql?query=${query}&operationName=One&variables=${variables}`,
      headers: { accept: 'application/json' },
    })

    expect(res.status).toBe(200)
    expect(res.json<Result>()).toEqual({ data: { book: { title: 'Dune' } } })
  })

  it('runs the GraphQL guards, which see the HTTP request of the route', async () => {
    const anonymous = await post({ query: '{ whoami }' })
    const reader = await post({ query: '{ whoami }' }, READER)

    expect(anonymous.json<Result>().errors?.map(error => [error.message, error.extensions?.['code']])).toEqual([
      ['Sign in first', 'UNAUTHENTICATED'],
    ])
    expect(reader.json<Result>()).toEqual({ data: { whoami: 'reader' } })
  })

  it('validates arguments and reports error codes as GraphQLPlugin formats them', async () => {
    const invalid = await post(
      { query: ADD_BOOK, variables: { input: { title: '', isbn: '9780593098233', authorId: 'a1', genre: 'Fantasy' } } },
      EDITOR,
    )
    const forbidden = await post(
      {
        query: ADD_BOOK,
        variables: { input: { title: 'Dune Messiah', isbn: '9780593098233', authorId: 'a1', genre: 'Fantasy' } },
      },
      READER,
    )

    expect(invalid.json<Result>().errors?.map(error => error.extensions?.['code'])).toEqual(['BAD_USER_INPUT'])
    expect(forbidden.json<Result>().errors?.map(error => error.extensions?.['code'])).toEqual(['FORBIDDEN'])
  })

  it('reports parse and validation errors of the engine, observed as rejected operations', async () => {
    const before = operations.length
    const syntax = await post({ query: '{ books {' })
    const unknown = await post({ query: '{ nope }' })

    expect(syntax.status).toBe(400)
    expect(unknown.status).toBe(400)
    expect(unknown.json<Result>().errors?.[0]?.message).toContain('Cannot query field "nope"')
    expect(
      operations.slice(before).map(event => [event.outcome, event.driver, event.errors?.map(error => error.code)]),
    ).toEqual([
      ['rejected', 'yoga', ['GRAPHQL_PARSE_FAILED']],
      ['rejected', 'yoga', ['GRAPHQL_VALIDATION_FAILED']],
    ])
  })

  it('emits the graphql:operation hook of every execution', async () => {
    const before = operations.length
    await post({ query: 'query Titles { books { total } }' })

    expect(operations.slice(before)).toEqual([
      expect.objectContaining({ operationType: 'query', operationName: 'Titles', transport: 'http', driver: 'yoga' }),
    ])
  })

  it('streams subscriptions over Yoga SSE and ends them when the client leaves', async () => {
    const plugin = server.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
    const stream = await server.injectSse({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: { query: 'subscription { bookAdded(genre: Fantasy) { title } }' },
    })
    expect(stream.status).toBe(200)
    expect(plugin.activeSubscriptions).toBe(1)

    const added = await post(
      {
        query: ADD_BOOK,
        variables: { input: { title: 'Tehanu', isbn: '9781481465779', authorId: 'a2', genre: 'Fantasy' } },
      },
      EDITOR,
    )
    expect(added.json<Result>().errors).toBeUndefined()

    const event = await stream.next()
    expect(event.event).toBe('next')
    expect(event.json()).toEqual({ data: { bookAdded: { title: 'Tehanu' } } })

    await stream.close()
    for (let attempt = 0; attempt < 100 && plugin.activeSubscriptions !== 0; attempt++) await Bun.sleep(5)
    expect(plugin.activeSubscriptions).toBe(0)
  })
})
