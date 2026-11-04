/**
 * Run by `transport-runtime.test.ts` on Node.js 24 and Bun: the GraphQL endpoint on a real socket
 * of every adapter. Prints, per adapter, the graphql-http audits that are not `ok`, the statuses of
 * a fixed list of requests (CSRF, negotiation, GET rules), and what GraphQL over SSE does with the
 * graphql-sse client (results, client disconnect) and on the wire (framing, heartbeats, shutdown).
 * Then the same audits against drivers (RFC 0009): `graphql-http`'s own handler on top of
 * `GraphQLEngine`, mounted as the driver's routes, and the Yoga driver, with operations and (Yoga)
 * GraphQL over SSE through them.
 */
import type { HttpAdapter } from '@znight/http'
import type { GraphQLDriver } from '../../src/index.ts'

import { expressAdapter } from '@znight/http/express'
import { fastifyAdapter } from '@znight/http/fastify'
import { honoAdapter } from '@znight/http/hono'
import { nodeAdapter } from '@znight/http/node'
import { auditServer } from 'graphql-http'
import { createClient } from 'graphql-sse'

import { yogaDriver } from '../../src/yoga.ts'
import { graphqlHttpDriver } from '../support/graphql-http-driver.ts'
import { observed, startLibrary } from '../support/library.ts'

const ADAPTERS: readonly [string, () => HttpAdapter][] = [
  ['node', () => nodeAdapter()],
  ['fastify', () => fastifyAdapter()],
  ['express', () => expressAdapter()],
  ['hono', () => honoAdapter()],
]

const QUERY = JSON.stringify({ query: '{ hello }' })

/** Requests whose status and content type must be the same everywhere. */
const REQUESTS: readonly { readonly name: string; readonly init: RequestInit; readonly search?: string }[] = [
  { name: 'post json', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: QUERY } },
  {
    name: 'post graphql-response+json',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json' },
      body: JSON.stringify({ query: '{ nope }' }),
    },
  },
  { name: 'post text/plain', init: { method: 'POST', headers: { 'content-type': 'text/plain' }, body: QUERY } },
  {
    name: 'post form',
    init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'query={hello}' },
  },
  { name: 'post batch', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: `[${QUERY}]` } },
  { name: 'post html', init: { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/html' } } },
  {
    name: 'post too large',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ hello(name: "${'x'.repeat(120_000)}") }` }),
    },
  },
  { name: 'get query', init: { method: 'GET' }, search: '?query=%7B%20hello%20%7D' },
  {
    name: 'get mutation',
    init: { method: 'GET' },
    search: '?query=mutation%20%7B%20addBook(title%3A%22x%22)%20%7B%20title%20%7D%20%7D',
  },
  { name: 'get without query', init: { method: 'GET' } },
  { name: 'delete', init: { method: 'DELETE' } },
]

async function statuses(url: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const request of REQUESTS) {
    const response = await fetch(`${url}${request.search ?? ''}`, request.init)
    await response.arrayBuffer()
    const type = response.headers.get('content-type') ?? '-'
    const allow = response.headers.get('allow')
    result[request.name] = `${response.status} ${type}${allow === null ? '' : ` allow=${allow}`}`
  }
  return result
}

/** Reads a response body as text until `stop(text)` says so, or until it ends; then cancels it. */
async function readUntil(response: Response, stop: (text: string) => boolean, ms: number): Promise<string> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !stop(text)) {
    const timer = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), deadline - Date.now()))
    const step = await Promise.race([reader.read(), timer])
    if (step === 'timeout' || step.done) break
    text += decoder.decode(step.value, { stream: true })
  }
  await reader.cancel().catch(() => undefined)
  return text
}

function sseRequest(url: string, query: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query }),
  })
}

async function until(condition: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  return condition()
}

async function sse(adapter: () => HttpAdapter): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  const app = await startLibrary({ adapter: adapter(), graphql: { subscriptions: { heartbeat: 1_000 } } })
  try {
    // the graphql-sse client (distinct connections mode)
    const client = createClient({ url: app.url, retryAttempts: 0 })
    const countdown: unknown[] = []
    for await (const value of client.iterate({ query: 'subscription { countdown(from: 3) }' })) countdown.push(value)
    result['client'] = countdown
    const query: unknown[] = []
    for await (const value of client.iterate({ query: '{ hello }' })) query.push(value)
    result['clientQuery'] = query
    // a client that leaves: the server ends the source
    observed.ended.length = 0
    const forever = client.iterate({ query: 'subscription { forever }' })
    const first = await forever.next()
    await forever.return?.()
    result['disconnect'] = {
      first: first.value,
      ended: await until(() => observed.ended.includes('forever')),
      active: (await until(() => app.graphql.activeSubscriptions === 0)) ? 0 : app.graphql.activeSubscriptions,
    }
    client.dispose()
    // the framing on the wire
    const framed = await readUntil(
      await sseRequest(app.url, '{ hello }'),
      text => text.includes('event: complete'),
      2_000,
    )
    result['framing'] = framed
    // heartbeats of a quiet subscription
    const quiet = await readUntil(
      await sseRequest(app.url, 'subscription { bookAdded { title } }'),
      text => text.split(':\n\n').length > 2,
      3_000,
    )
    result['heartbeats'] = quiet.split(':\n\n').length - 1
    // the shutdown: the stream ends with a retry and no complete
    const open = await sseRequest(app.url, 'subscription { forever }')
    const reading = readUntil(open, () => false, 5_000)
    await new Promise(resolve => setTimeout(resolve, 50))
    await app.stop()
    const tail = await reading
    result['shutdown'] = {
      next: tail.includes('event: next'),
      complete: tail.includes('event: complete'),
      retry: /\nretry: \d+\n/.test(tail) || tail.startsWith('retry:'),
    }
  } finally {
    await app.stop()
  }
  return result
}

async function audit(url: string): Promise<{ audits: number; notOk: string[] }> {
  const audits = await auditServer({ url })
  return {
    audits: audits.length,
    notOk: audits
      .filter(audit => audit.status !== 'ok')
      .map(audit => `${audit.id} ${audit.status} ${audit.name}: ${'reason' in audit ? audit.reason : ''}`),
  }
}

/** The graphql-http driver on the engine: the audits, a query, and a resolver error (masked by the engine). */
async function driver(
  adapter: () => HttpAdapter,
  create: () => GraphQLDriver = graphqlHttpDriver,
): Promise<Record<string, unknown>> {
  const app = await startLibrary({ adapter: adapter(), graphql: { driver: create() } })
  try {
    const post = async (query: string): Promise<unknown> => {
      const response = await fetch(app.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json' },
        body: JSON.stringify({ query }),
      })
      return { status: response.status, body: await response.json() }
    }
    const result: Record<string, unknown> = {
      ...(await audit(app.url)),
      hello: await post('{ hello }'),
      fail: await post('{ fail }'),
    }
    if (app.graphql.engine.settings.subscriptions !== false && create !== graphqlHttpDriver) {
      // the driver's own GraphQL over SSE, on the engine's streams
      result['framing'] = await readUntil(
        await sseRequest(app.url, 'subscription { countdown(from: 2) }'),
        text => text.includes('event: complete'),
        2_000,
      )
      const client = createClient({ url: app.url, retryAttempts: 0 })
      const values: unknown[] = []
      for await (const value of client.iterate({ query: 'subscription { countdown(from: 3) }' })) values.push(value)
      client.dispose()
      result['client'] = values
      // the shutdown: the engine ends the stream, the driver completes it
      const open = await sseRequest(app.url, 'subscription { forever }')
      const reading = readUntil(open, () => false, 5_000)
      await new Promise(resolve => setTimeout(resolve, 50))
      await app.stop()
      const tail = await reading
      result['shutdown'] = { next: tail.includes('event: next'), complete: tail.includes('event: complete') }
    }
    return result
  } finally {
    await app.stop()
  }
}

const results: Record<string, unknown> = {}
for (const [name, adapter] of ADAPTERS) {
  const app = await startLibrary({ adapter: adapter() })
  try {
    results[name] = {
      ...(await audit(app.url)),
      statuses: await statuses(app.url),
      sse: await sse(adapter),
      driver: await driver(adapter),
      yoga: await driver(adapter, yogaDriver),
    }
  } finally {
    await app.stop()
  }
}
console.log(JSON.stringify(results))
