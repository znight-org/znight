/**
 * The fast lane of the pipeline (`Pipeline.handler`): routes without guards, interceptors, `@Sse`,
 * `@Res()` nor `@Header` are served without the general machinery while the handler stays
 * synchronous. Every reply must be the one of the general pipeline, which a request takes when an
 * `http:request` listener is registered: each case is sent through both and compared, byte for byte
 * (the request id aside), header order included.
 */
import type {
  AdapterHandler,
  AdapterReply,
  AdapterRequest,
  AdapterRoute,
  HttpAdapter,
  HttpContext,
  HttpServerAddress,
} from '../src/index.ts'
import type { TestApp } from './helpers.ts'

import { CoreTokens } from '@znight/core'

import { BadRequestException, HttpResponse, HttpTokens, NotFoundException } from '../src/index.ts'
import { randomRequestId } from '../src/pipeline.ts'
import { controller, createApp, metadata, provider, route, sleep, t } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

/** An adapter handing the plugin's handlers to the test (no server, no socket). */
class RecordingAdapter implements HttpAdapter {
  readonly name = 'recording'
  readonly routes: AdapterRoute[] = []

  registerRoute(route: AdapterRoute): void {
    this.routes.push(route)
  }

  setFallbackHandler(): void {}

  listen(port: number, host: string): Promise<HttpServerAddress> {
    const url = `http://${host}:${port}`
    return Promise.resolve({ host, port, family: 'IPv4', url, toString: () => url })
  }

  async close(): Promise<void> {}

  inject(): Promise<never> {
    return Promise.reject(new Error('not supported'))
  }

  handler(method: string, path: string): AdapterHandler {
    const found = this.routes.find(route => route.method === method && route.path.path === path)
    if (found === undefined) throw new Error(`no route ${method} ${path}`)
    return found.handler
  }
}

interface Sent {
  readonly method?: string
  readonly url: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

function request(sent: Sent): AdapterRequest {
  const bytes = sent.body === undefined ? undefined : new TextEncoder().encode(sent.body)
  const headers: Record<string, string> = { host: 'localhost', ...sent.headers }
  if (bytes !== undefined) headers['content-length'] = String(bytes.byteLength)
  return {
    method: sent.method ?? 'GET',
    url: sent.url,
    headers,
    ip: '127.0.0.1',
    remoteAddress: '127.0.0.1',
    raw: undefined,
    rawResponse: undefined,
    readBody: () => Promise.resolve(bytes ?? new Uint8Array(0)),
    hasBody: () => bytes !== undefined,
  }
}

/** What an adapter sends: status, headers in order (request id normalised), body bytes. */
async function wire(reply: AdapterReply): Promise<unknown> {
  const headers = Object.entries(reply.headers).map(([name, value]) =>
    name === 'x-request-id' ? [name, ID.test(String(value)) ? '<id>' : value] : [name, value],
  )
  let body: string | null = null
  if (reply.body instanceof Uint8Array) body = new TextDecoder().decode(reply.body)
  else if (reply.body instanceof ReadableStream) body = await new Response(reply.body).text()
  // the text an adapter may send instead of the bytes
  return { status: reply.status, headers, body, text: reply.text ?? null }
}

const ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|id-\d+)$/

class Thing {
  readonly kind = 'thing'
}

class Gone extends Error {}

class Users {
  get(id: number): { id: number; name: string } {
    if (id > 100) throw new NotFoundException(`User ${id} not found`)
    return { id, name: `User ${id}` }
  }
}

const disposed: string[] = []

class Scoped {
  [Symbol.dispose](): void {
    disposed.push('sync')
  }
}

class SlowScoped {
  async [Symbol.asyncDispose](): Promise<void> {
    await sleep(5)
    disposed.push('async')
  }
}

class Exploding {
  [Symbol.dispose](): void {
    throw new Error('disposal failed')
  }
}

/** A request-scoped controller. */
class PerRequest {
  readonly ctx: HttpContext
  constructor(ctx: HttpContext) {
    this.ctx = ctx
  }
  show(): unknown {
    return { path: this.ctx.path }
  }
}

const seen: Record<string, unknown> = {}

// biome-ignore lint/suspicious/noExplicitAny: the controller of hand-written routes
type Any = any

const ROUTES = [
  route('object', '/object', () => ({ id: 1, name: 'Ada', tags: ['a', 'b'], nested: { ok: true } })),
  route('array', '/array', () => [1, 'two', { three: 3 }]),
  route('unicode', '/unicode', () => ({ text: 'héllo wörld ✓ \u{1F600}' })),
  route('param', '/users/:id', (c: Any, ctx) => c.users.get(Number(ctx.params['id']))),
  route('wildcard', '/files/*', (_c, ctx) => ({ rest: ctx.params['*'], query: ctx.query })),
  route('toJSON', '/to-json', () => ({ toJSON: () => ({ replaced: true }) })),
  route('toJSONUndefined', '/to-json-undefined', () => ({ toJSON: () => undefined })),
  route('bigint', '/bigint', () => ({ big: 1n })),
  route('string', '/string', () => 'plain text'),
  route('undefined', '/undefined', () => undefined),
  route('null', '/null', () => null),
  route('number', '/number', () => 42),
  route('instance', '/instance', () => new Thing()),
  route('nullProto', '/null-proto', () => Object.assign(Object.create(null), { a: 1 })),
  route('ownConstructor', '/own-constructor', () => ({ constructor: { name: 'HttpResponse' }, body: 1, headers: {} })),
  // `pipe` alone: serialised as JSON by both, through the general pipeline for the fast lane
  route('pipeLike', '/pipe-like', () => ({ pipe: () => undefined, value: 1 })),
  route('bytes', '/bytes', () => new Uint8Array([1, 2, 3])),
  route('stream', '/stream', () => new Response('streamed').body),
  route('httpResponse', '/http-response', () =>
    new HttpResponse({ ok: true }, { status: 202 }).withHeader('x-extra', '1').withCookie('a', 'b'),
  ),
  route('webResponse', '/web-response', () => new Response('web', { status: 203, headers: { 'x-web': '1' } })),
  route('thrown', '/thrown', () => {
    throw new BadRequestException('nope')
  }),
  route('unexpected', '/unexpected', () => {
    throw new Error('boom')
  }),
  route('mapped', '/mapped', () => {
    throw new Gone('gone')
  }),
  route('promise', '/promise', async () => {
    await sleep(1)
    return { later: true }
  }),
  route('rejected', '/rejected', async () => {
    await sleep(1)
    throw new BadRequestException('later')
  }),
  route('promisedResponse', '/promised-response', async () => HttpResponse.created({ made: true })),
  // biome-ignore lint/suspicious/noThenProperty: a thenable that is not a promise
  route('thenable', '/thenable', () => ({ then: (resolve: (value: unknown) => void) => resolve({ thenable: true }) })),
  route('setHeader', '/set-header', (_c, ctx) => {
    ctx.setHeader('x-custom', 'yes')
    return { header: true }
  }),
  route('badHeader', '/bad-header', (_c, ctx) => {
    ctx.setHeader('x-bad', 'a\r\nb')
    return { header: false }
  }),
  route('setCookie', '/set-cookie', (_c, ctx) => {
    ctx.setCookie('session', 'abc')
    return { cookie: true }
  }),
  route('status', '/status', () => ({ accepted: true }), { status: 202 }),
  route('nothing', '/nothing', () => undefined, { method: 'POST' }),
  route('emptyOk', '/empty-ok', () => undefined, { status: 200 }),
  route('emptyNoContent', '/empty-no-content', () => undefined, { status: 204 }),
  route('noContent', '/no-content', () => ({ dropped: true }), { status: 204 }),
  route('withHeader', '/with-header', () => ({ fixed: true }), { headers: { 'x-fixed': 'yes' } }),
  route('create', '/create', (_c, ctx) => ({ created: ctx.body }), {
    method: 'POST',
    params: [{ index: 0, source: 'body' }],
  }),
  route(
    'validated',
    '/validated',
    async (_c, ctx) => {
      await sleep(1)
      const body = ctx.body as { name?: unknown }
      if (typeof body?.name !== 'string') throw new BadRequestException('name required')
      return { hello: body.name }
    },
    { method: 'POST', params: [{ index: 0, source: 'body' }] },
  ),
  route(
    'scope',
    '/scope',
    (c: Any, ctx) => {
      const container = c.container
      const scoped = container.get(t('Scoped')) as Scoped
      seen['sameContext'] = container.get(HttpTokens.Context) === ctx
      seen['requestId'] = container.currentScope()?.get(HttpTokens.RequestId) === ctx.requestId
      seen['sameScoped'] = container.get(t('Scoped')) === scoped
      // a continuation created by a synchronous handler keeps the request scope
      queueMicrotask(() => {
        seen['microtask'] = container.currentScope()?.get(HttpTokens.RequestId) === ctx.requestId
      })
      return { scoped: true }
    },
    {},
  ),
  route('slowDispose', '/slow-dispose', (c: Any) => {
    c.container.get(t('SlowScoped'))
    return { slow: true }
  }),
  route('failedDispose', '/failed-dispose', (c: Any) => {
    c.container.get(t('Exploding'))
    return { exploding: true }
  }),
  route('listen', '/listen', (c: Any) => {
    // a listener registered while the handler runs sees this request (as with the general pipeline)
    const off = c.hooks.on('http:request', (event: { status?: number; path: string }) => {
      seen['listened'] = `${event.path} ${event.status}`
      off()
    })
    return { listen: true }
  }),
]

class Api {
  readonly users = new Users()
  readonly container: unknown
  readonly hooks: unknown
  constructor(container: unknown, hooks: unknown) {
    this.container = container
    this.hooks = hooks
  }
}

const META = metadata(
  {
    [t('Api')]: provider(Api, [CoreTokens.Container, CoreTokens.Hooks]),
    [t('PerRequest')]: provider(PerRequest, [HttpTokens.Context], 'request'),
    [t('Scoped')]: provider(Scoped, [], 'request'),
    [t('SlowScoped')]: provider(SlowScoped, [], 'request'),
    [t('Exploding')]: provider(Exploding, [], 'request'),
  },
  [
    controller(t('Api'), '/', ROUTES),
    controller(t('PerRequest'), '/per-request', [route('show', '/', (c: PerRequest) => c.show())]),
  ],
)

const mapper = {
  map: (error: unknown) => (error instanceof Gone ? new HttpResponse({ mapped: true }, { status: 410 }) : undefined),
}

describe('fast lane', () => {
  let app: TestApp
  let adapter: RecordingAdapter

  beforeAll(async () => {
    adapter = new RecordingAdapter()
    app = await createApp(META, { adapter, exceptionMappers: [mapper] }, { start: false })
  })

  afterAll(() => app.stop())

  /** The reply of the fast lane and the one of the general pipeline (a listener registered). */
  async function both(sent: Sent, path: string): Promise<{ fast: unknown; general: unknown; sync: boolean }> {
    const handler = adapter.handler(sent.method ?? 'GET', path)
    const pending = handler(request(sent))
    // only the synchronous fast lane is over before the reply is awaited
    const sync = app.http.inflight === 0
    const fast = await wire(await pending)
    await sleep(10)
    expect(app.http.inflight).toBe(0)
    const off = app.app.hooks.on('http:request', () => undefined)
    try {
      const general = await wire(await handler(request(sent)))
      await sleep(10)
      expect(app.http.inflight).toBe(0)
      return { fast, general, sync }
    } finally {
      off()
    }
  }

  const CASES: readonly (readonly [string, Sent, string, boolean])[] = [
    // [label, request, route path, served synchronously]
    ['a plain object', { url: '/object' }, '/object', true],
    ['an array', { url: '/array' }, '/array', true],
    ['non-ASCII JSON', { url: '/unicode' }, '/unicode', true],
    ['a decoded parameter', { url: '/users/7' }, '/users/:id', true],
    ['an encoded parameter', { url: '/users/%37' }, '/users/:id', true],
    ['a wildcard and a query', { url: '/files/a/%20b/c?x=1&x=2' }, '/files/*', true],
    ['toJSON', { url: '/to-json' }, '/to-json', true],
    ['@HttpCode', { url: '/status' }, '/status', true],
    ['an incoming request id', { url: '/object', headers: { 'x-request-id': 'abc-123' } }, '/object', true],
    ['a malformed parameter (400)', { url: '/users/%E0%A4%A' }, '/users/:id', false],
    ['an encoded slash in a parameter', { url: '/users/7%2F8' }, '/users/:id', true],
    ['an empty parameter', { url: '/users/' }, '/users/:id', false],
    ['a trailing slash', { url: '/users/7/' }, '/users/:id', false],
    ['a double slash', { url: '//users/7' }, '/users/:id', false],
    ['another static segment', { url: '/usersx/7' }, '/users/:id', false],
    ['an empty wildcard', { url: '/files/' }, '/files/*', true],
    ['a malformed wildcard (400)', { url: '/files/%zz' }, '/files/*', false],
    ['an unmatched path (Hono normalisation)', { url: '/users/7/extra' }, '/users/:id', false],
    ['a thrown HttpException', { url: '/users/101' }, '/users/:id', false],
    ['toJSON returning undefined (500)', { url: '/to-json-undefined' }, '/to-json-undefined', false],
    ['a BigInt (500)', { url: '/bigint' }, '/bigint', false],
    ['a string', { url: '/string' }, '/string', false],
    ['undefined (204)', { url: '/undefined' }, '/undefined', true],
    ['undefined from a POST route (201)', { method: 'POST', url: '/nothing' }, '/nothing', true],
    ['undefined with @HttpCode(200)', { url: '/empty-ok' }, '/empty-ok', true],
    ['undefined with @HttpCode(204)', { url: '/empty-no-content' }, '/empty-no-content', true],
    ['null', { url: '/null' }, '/null', false],
    ['a number', { url: '/number' }, '/number', false],
    ['a class instance', { url: '/instance' }, '/instance', false],
    ['a prototype-less record', { url: '/null-proto' }, '/null-proto', false],
    ['an object with its own constructor', { url: '/own-constructor' }, '/own-constructor', false],
    ['an object with a pipe() method', { url: '/pipe-like' }, '/pipe-like', false],
    ['bytes', { url: '/bytes' }, '/bytes', false],
    ['a stream', { url: '/stream' }, '/stream', false],
    ['an HttpResponse with headers and cookies', { url: '/http-response' }, '/http-response', false],
    ['a Web Response', { url: '/web-response' }, '/web-response', false],
    ['a thrown error (400)', { url: '/thrown' }, '/thrown', false],
    ['an unexpected error (500)', { url: '/unexpected' }, '/unexpected', false],
    ['an error mapped by an exception mapper', { url: '/mapped' }, '/mapped', false],
    ['an async handler', { url: '/promise' }, '/promise', false],
    ['a rejected promise', { url: '/rejected' }, '/rejected', false],
    ['a promised HttpResponse', { url: '/promised-response' }, '/promised-response', false],
    ['a thenable', { url: '/thenable' }, '/thenable', false],
    ['a header set on the context', { url: '/set-header' }, '/set-header', false],
    ['an invalid header set on the context (500)', { url: '/bad-header' }, '/bad-header', false],
    ['a cookie set on the context', { url: '/set-cookie' }, '/set-cookie', false],
    ['@HttpCode(204) (general pipeline)', { url: '/no-content' }, '/no-content', false],
    ['@Header (general pipeline)', { url: '/with-header' }, '/with-header', false],
    ['HEAD of a GET route (general pipeline)', { method: 'HEAD', url: '/object' }, '/object', false],
    // the scope holds an instance: the request is over once it was disposed (asynchronously)
    ['a request-scoped controller', { url: '/per-request' }, '/per-request', false],
    [
      'a JSON body',
      { method: 'POST', url: '/create', headers: { 'content-type': 'application/json' }, body: '{"name":"Ada"}' },
      '/create',
      false,
    ],
    [
      'a malformed JSON body (400)',
      { method: 'POST', url: '/create', headers: { 'content-type': 'application/json' }, body: '{"name":' },
      '/create',
      false,
    ],
    [
      'an asynchronous validation',
      { method: 'POST', url: '/validated', headers: { 'content-type': 'application/json' }, body: '{"name":"Ada"}' },
      '/validated',
      false,
    ],
    [
      'a failed asynchronous validation (400)',
      { method: 'POST', url: '/validated', headers: { 'content-type': 'application/json' }, body: '{}' },
      '/validated',
      false,
    ],
  ]

  for (const [label, sent, path, sync] of CASES) {
    it(`answers ${label} like the general pipeline`, async () => {
      const result = await both(sent, path)
      expect(result.fast).toEqual(result.general)
      expect(result.sync).toBe(sync)
    })
  }

  it('builds the headers of a JSON reply in their final order', async () => {
    const reply = await adapter.handler('GET', '/object')(request({ url: '/object' }))
    expect(Object.keys(reply.headers)).toEqual([
      'content-type',
      'content-length',
      'x-request-id',
      'content-security-policy',
      'x-frame-options',
      'x-content-type-options',
      'referrer-policy',
    ])
    expect(reply.headers['x-request-id']).toMatch(ID)
    expect(reply.text).toBe('{"id":1,"name":"Ada","tags":["a","b"],"nested":{"ok":true}}')
    expect(reply.headers['content-length']).toBe(String(reply.text?.length))
  })

  it('runs the handler in the request scope, continuations included, and disposes its instances', async () => {
    disposed.length = 0
    const result = await both({ url: '/scope' }, '/scope')
    expect(result.fast).toEqual(result.general)
    expect(seen).toMatchObject({ sameContext: true, requestId: true, sameScoped: true, microtask: true })
    expect(disposed).toEqual(['sync', 'sync'])
  })

  it('keeps the request in flight until its request-scoped instances are disposed', async () => {
    disposed.length = 0
    const handler = adapter.handler('GET', '/slow-dispose')
    const reply = await handler(request({ url: '/slow-dispose' }))
    expect(reply.status).toBe(200)
    expect(app.http.inflight).toBe(1)
    await sleep(20)
    expect(disposed).toEqual(['async'])
    expect(app.http.inflight).toBe(0)
  })

  it('logs a disposal failure without failing the reply', async () => {
    const result = await both({ url: '/failed-dispose' }, '/failed-dispose')
    expect(result.fast).toEqual(result.general)
    const failures = app.logger.entries.filter(entry => entry.message === 'Failed to dispose request-scoped providers')
    expect(failures).toHaveLength(2)
  })

  it('emits the event to a listener registered while the handler runs', async () => {
    delete seen['listened']
    await adapter.handler('GET', '/listen')(request({ url: '/listen' }))
    expect(seen['listened']).toBe('/listen 200')
  })
})

describe('fast lane options', () => {
  async function reply(
    options: Parameters<typeof createApp>[1],
    sent: Sent = { url: '/object' },
  ): Promise<AdapterReply> {
    const adapter = new RecordingAdapter()
    const app = await createApp(META, { adapter, ...options }, { start: false })
    try {
      return await adapter.handler('GET', '/object')(request(sent))
    } finally {
      await app.stop()
    }
  }

  it('applies the securityHeaders and requestIdHeader options', async () => {
    const custom = await reply({ securityHeaders: false, requestIdHeader: 'x-trace' })
    expect(Object.keys(custom.headers)).toEqual(['content-type', 'content-length', 'x-trace'])
    const none = await reply({
      securityHeaders: { frameOptions: false, cacheControl: 'no-store' },
      requestIdHeader: false,
    })
    expect(Object.keys(none.headers)).toEqual([
      'content-type',
      'content-length',
      'content-security-policy',
      'x-content-type-options',
      'referrer-policy',
      'cache-control',
    ])
  })

  it('uses a custom generator, and leaves out an id that cannot be sent', async () => {
    let next = 0
    const counted = await reply({ generateRequestId: () => `id-${++next}` })
    expect(counted.headers['x-request-id']).toBe('id-1')
    const invalid = await reply({ generateRequestId: () => 'bad\nid' })
    expect(invalid.headers['x-request-id']).toBeUndefined()
    expect(invalid.status).toBe(200)
  })

  it('keeps a request id header named like a security header', async () => {
    const shadowing = await reply({ requestIdHeader: 'x-frame-options' }, { url: '/object' })
    expect(shadowing.headers['x-frame-options']).toMatch(ID)
  })

  it('asks the client to close the connection when the server started draining during the request', async () => {
    const adapter = new RecordingAdapter()
    const app = await createApp(META, { adapter })
    const handler = adapter.handler('POST', '/validated')
    const pending = handler(
      request({
        method: 'POST',
        url: '/validated',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"Ada"}',
      }),
    )
    const stopped = app.stop()
    const reply = await pending
    await stopped
    expect(reply.status).toBe(201)
    expect(reply.headers['connection']).toBe('close')
    expect(Object.keys(reply.headers).at(-1)).toBe('connection')
  })

  it('takes the general pipeline with CORS on', async () => {
    const cors = await reply({ cors: { origin: '*' } }, { url: '/object', headers: { origin: 'https://a.example' } })
    expect(cors.headers['access-control-allow-origin']).toBe('*')
  })
})

describe('randomRequestId()', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  function check(ids: readonly string[]): void {
    for (const id of ids) expect(id).toMatch(UUID)
    expect(new Set(ids).size).toBe(ids.length)
    // every hexadecimal digit shows up in the random positions
    expect(new Set(ids.join('').replaceAll('-', '')).size).toBe(16)
  }

  it('generates distinct version 4 UUIDs (Bun: crypto.randomUUID())', () => {
    check(Array.from({ length: 1000 }, () => randomRequestId()))
  })

  it('generates distinct version 4 UUIDs on Node.js, across refills of its pool of random bytes', async () => {
    const source = new URL('../src/pipeline.ts', import.meta.url).href
    const script = `const { randomRequestId } = await import(${JSON.stringify(source)}); console.log(JSON.stringify(Array.from({ length: 1000 }, () => randomRequestId())))`
    const child = Bun.spawn(['node', '--conditions=@znight/source', '--input-type=module', '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(code).toBe(0)
    check(JSON.parse(stdout) as string[])
  })
})
