/**
 * GraphQL over SSE, distinct connections mode (RFC 0005 §5.6, §8.3, §8.11), in memory through
 * `HttpPlugin.injectSse()`: framing, every operation type, request errors, the active
 * subscriptions cap, client disconnects, heartbeats and the shutdown without `complete`.
 */
import type { InjectSseResponse } from '@znight/http'
import type { LibraryApp } from './support/library.ts'

import { observed, startLibrary } from './support/library.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

let library: LibraryApp

beforeAll(async () => {
  library = await startLibrary()
})

afterAll(async () => {
  await library.stop()
})

function subscribe(
  app: LibraryApp,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<InjectSseResponse> {
  return app.http.injectSse({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json; charset=utf-8', accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

/** Every event until the stream ends, as `[event, data]`. */
async function events(stream: InjectSseResponse): Promise<[string, string][]> {
  const received: [string, string][] = []
  for await (const message of stream) received.push([message.event, message.data])
  return received
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(5)
}

describe('GraphQL over SSE', () => {
  it('streams a subscription as next events, then complete', async () => {
    observed.ended.length = 0
    const stream = await subscribe(library, { query: 'subscription { countdown(from: 3) }' })
    expect(stream.status).toBe(200)
    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform')
    expect(await events(stream)).toEqual([
      ['next', '{"data":{"countdown":3}}'],
      ['next', '{"data":{"countdown":2}}'],
      ['next', '{"data":{"countdown":1}}'],
      ['complete', ''],
    ])
    expect(observed.ended).toEqual(['countdown'])
    await until(() => library.graphql.activeSubscriptions === 0)
    expect(library.graphql.activeSubscriptions).toBe(0)
  })

  it('streams queries and mutations as one next event, then complete', async () => {
    const query = await subscribe(library, { query: '{ hello }' })
    expect(await events(query)).toEqual([
      ['next', '{"data":{"hello":"Hello world"}}'],
      ['complete', ''],
    ])
    const mutation = await subscribe(library, { query: 'mutation { addBook(title: "Sse") { title } }' })
    expect(await events(mutation)).toEqual([
      ['next', '{"data":{"addBook":{"title":"Sse"}}}'],
      ['complete', ''],
    ])
  })

  it('serves queries over GET (EventSource)', async () => {
    const stream = await library.http.injectSse({ url: '/graphql?query=%7B%20hello%20%7D' })
    expect(await events(stream)).toEqual([
      ['next', '{"data":{"hello":"Hello world"}}'],
      ['complete', ''],
    ])
    const refused = await library.http.injectSse({ url: '/graphql?query=subscription%20%7B%20forever%20%7D' })
    expect(refused.status).toBe(405)
    expect(refused.headers['allow']).toBe('POST')
  })

  it('delivers PubSub events published by mutations', async () => {
    const stream = await subscribe(library, { query: 'subscription { bookAdded { title } }' })
    const published = await library.http.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mutation { addBook(title: "Dune Messiah") { title } }' }),
    })
    expect(published.status).toBe(200)
    expect((await stream.next()).json()).toEqual({ data: { bookAdded: { title: 'Dune Messiah' } } })
    await stream.close()
    await until(() => library.graphql.activeSubscriptions === 0)
    expect(library.graphql.activeSubscriptions).toBe(0)
  })

  it('answers request errors with a JSON body and their status, not a stream', async () => {
    const invalid = await subscribe(library, { query: 'subscription { nope }' })
    expect(invalid.status).toBe(400)
    expect(invalid.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(invalid.json<{ errors: { extensions: { code: string } }[] }>().errors[0]?.extensions.code).toBe(
      'GRAPHQL_VALIDATION_FAILED',
    )
    const malformed = await subscribe(library, { qeury: 'subscription { forever }' })
    expect(malformed.status).toBe(400)
  })

  it('ends the source when the client disconnects', async () => {
    observed.aborts.length = 0
    observed.ended.length = 0
    const stream = await subscribe(library, { query: 'subscription { forever }' })
    expect((await stream.next()).json()).toEqual({ data: { forever: 1 } })
    expect(library.graphql.activeSubscriptions).toBe(1)
    await stream.close()
    await until(() => observed.ended.includes('forever'))
    expect(observed.ended).toEqual(['forever'])
    await until(() => library.graphql.activeSubscriptions === 0 && library.http.inflight === 0)
    expect(library.graphql.activeSubscriptions).toBe(0)
    expect(library.http.inflight).toBe(0)
  })

  it('refuses subscriptions past subscriptions.maxActive with 503', async () => {
    await using app = await startLibrary({ graphql: { subscriptions: { maxActive: 1 } } })
    const first = await subscribe(app, { query: 'subscription { forever }' })
    expect(first.status).toBe(200)
    const second = await subscribe(app, { query: 'subscription { forever }' })
    expect(second.status).toBe(503)
    expect(second.json<{ errors: { extensions: { code: string } }[] }>().errors[0]?.extensions.code).toBe(
      'SERVICE_UNAVAILABLE',
    )
    // queries over SSE are not subscriptions
    expect((await events(await subscribe(app, { query: '{ hello }' }))).length).toBe(2)
    await first.close()
    await until(() => app.graphql.activeSubscriptions === 0)
    const third = await subscribe(app, { query: 'subscription { forever }' })
    expect(third.status).toBe(200)
    await third.close()
  })

  it('sends heartbeats (subscriptions.heartbeat)', async () => {
    await using app = await startLibrary({ graphql: { subscriptions: { heartbeat: 1_000 } } })
    const stream = await subscribe(app, { query: 'subscription { bookAdded { title } }' })
    await Bun.sleep(1_150)
    expect(stream.comments.filter(comment => comment === '').length).toBeGreaterThanOrEqual(1)
    await stream.close()
  })

  it('ends streams on shutdown without complete (clients reconnect elsewhere)', async () => {
    observed.aborts.length = 0
    const app = await startLibrary({ http: { sse: { shutdownGraceMs: 200 } } })
    const stream = await subscribe(app, { query: 'subscription { forever }' })
    expect((await stream.next()).event).toBe('next')
    const stopping = app.stop()
    const received = await events(stream)
    await stopping
    expect(received.every(([event]) => event === 'next')).toBe(true)
    expect(stream.retry).toBeGreaterThan(0)
    expect(observed.aborts).toContain('shutdown')
  })

  it('is off with subscriptions: false (406 for text/event-stream only)', async () => {
    await using app = await startLibrary({ graphql: { subscriptions: false } })
    const refused = await subscribe(app, { query: '{ hello }' })
    expect(refused.status).toBe(406)
    const fallback = await subscribe(
      app,
      { query: '{ hello }' },
      { accept: 'text/event-stream, application/json;q=0.5' },
    )
    expect(fallback.status).toBe(200)
    expect(fallback.json()).toEqual({ data: { hello: 'Hello world' } })
  })
})
