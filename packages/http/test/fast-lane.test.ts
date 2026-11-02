/**
 * The fast lane of the pipeline (`Pipeline.handler`): routes without guards, interceptors, `@Sse`,
 * `@Res()` nor `@Header` are served without the general machinery while the handler stays
 * synchronous. Every reply must be the one of the general pipeline, which every request of an
 * application with a global guard takes: each case is sent to both applications and compared, byte
 * for byte (the request id aside), header order included, without hooks, with an `http:request`
 * listener, and through `http:request` wrappers (what the hooks see of the request included).
 */
import type { HookWrapper, HttpRequestEvent } from '@znight/core'
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

import { AsyncLocalStorage } from 'node:async_hooks'
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

/** Set by the wrappers of the hooked cases, read by the `/als` route. */
const als = new AsyncLocalStorage<string>()

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
  route('headObject', '/head-object', () => ({ dropped: true }), { method: 'HEAD' }),
  route('headNothing', '/head-nothing', () => undefined, { method: 'HEAD' }),
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
  route('als', '/als', () => ({ store: als.getStore() ?? null })),
  // the stream is read after the handler returned: in the async context of the handler
  route('alsStream', '/als-stream', () =>
    HttpResponse.stream(
      (async function* () {
        await Promise.resolve()
        yield `store: ${als.getStore() ?? 'none'}`
      })(),
    ),
  ),
  route('clock', '/clock', () => {
    seen['invokedAt'] = performance.now()
    return { clock: true }
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

/** A guard letting every request through: the routes of an application with it take the general pipeline. */
const ALLOW = { canActivate: () => true }

/** Installs `http:request` hooks on an application, recording what they see; returns their removal. */
type Install = (app: TestApp, log: unknown[]) => () => void

/** What an `http:request` hook sees of a request (request id and start time normalised). */
function snapshot(stage: string, event: HttpRequestEvent): unknown {
  return {
    stage,
    keys: Object.keys(event),
    method: event.method,
    path: event.path,
    route: event.route,
    requestId: ID.test(event.requestId) ? '<id>' : event.requestId,
    headers: event.headers,
    context: (event.context as HttpContext).path,
    startTime: typeof event.startTime === 'number' && event.startTime <= performance.now(),
    status: event.status,
    error: event.error === undefined ? undefined : String(event.error),
    responseHeaders: { ...event.responseHeaders },
  }
}

/** A listener only: the fast lane stays synchronous. */
const LISTENER: Install = (app, log) => app.app.hooks.on('http:request', event => log.push(snapshot('listener', event)))

/** Recording wrappers (one of them running the request in an async context) and a listener. */
const WRAPPED: Install = (app, log) => {
  const container = app.app.container
  const inScope = (event: HttpRequestEvent): boolean =>
    container.currentScope()?.get(HttpTokens.RequestId) === event.requestId
  const offs = [
    app.app.hooks.wrap('http:request', async (event, next) => {
      log.push(snapshot('outer', event), { scope: inScope(event) })
      try {
        return await als.run('wrapped', next)
      } finally {
        log.push(snapshot('outer after', event), { scope: inScope(event), store: als.getStore() ?? null })
      }
    }),
    app.app.hooks.wrap('http:request', (event, next) => {
      log.push(snapshot('inner', event), { store: als.getStore() ?? null })
      return next()
    }),
    LISTENER(app, log),
  ]
  return () => {
    for (const off of offs) off()
  }
}

/** A wrapper adding a response header (like the tracing of `@znight/observability`). */
const DECORATED: Install = app =>
  app.app.hooks.wrap('http:request', async (event, next) => {
    event.responseHeaders['x-wrapped'] = 'yes'
    await next()
  })

describe('fast lane', () => {
  let app: TestApp
  let adapter: RecordingAdapter
  /** The same routes, taking the general pipeline (a global guard). */
  let reference: TestApp
  let referenceAdapter: RecordingAdapter

  beforeAll(async () => {
    adapter = new RecordingAdapter()
    app = await createApp(META, { adapter, exceptionMappers: [mapper] }, { start: false })
    referenceAdapter = new RecordingAdapter()
    reference = await createApp(
      META,
      { adapter: referenceAdapter, exceptionMappers: [mapper], guards: [ALLOW] },
      { start: false },
    )
  })

  afterAll(async () => {
    await app.stop()
    await reference.stop()
  })

  /**
   * The reply of the fast lane and the one of the general pipeline, with the hooks of `install`
   * registered on both applications, and what the hooks saw on each.
   */
  async function both(
    sent: Sent,
    path: string,
    install?: Install,
  ): Promise<{ fast: unknown; general: unknown; sync: boolean; seenFast: unknown[]; seenGeneral: unknown[] }> {
    const seenFast: unknown[] = []
    const seenGeneral: unknown[] = []
    const offs = install === undefined ? [] : [install(app, seenFast), install(reference, seenGeneral)]
    try {
      const pending = adapter.handler(sent.method ?? 'GET', path)(request(sent))
      // only the synchronous fast lane is over before the reply is awaited
      const sync = app.http.inflight === 0
      const fast = await wire(await pending)
      await sleep(10)
      expect(app.http.inflight).toBe(0)
      const general = await wire(await referenceAdapter.handler(sent.method ?? 'GET', path)(request(sent)))
      await sleep(10)
      expect(reference.http.inflight).toBe(0)
      return { fast, general, sync, seenFast, seenGeneral }
    } finally {
      for (const off of offs) off()
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
    // a HEAD reply has no body: an object goes through the general pipeline, `undefined` stays
    ['an object from a @Head route (general pipeline)', { method: 'HEAD', url: '/head-object' }, '/head-object', false],
    ['undefined from a @Head route', { method: 'HEAD', url: '/head-nothing' }, '/head-nothing', true],
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
    ['a handler reading the async context', { url: '/als' }, '/als', true],
    ['a stream reading the async context', { url: '/als-stream' }, '/als-stream', false],
  ]

  const MODES: readonly (readonly [string, Install | undefined])[] = [
    ['', undefined],
    [' with an http:request listener', LISTENER],
    [' through http:request wrappers', WRAPPED],
    [' with a wrapper adding a response header', DECORATED],
  ]

  for (const [mode, install] of MODES) {
    for (const [label, sent, path, sync] of CASES) {
      it(`answers ${label} like the general pipeline${mode}`, async () => {
        const result = await both(sent, path, install)
        expect(result.fast).toEqual(result.general)
        expect(result.seenFast).toEqual(result.seenGeneral)
        // wrappers are asynchronous: only a listener keeps the lane synchronous
        if (install === undefined || install === LISTENER) expect(result.sync).toBe(sync)
      })
    }
  }

  it('runs the wrappers in the request scope, and the handler in their async context', async () => {
    const result = await both({ url: '/als' }, '/als', WRAPPED)
    expect(result.fast).toEqual(result.general)
    expect((result.fast as { body: string }).body).toBe('{"store":"wrapped"}')
    expect(result.seenFast).toContainEqual({ scope: true })
    expect(result.seenFast).toContainEqual({ store: 'wrapped' })
    expect(result.seenFast).toContainEqual({ scope: true, store: null })
    expect(result.seenFast).toEqual(result.seenGeneral)
    const streamed = await both({ url: '/als-stream' }, '/als-stream', WRAPPED)
    expect(streamed.fast).toEqual(streamed.general)
    expect((streamed.fast as { body: string }).body).toBe('store: wrapped')
  })

  it('reads a streamed body in the async context of the wrappers on Node.js', async () => {
    // Bun runs these reads in that context whatever the pipeline captures: check on Node.js
    const core = import.meta.resolve('@znight/core')
    const http = new URL('../src/index.ts', import.meta.url).href
    const script = `
      import { AsyncLocalStorage } from 'node:async_hooks'
      const { Application } = await import(${JSON.stringify(core)})
      const { HttpPlugin, HttpResponse } = await import(${JSON.stringify(http)})
      const als = new AsyncLocalStorage()
      class Api {}
      const routes = []
      const adapter = { name: 'recording', registerRoute: route => routes.push(route), setFallbackHandler() {},
        listen: async () => ({}), close: async () => {}, inject: async () => { throw new Error('no') } }
      const route = { method: 'GET', path: '/s', fullPath: '/s', handler: 's', meta: {}, guards: [], interceptors: [],
        params: [], invoke: () => HttpResponse.stream((async function* () { yield String(als.getStore()) })()) }
      const metadata = { version: 1, compiler: '0.1.0', resolutionOrder: ['src/app.ts#Api'],
        providers: { 'src/app.ts#Api': { scope: 'singleton', class: Api, deps: [], factory: () => new Api() } },
        externals: [{ token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
          { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' }],
        extensions: { http: { controllers: [{ token: 'src/app.ts#Api', basePath: '/', guards: [], interceptors: [],
          meta: {}, routes: [route] }] } } }
      const app = await Application.create({ metadata, plugins: [HttpPlugin.configure({ adapter })], shutdown: { signals: false } })
      app.hooks.wrap('http:request', (_event, next) => als.run('wrapped', next))
      const reply = await routes[0].handler({ method: 'GET', url: '/s', headers: {},
        readBody: async () => new Uint8Array(0), hasBody: () => false })
      console.log(await new Response(reply.body).text())
      await app.stop()
    `
    const child = Bun.spawn(['node', '--conditions=@znight/source', '--input-type=module', '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout.trim()).toBe('wrapped')
  })

  it('gives the listeners the start time of the request', async () => {
    const result = await both({ url: '/clock' }, '/clock', (target, log) =>
      target.app.hooks.on('http:request', event => log.push(event.startTime < (seen['invokedAt'] as number))),
    )
    expect(result.sync).toBe(true)
    expect(result.seenFast).toEqual([true])
    expect(result.seenGeneral).toEqual([true])
  })

  it('gives the hooks the event of the general pipeline', async () => {
    const result = await both({ url: '/users/7?x=1', headers: { 'x-request-id': 'abc-123' } }, '/users/:id', WRAPPED)
    expect(result.seenFast).toEqual(result.seenGeneral)
    expect(result.seenFast.at(-1)).toEqual({
      stage: 'listener',
      keys: ['method', 'path', 'route', 'requestId', 'headers', 'context', 'startTime', 'responseHeaders', 'status'],
      method: 'GET',
      path: '/users/7',
      route: '/users/:id',
      requestId: 'abc-123',
      headers: { host: 'localhost', 'x-request-id': 'abc-123' },
      context: '/users/7',
      startTime: true,
      status: 200,
      error: undefined,
      responseHeaders: {},
    })
  })

  const BEHAVIOURS: readonly (readonly [string, HookWrapper<'http:request'>])[] = [
    [
      'throws before next()',
      () => {
        throw new Error('wrapper failed')
      },
    ],
    ['rejects before next()', () => Promise.reject(new Error('wrapper rejected'))],
    ['does not call next()', async () => undefined],
    [
      'throws after next()',
      async (_event, next) => {
        await next()
        throw new Error('wrapper failed late')
      },
    ],
    [
      'adds an invalid response header',
      async (event, next) => {
        event.responseHeaders['x-bad'] = 'a\r\nb'
        await next()
      },
    ],
    ['returns next() synchronously', (_event, next) => next()],
    [
      'sets a cookie after next()',
      async (event, next) => {
        await next()
        ;(event.context as HttpContext).setCookie('wrapped', '1')
      },
    ],
  ]

  const HOOKED: readonly (readonly [Sent, string])[] = [
    [{ url: '/object' }, '/object'],
    [{ url: '/undefined' }, '/undefined'],
    [{ url: '/unexpected' }, '/unexpected'],
    [{ url: '/promise' }, '/promise'],
    [{ url: '/stream' }, '/stream'],
    [{ url: '/set-cookie' }, '/set-cookie'],
    [{ method: 'POST', url: '/create', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, '/create'],
  ]

  for (const [behaviour, wrapper] of BEHAVIOURS) {
    it(`answers like the general pipeline when an http:request wrapper ${behaviour}`, async () => {
      const install: Install = (target, log) => {
        const offs = [target.app.hooks.wrap('http:request', wrapper), LISTENER(target, log)]
        return () => {
          for (const off of offs) off()
        }
      }
      for (const [sent, path] of HOOKED) {
        const logged = [app.logger.entries.length, reference.logger.entries.length]
        const result = await both(sent, path, install)
        expect({ path, reply: result.fast }).toEqual({ path, reply: result.general })
        expect(result.seenFast).toEqual(result.seenGeneral)
        const messages = (target: TestApp, from: number): string[] =>
          target.logger.entries.slice(from).map(entry => entry.message)
        expect(messages(app, logged[0] as number)).toEqual(messages(reference, logged[1] as number))
      }
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
    for (const target of [app, reference]) {
      const failures = target.logger.entries.filter(
        entry => entry.message === 'Failed to dispose request-scoped providers',
      )
      expect(failures).toHaveLength(1)
    }
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

  it('sends a request id header named like a property of Object.prototype', async () => {
    for (const name of ['constructor', 'tostring', '__proto__']) {
      const named = await reply({ requestIdHeader: name })
      expect(Object.hasOwn(named.headers, name)).toBe(true)
      expect(named.headers[name]).toMatch(ID)
    }
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
