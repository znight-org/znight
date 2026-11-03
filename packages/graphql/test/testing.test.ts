/**
 * `@znight/graphql/testing` (RFC 0005 §5.12): `executeOperation()`, `subscribeOperation()` and
 * `fakeLoader()`, against `TestApp` with and without the HTTP transport.
 */
import type { HttpAdapter } from '@znight/http'
import type { GraphQLPluginOptions, MemoryPubSub } from '../src/index.ts'

import { HttpPlugin } from '@znight/http'
import { expressAdapter } from '@znight/http/express'
import { fastifyAdapter } from '@znight/http/fastify'
import { honoAdapter } from '@znight/http/hono'
import { nodeAdapter } from '@znight/http/node'
import { TestApp } from '@znight/testing'

import { GraphQLPlugin } from '../src/index.ts'
import { executeOperation, fakeLoader, subscribeOperation } from '../src/testing.ts'
import { captureLogger } from './support/app.ts'
import { libraryMetadata, observed } from './support/library.ts'
import { describe, expect, it } from 'bun:test'

function createTestApp(
  options: GraphQLPluginOptions = {},
  http = true,
  adapter: HttpAdapter | undefined = undefined,
): Promise<TestApp> {
  return TestApp.create({
    metadata: libraryMetadata(),
    plugins: [
      ...(http
        ? [HttpPlugin.configure({ port: 0, host: '127.0.0.1', ...(adapter === undefined ? {} : { adapter }) })]
        : []),
      GraphQLPlugin.configure({ introspection: true, ...options }),
    ],
    logger: captureLogger(),
  })
}

const ADD = 'mutation Add($title: String!) { addBook(title: $title) { title } }'

describe('executeOperation()', () => {
  it('sends the operation through the HTTP pipeline', async () => {
    await using app = await createTestApp()
    const res = await executeOperation<{ hello: string }>(app, {
      query: 'query Q($name: String) { hello(name: $name) }',
      variables: { name: 'Ada' },
      operationName: 'Q',
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/graphql-response+json; charset=utf-8')
    expect(res.data).toEqual({ hello: 'Hello Ada' })
    expect(res.errors).toBeUndefined()
    expect(res.extensions).toBeUndefined()
    expect(JSON.parse(res.body)).toEqual({ data: { hello: 'Hello Ada' } })
  })

  it('reports request errors with 400 and field errors with 200', async () => {
    await using app = await createTestApp()
    const invalid = await executeOperation(app, { query: '{ nope }' })
    expect(invalid.status).toBe(400)
    expect(invalid.data).toBeUndefined()
    expect(invalid.errors?.[0]?.extensions?.['code']).toBe('GRAPHQL_VALIDATION_FAILED')
    const partial = await executeOperation(app, { query: '{ hello fail }' })
    expect(partial.status).toBe(200)
    expect(partial.data).toEqual({ hello: 'Hello world', fail: null })
    expect(partial.errors?.[0]?.path).toEqual(['fail'])
  })

  it('sends the given headers over the defaults (any case)', async () => {
    await using app = await createTestApp()
    const res = await executeOperation(app, { query: '{ nope }', headers: { Accept: 'application/json' } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    const refused = await executeOperation(app, { query: '{ hello }', headers: { 'content-type': 'text/plain' } })
    expect(refused.status).toBe(415)
    expect(refused.errors?.[0]?.message).toContain('application/json')
  })

  it('calls the plugin without HTTP transport', async () => {
    await using app = await createTestApp({ http: false }, false)
    const res = await executeOperation(app, { query: '{ hello }' })
    expect(res).toEqual({
      status: 200,
      headers: {},
      data: { hello: 'Hello world' },
      body: '{"data":{"hello":"Hello world"}}',
    })
    const invalid = await executeOperation(app, { query: '{ nope }' })
    expect(invalid.status).toBe(400)
    expect(invalid.errors).toHaveLength(1)
  })

  it('needs a TestApp with GraphQLPlugin and a query', async () => {
    const withoutGraphQL = { app: { getPlugin: () => undefined } } as unknown as TestApp
    await expect(executeOperation(withoutGraphQL, { query: '{ hello }' })).rejects.toThrow('GraphQLPlugin')
    await expect(subscribeOperation(withoutGraphQL, { query: '{ hello }' })).rejects.toThrow('GraphQLPlugin')
    await using graphql = await createTestApp()
    await expect(executeOperation(graphql, {} as never)).rejects.toThrow('{ query')
  })
})

describe('subscribeOperation()', () => {
  it('streams the events published once it resolved', async () => {
    await using app = await createTestApp()
    const events = await subscribeOperation<{ bookAdded: { title: string } }>(app, {
      query: 'subscription { bookAdded { title } }',
    })
    expect(events.status).toBe(200)
    await executeOperation(app, { query: ADD, variables: { title: 'Dune' } })
    expect((await events.next()).value).toEqual({ data: { bookAdded: { title: 'Dune' } } })
    await events.return()
  })

  it('ends after complete, and streams queries as one result', async () => {
    await using app = await createTestApp()
    const countdown = await subscribeOperation(app, { query: 'subscription { countdown(from: 2) }' })
    const results = []
    for await (const result of countdown) results.push(result)
    expect(results).toEqual([{ data: { countdown: 2 } }, { data: { countdown: 1 } }])
    expect(await countdown.next()).toEqual({ done: true, value: undefined })
    const query = await subscribeOperation(app, { query: '{ hello }' })
    expect(await query.next()).toEqual({ done: false, value: { data: { hello: 'Hello world' } } })
    expect(await query.next()).toEqual({ done: true, value: undefined })
  })

  it('times out next() (2 s by default) without losing the pending result', async () => {
    await using app = await createTestApp()
    const events = await subscribeOperation(app, { query: 'subscription { bookAdded { title } }' })
    await expect(events.next({ timeoutMs: 20 })).rejects.toThrow('no result within 20 ms')
    await executeOperation(app, { query: ADD, variables: { title: 'Late' } })
    expect((await events.next()).value).toEqual({ data: { bookAdded: { title: 'Late' } } })
    await events.return()
  })

  it('disconnects on return(): the server sees a client abort', async () => {
    await using app = await createTestApp()
    observed.ended.length = 0
    observed.aborts.length = 0
    const plugin = app.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
    const events = await subscribeOperation(app, { query: 'subscription { forever }' })
    expect((await events.next()).value).toEqual({ data: { forever: 1 } })
    expect(plugin.activeSubscriptions).toBe(1)
    await events.return()
    for (let attempt = 0; attempt < 200 && plugin.activeSubscriptions > 0; attempt++) await Bun.sleep(5)
    expect(plugin.activeSubscriptions).toBe(0)
    for (let attempt = 0; attempt < 200 && observed.ended.length === 0; attempt++) await Bun.sleep(5)
    expect(observed.ended).toEqual(['forever'])
    expect(await events.next()).toEqual({ done: true, value: undefined })
  })

  it('gives a request error as the status and a single result', async () => {
    await using app = await createTestApp()
    const events = await subscribeOperation(app, { query: 'subscription { nope }' })
    expect(events.status).toBe(400)
    const first = await events.next()
    expect(first.value?.errors?.[0]?.extensions?.['code']).toBe('GRAPHQL_VALIDATION_FAILED')
    expect(await events.next()).toEqual({ done: true, value: undefined })
  })

  it('calls plugin.subscribe() without HTTP transport', async () => {
    await using app = await createTestApp({ http: false }, false)
    const events = await subscribeOperation(app, { query: 'subscription { bookAdded { title } }' })
    await executeOperation(app, { query: ADD, variables: { title: 'Direct' } })
    expect((await events.next()).value).toEqual({ data: { bookAdded: { title: 'Direct' } } })
    await events.return()
    const invalid = await subscribeOperation(app, { query: 'subscription { nope }' })
    expect(invalid.status).toBe(400)
    expect((await invalid.next()).value?.errors).toHaveLength(1)
  })
})

// every adapter, and without HTTP transport (plugin.subscribe())
const TRANSPORTS: readonly [string, () => Promise<TestApp>][] = [
  ['node', () => createTestApp({}, true, nodeAdapter())],
  ['fastify', () => createTestApp({}, true, fastifyAdapter())],
  ['express', () => createTestApp({}, true, expressAdapter())],
  ['hono', () => createTestApp({}, true, honoAdapter())],
  ['in memory', () => createTestApp({ http: false }, false)],
]

describe.each(TRANSPORTS)('subscribeOperation() on %s', (_name, create) => {
  it('resolves once the generator of the resolver subscribed: an event published at once is received', async () => {
    await using app = await create()
    const pubsub = (app.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin).pubsub as MemoryPubSub
    await using events = await subscribeOperation(app, { query: 'subscription { newBook { title } }' })
    expect(pubsub.subscribers).toBe(1)
    await executeOperation(app, { query: ADD, variables: { title: 'At once' } })
    expect((await events.next()).value).toEqual({ data: { newBook: { title: 'At once' } } })
  })

  it('return() ends the started generator and its PubSub subscription', async () => {
    await using app = await create()
    const plugin = app.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
    const pubsub = plugin.pubsub as MemoryPubSub
    const events = await subscribeOperation(app, { query: 'subscription { newBook { title } }' })
    expect(pubsub.subscribers).toBe(1)
    await events.return()
    for (let attempt = 0; attempt < 200 && pubsub.subscribers > 0; attempt++) await Bun.sleep(5)
    expect(pubsub.subscribers).toBe(0)
    expect(plugin.activeSubscriptions).toBe(0)
  })
})

describe('fakeLoader()', () => {
  interface Author {
    readonly id: string
    readonly name: string
  }
  class AuthorsById {
    load(ids: readonly string[]): Promise<readonly (Author | Error)[]> {
      return Promise.resolve(ids.map(id => ({ id, name: id })))
    }
  }
  const herbert: Author = { id: 'a1', name: 'Frank Herbert' }

  it('answers from a record, with spies', async () => {
    const authors = fakeLoader<AuthorsById>({ a1: herbert, a2: new Error('gone') })
    expect(await authors.load('a1')).toBe(herbert)
    expect(authors.load).toHaveBeenCalledWith('a1')
    expect(authors.load).toHaveBeenCalledTimes(1)
    await expect(authors.load('a2')).rejects.toThrow('gone')
    await expect(authors.load('zz')).rejects.toThrow('no value for the key "zz"')
    const many = await authors.loadMany(['a1', 'a2', 'zz'])
    expect(many[0]).toBe(herbert)
    expect(many[1]).toBeInstanceOf(Error)
    expect(many[2]).toBeInstanceOf(Error)
    expect(authors.loadMany).toHaveBeenCalledWith(['a1', 'a2', 'zz'])
  })

  it('answers from a map or a function, caches by key, and supports prime/clear', async () => {
    const fromMap = fakeLoader<AuthorsById>(new Map([['a1', herbert]]))
    expect(await fromMap.load('a1')).toBe(herbert)
    let calls = 0
    const fromFn = fakeLoader<AuthorsById>(id => {
      calls++
      return { id, name: `Author ${id}` }
    })
    expect(await fromFn.load('x')).toEqual({ id: 'x', name: 'Author x' })
    await fromFn.load('x')
    expect(calls).toBe(1)
    expect(fromFn.clear('x')).toBe(fromFn)
    await fromFn.load('x')
    expect(calls).toBe(2)
    fromFn.prime('p', herbert).clearAll().prime('p', herbert)
    expect(await fromFn.load('p')).toBe(herbert)
    expect(calls).toBe(2)
  })
})
