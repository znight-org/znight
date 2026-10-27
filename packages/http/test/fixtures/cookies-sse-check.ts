/**
 * Cookie and SSE check executed by `test/cookies-sse-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: boots the cookie / SSE sample application on every
 * adapter, sends the same requests over the network and in memory, and prints what it observed as
 * JSON (identical across adapters, transports and runtimes).
 */
import type { HttpAdapter, InjectRequest, InjectResponse, SseItem } from '../../src/index.ts'

import { Application, silentLogger } from '@znight/core'

import { expressAdapter } from '../../src/adapters/express.ts'
import { fastifyAdapter } from '../../src/adapters/fastify.ts'
import { honoAdapter } from '../../src/adapters/hono.ts'
import { nodeAdapter } from '../../src/adapters/node.ts'
import { HttpPlugin, parseSseStream } from '../../src/index.ts'
import { cookiesSseMetadata, cookiesSseOptions, resetSseState, sseState } from '../cookies-sse-app.ts'
import { viaFetch } from '../helpers.ts'

const REQUESTS: readonly InjectRequest[] = [
  { method: 'GET', url: '/prefs', cookies: { theme: 'dark', visits: '3' } },
  { method: 'GET', url: '/prefs', cookies: { theme: 'blue' } },
  { method: 'GET', url: '/prefs/count', cookies: { n: 'secret' } },
  { method: 'POST', url: '/prefs/theme' },
  { method: 'POST', url: '/auth/login' },
  { method: 'GET', url: '/auth/me', signedCookies: { '__Host-uid': 'u-9' } },
  { method: 'GET', url: '/auth/me', cookies: { '__Host-uid': 'u-9.AAAA' } },
  { method: 'POST', url: '/auth/logout' },
  { method: 'GET', url: '/auth/merge' },
  { method: 'GET', url: '/auth/guarded' },
  { method: 'GET', url: '/auth/redirect' },
  { method: 'GET', url: '/auth/web' },
  { method: 'GET', url: '/auth/invalid' },
  { method: 'GET', url: '/auth/echo', headers: { cookie: 'a=1' }, cookies: { b: 'x y' } },
  { method: 'HEAD', url: '/events/clock' },
  { method: 'GET', url: '/events/orders/missing' },
]

/** Headers compared across adapters and runtimes. */
const HEADERS = ['set-cookie', 'content-type', 'cache-control', 'x-accel-buffering', 'location']

interface Observed {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string | string[]>
}

function observe(response: InjectResponse): Observed {
  const headers: Record<string, string | string[]> = {}
  for (const name of HEADERS) {
    const value = response.headers[name]
    if (value !== undefined) headers[name] = value
  }
  return { status: response.status, body: response.body, headers }
}

const DECODER = new TextDecoder()

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  let result = ''
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return result + DECODER.decode()
    result += DECODER.decode(value, { stream: true })
  }
}

function plain(item: SseItem): unknown {
  return item.type === 'event' ? { event: item.event, data: item.data, id: item.id } : item
}

async function until(condition: () => boolean): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > 5_000) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Event stream scenarios, in memory and over the network. */
async function sse(http: HttpPlugin): Promise<unknown> {
  const url = (path: string): string => `${String(http.address)}${path}`
  const framed = await text((await http.injectStream({ method: 'GET', url: '/events/framing' })).body)
  const framedNetwork = await (await fetch(url('/events/framing'))).text()

  const stream = await http.injectSse({ url: '/events/orders/o-1' })
  const events = (await stream.take(2)).map(event => ({ event: event.event, data: event.data, id: event.id }))
  const retry = stream.retry
  await stream.close()

  const response = await fetch(url('/events/orders/o-1'))
  const items: unknown[] = []
  const iterator = parseSseStream(response.body as ReadableStream<Uint8Array>)
  for (let index = 0; index < 3; index++) items.push(plain((await iterator.next()).value as SseItem))
  await iterator.return?.()

  await until(() => http.inflight === 0)
  resetSseState()
  const scoped = await http.injectSse({ url: '/scoped' })
  const first = (await scoped.next()).data
  await scoped.close()
  await until(() => sseState.finallyRan === 1 && sseState.disposed === 1 && http.inflight === 0)
  const disconnect = { first, signals: [...sseState.signals], streams: http.streams }

  const assistant = await http.injectSse({ method: 'POST', url: '/events/assistant', body: 'a b' })
  const tokens = (await assistant.take(3)).map(event => event.data)
  await assistant.done

  let rejected = ''
  try {
    await http.inject({ url: '/events/framing' })
  } catch (error) {
    rejected = (error as Error).message
  }
  await until(() => http.inflight === 0)
  return {
    framed,
    framedNetwork,
    events,
    retry,
    items,
    disconnect,
    assistant: { status: assistant.status, cookies: Object.keys(assistant.cookies), tokens },
    rejected,
  }
}

async function check(adapter: HttpAdapter): Promise<{ network: Observed[]; inject: Observed[]; sse: unknown }> {
  const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', ...cookiesSseOptions(), adapter })
  const app = await Application.create({
    metadata: cookiesSseMetadata(),
    plugins: [http],
    logger: silentLogger,
    shutdown: { signals: false },
  })
  await app.start()
  try {
    const network: Observed[] = []
    const inject: Observed[] = []
    const fetchSend = viaFetch(http)
    for (const request of REQUESTS) {
      network.push(observe(await fetchSend(request)))
      inject.push(observe(await http.inject(request)))
    }
    return { network, inject, sse: await sse(http) }
  } finally {
    await app.stop()
  }
}

const results: Record<string, unknown> = {}
for (const [name, create] of [
  ['node', () => nodeAdapter()],
  ['fastify', () => fastifyAdapter()],
  ['express', () => expressAdapter()],
  ['hono', () => honoAdapter()],
] as const) {
  results[name] = await check(create())
}
process.stdout.write(JSON.stringify(results))
