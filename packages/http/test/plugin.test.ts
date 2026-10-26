import type { HttpContext, HttpPluginOptions } from '../src/index.ts'

import { Application, type Container, ErrorCode, silentLogger, ZnightError, type ZnightMetadata } from '@znight/core'

import { nodeAdapter } from '../src/adapters/node.ts'
import { ConflictException, coerce, HttpPlugin, HttpResponse, HttpTokens } from '../src/index.ts'
import { ADAPTERS, caught, controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class UsersController {
  list() {
    return ['ada']
  }
  get(id: number) {
    return { id }
  }
  route(ctx: HttpContext) {
    return { path: ctx.route?.path, url: ctx.url }
  }
}

function usersMetadata(extraRoutes: Parameters<typeof controller>[2] = []): ZnightMetadata {
  return metadata({ [t('UsersController')]: provider(UsersController) }, [
    controller(t('UsersController'), '/users', [
      route('list', '/', (c: UsersController) => c.list()),
      route('get', '/:id', (c: UsersController, ctx) => c.get(coerce.number(ctx.params['id'], 'param "id"'))),
      route('route', '/:id/route', (c: UsersController, ctx) => c.route(ctx)),
      ...extraRoutes,
    ]),
  ])
}

async function bootError(meta: ZnightMetadata, options: HttpPluginOptions = {}): Promise<ZnightError> {
  const error = await caught(() =>
    Application.create({
      metadata: meta,
      plugins: [HttpPlugin.configure({ port: 0, ...options })],
      logger: silentLogger,
      shutdown: { signals: false },
    }),
  )
  expect(error).toBeInstanceOf(ZnightError)
  return error as ZnightError
}

describe('HttpPlugin options', () => {
  it.each([
    [{ port: -1 }, 'option "port" must be an integer between 0 and 65535 (received -1)'],
    [{ port: 1.5 }, 'option "port"'],
    [{ port: '80' as never }, 'option "port"'],
    [{ host: '' }, 'option "host"'],
    [{ prefix: '/:version' }, 'option "prefix" must be a static path'],
    [{ prefix: '/a b' }, 'option "prefix" must be a valid static path'],
    [{ prefix: 1 as never }, 'option "prefix" must be a string'],
    [{ trailingSlash: 'loose' as never }, 'option "trailingSlash"'],
    [{ bodyLimit: -1 }, 'option "bodyLimit"'],
    [{ drainTimeoutMs: Number.NaN }, 'option "drainTimeoutMs"'],
    [{ requestIdHeader: 'bad header' }, 'option "requestIdHeader"'],
    [{ generateRequestId: 'uuid' as never }, 'option "generateRequestId"'],
    [{ adapter: {} as never }, 'option "adapter"'],
    [{ guards: 'AuthGuard' as never }, 'option "guards" must be an array'],
    [{ guards: [{}] as never }, 'option "guards" must be classes or objects with a canActivate() method'],
    [{ interceptors: [42] as never }, 'option "interceptors"'],
    [{ exceptionMappers: [{ catch() {} }] as never }, 'option "exceptionMappers"'],
  ])('rejects %p', async (options, message) => {
    const error = await bootError(usersMetadata(), options as HttpPluginOptions)
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
    expect(error.message).toContain(message)
  })

  it('rejects null options', async () => {
    const error = await caught(() =>
      Application.create({
        metadata: usersMetadata(),
        plugins: [HttpPlugin.configure(null as never)],
        logger: silentLogger,
        shutdown: { signals: false },
      }),
    )
    expect((error as Error).message).toContain('option "options" must be an object')
  })

  it('evaluates the function form once, with the container', async () => {
    const calls: Container[] = []
    const app = await Application.create({
      metadata: usersMetadata(),
      plugins: [
        HttpPlugin.configure(container => {
          calls.push(container)
          return { port: 0, prefix: '/api', guards: [{ canActivate: () => true }] }
        }),
      ],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    expect(calls).toEqual([app.container])
    const http = app.getPlugin<HttpPlugin>('http') as HttpPlugin
    expect((await http.inject({ method: 'GET', url: '/api/users' })).json()).toEqual(['ada'])
    await app.stop()
  })

  it('reports global guard classes that are not providers', async () => {
    class NotAProvider {
      canActivate(): boolean {
        return true
      }
    }
    const error = await bootError(usersMetadata(), { guards: [NotAProvider] })
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('the global guard NotAProvider is not a provider')
  })
})

describe('bootstrap errors', () => {
  it('reports invalid route paths (ZNIGHT007)', async () => {
    const error = await bootError(usersMetadata([route('list', '/a//b', (c: UsersController) => c.list())]))
    expect(error.code).toBe(ErrorCode.InvalidRoute)
    expect(error.message).toBe('ZNIGHT007: Invalid route GET /users/a//b (UsersController.list): empty segment ("//")')
  })

  it('reports duplicate routes (ZNIGHT007)', async () => {
    const error = await bootError(usersMetadata([route('other', '/:name', (c: UsersController) => c.list())]))
    expect(error.code).toBe(ErrorCode.InvalidRoute)
    expect(error.message).toBe(
      'ZNIGHT007: Duplicate route GET /users/:name: UsersController.other conflicts with UsersController.get (/users/:id)',
    )
  })

  it('reports duplicate @All routes', async () => {
    const error = await bootError(
      usersMetadata([
        route('a', '/any/:x', (c: UsersController) => c.list(), { method: 'ALL' }),
        route('b', '/any/:y', (c: UsersController) => c.list(), { method: 'ALL' }),
      ]),
    )
    expect(error.message).toContain('Duplicate route GET /users/any/:y')
  })

  it('reports invalid statuses, methods and definitions', async () => {
    expect((await bootError(usersMetadata([route('x', '/x', () => 1, { status: 99 })]))).message).toContain(
      '@HttpCode(99) is not a valid status',
    )
    expect(
      (await bootError(usersMetadata([route('x', '/x', () => 1, { method: 'TRACE' as never })]))).message,
    ).toContain('unknown method "TRACE"')
    expect(
      (await bootError(usersMetadata([{ ...route('x', '/x', () => 1), invoke: undefined as never }]))).message,
    ).toContain('missing handler or invoke()')
    expect(
      (await bootError(usersMetadata([{ ...route('x', '/x', () => 1), params: undefined as never }]))).message,
    ).toContain('must be arrays')
  })

  it('reports invalid http metadata', async () => {
    const meta = { ...usersMetadata(), extensions: { http: { controllers: 'nope' } } } as unknown as ZnightMetadata
    expect((await bootError(meta)).message).toContain('Invalid metadata.extensions.http')
    const badController = { ...usersMetadata(), extensions: { http: { controllers: [{ token: 1 }] } } } as never
    expect((await bootError(badController)).message).toContain('Invalid controller definition')
  })

  it('reports controllers and guards that are not providers (ZNIGHT001)', async () => {
    const missingController = metadata({}, [controller(t('Ghost'), '/', [route('x', '/', () => 1)])])
    const error = await bootError(missingController)
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('the controller Ghost (src/app.ts#Ghost) is not a provider')
    const missingGuard = usersMetadata([route('x', '/x', () => 1, { guards: [t('Ghost')] })])
    expect((await bootError(missingGuard)).message).toContain('the guard of UsersController.x')
  })

  it('serves only 404s without http metadata', async () => {
    const meta: ZnightMetadata = { version: 1, providers: {}, resolutionOrder: [] }
    const app = await createApp(meta, {}, { start: false })
    expect(app.http.routes).toEqual([])
    expect((await app.http.inject({ method: 'GET', url: '/' })).status).toBe(404)
    await app.stop()
  })
})

describe('plugin API', () => {
  it('is named "http" and is injectable', async () => {
    class NeedsHttp {
      readonly http: HttpPlugin
      constructor(http: HttpPlugin) {
        this.http = http
      }
    }
    const meta = metadata(
      { [t('NeedsHttp')]: provider(NeedsHttp, [HttpTokens.Plugin]) },
      [],
      [{ token: HttpTokens.Plugin, providedBy: 'HttpPlugin' }],
    )
    const app = await createApp(meta, {}, { start: false })
    expect(app.http.name).toBe('http')
    expect(app.app.get(NeedsHttp).http).toBe(app.http)
    expect(app.app.get(HttpPlugin)).toBe(app.http)
    expect(app.app.getPlugin('http')).toBe(app.http)
    await app.stop()
  })

  it('lists routes (HEAD first, then most specific first)', async () => {
    const app = await createApp(usersMetadata(), {}, { start: false })
    expect(app.http.routes.map(r => `${r.method} ${r.path} ${r.controller}.${r.handler}`)).toEqual([
      'HEAD /users UsersController.list',
      'HEAD /users/:id UsersController.get',
      'HEAD /users/:id/route UsersController.route',
      'GET /users UsersController.list',
      'GET /users/:id UsersController.get',
      'GET /users/:id/route UsersController.route',
    ])
    await app.stop()
  })

  it('injects without listening and exposes the address only while listening', async () => {
    const app = await createApp(usersMetadata(), {}, { start: false })
    expect(app.http.address).toBeUndefined()
    expect(app.http.adapter.name).toBe('node')
    expect((await app.http.inject({ method: 'GET', url: '/users/1' })).json()).toEqual({ id: 1 })
    await app.app.start()
    const address = app.http.address
    expect(address?.port).toBeGreaterThan(0)
    expect(address?.host).toBe('127.0.0.1')
    expect(address?.family).toBe('IPv4')
    expect(String(address)).toBe(`http://127.0.0.1:${address?.port}`)
    expect(`${address}`).toBe(address?.url as string)
    expect(await (await fetch(new URL('/users/2', String(address)))).json()).toEqual({ id: 2 })
    await app.stop()
    expect(app.http.address).toBeUndefined()
    const error = await caught(() => app.http.inject({ method: 'GET', url: '/users/1' }))
    expect((error as Error).message).toContain('cannot use inject() after the application stopped')
  })

  it('cannot be used before the application is created', async () => {
    const http = HttpPlugin.configure()
    const error = await caught(() => http.inject({ method: 'GET', url: '/' }))
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as Error).message).toContain('only available once the application is created')
    expect(() => http.adapter).toThrow(ZnightError)
    expect(http.routes).toEqual([])
    expect(http.inflight).toBe(0)
  })

  it('validates inject requests', async () => {
    const app = await createApp(usersMetadata(), {}, { start: false })
    expect(await caught(() => app.http.inject({ method: 'GET', url: 'users' }))).toBeInstanceOf(TypeError)
    expect(await caught(() => app.http.inject(null as never))).toBeInstanceOf(TypeError)
    await app.stop()
  })

  it('fails to start when the port is taken', async () => {
    const first = await createApp(usersMetadata())
    const port = first.http.address?.port as number
    const second = await createApp(usersMetadata(), { port }, { start: false })
    const error = (await caught(() => second.app.start())) as ZnightError
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect((error.cause as NodeJS.ErrnoException).code).toBe('EADDRINUSE')
    expect(second.app.state).toBe('failed')
    await first.stop()
  })
})

describe('prefix and trailing slashes', () => {
  it('prefixes every route', async () => {
    const app = await createApp(usersMetadata(), { prefix: 'api/v1/' }, { start: false })
    expect((await app.http.inject({ method: 'GET', url: '/api/v1/users/1' })).json()).toEqual({ id: 1 })
    expect((await app.http.inject({ method: 'GET', url: '/users/1' })).status).toBe(404)
    expect((await app.http.inject({ method: 'GET', url: '/api/v1/users/1/route?a=1' })).json()).toEqual({
      path: '/api/v1/users/:id/route',
      url: '/api/v1/users/1/route?a=1',
    })
    await app.stop()
  })

  for (const adapter of ADAPTERS) {
    describe(`${adapter.name} adapter`, () => {
      const meta = (): ZnightMetadata =>
        usersMetadata([route('files', '/files/*', (_c, ctx) => ({ rest: ctx.params['*'] }))])

      it('ignores trailing slashes with "ignore"', async () => {
        const app = await createApp(meta(), { adapter: adapter.create(), trailingSlash: 'ignore' }, { start: false })
        const send = (url: string) => app.http.inject({ method: 'GET', url })
        expect((await send('/users/')).json()).toEqual(['ada'])
        expect((await send('/users')).json()).toEqual(['ada'])
        expect((await send('/users/7/')).json()).toEqual({ id: 7 })
        expect((await send('/users/files/a/')).json()).toEqual({ rest: 'a/' })
        expect((await send('/users//')).status).toBe(404)
        expect((await app.http.inject({ method: 'HEAD', url: '/users/7/' })).status).toBe(200)
        await app.stop()
      })

      it('redirects with "redirect"', async () => {
        const app = await createApp(meta(), { adapter: adapter.create(), trailingSlash: 'redirect' }, { start: false })
        const res = await app.http.inject({ method: 'GET', url: '/users/7/?a=1&b=2' })
        expect(res.status).toBe(308)
        expect(res.headers.location).toBe('/users/7?a=1&b=2')
        expect(res.body).toBe('')
        const post = await app.http.inject({ method: 'GET', url: '/users/' })
        expect(post.headers.location).toBe('/users')
        expect((await app.http.inject({ method: 'GET', url: '/users/7' })).status).toBe(200)
        await app.stop()
      })

      it('is strict by default', async () => {
        const app = await createApp(meta(), { adapter: adapter.create() }, { start: false })
        expect((await app.http.inject({ method: 'GET', url: '/users/' })).status).toBe(404)
        expect((await app.http.inject({ method: 'GET', url: '/users/1/route/' })).status).toBe(404)
        await app.stop()
      })
    })
  }
})

describe('request ids, errors and hooks', () => {
  it('exposes error messages with exposeErrors', async () => {
    const meta = usersMetadata([
      route('boom', '/boom', () => {
        throw new Error('visible')
      }),
    ])
    const app = await createApp(meta, { exposeErrors: true }, { start: false })
    expect((await app.http.inject({ method: 'GET', url: '/users/boom' })).json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'visible',
    })
    await app.stop()
  })

  it('keeps the error status for mapped responses without status', async () => {
    const meta = usersMetadata([
      route(
        'conflict',
        '/conflict',
        () => {
          throw new ConflictException('taken')
        },
        { method: 'POST' },
      ),
      route(
        'crash',
        '/crash',
        () => {
          throw new Error('crash')
        },
        { method: 'POST' },
      ),
    ])
    const app = await createApp(
      meta,
      { exceptionMappers: [{ map: (error: unknown) => new HttpResponse({ wrapped: (error as Error).message }) }] },
      { start: false },
    )
    const conflict = await app.http.inject({ method: 'POST', url: '/users/conflict' })
    expect(conflict.status).toBe(409)
    expect(conflict.json()).toEqual({ wrapped: 'taken' })
    const crash = await app.http.inject({ method: 'POST', url: '/users/crash' })
    expect(crash.status).toBe(500)
    expect(crash.json()).toEqual({ wrapped: 'crash' })
    await app.stop()
  })

  it('uses a custom request id header and generator', async () => {
    let next = 0
    const app = await createApp(
      usersMetadata(),
      { requestIdHeader: 'X-Correlation-Id', generateRequestId: () => `id-${++next}` },
      { start: false },
    )
    const generated = await app.http.inject({ method: 'GET', url: '/users' })
    expect(generated.headers['x-correlation-id']).toBe('id-1')
    expect(generated.headers['x-request-id']).toBeUndefined()
    const reused = await app.http.inject({ method: 'GET', url: '/users', headers: { 'x-correlation-id': 'abc' } })
    expect(reused.headers['x-correlation-id']).toBe('abc')
    await app.stop()
  })

  it('never reads nor echoes request ids with requestIdHeader: false', async () => {
    const app = await createApp(usersMetadata(), { requestIdHeader: false }, { start: false })
    const res = await app.http.inject({ method: 'GET', url: '/users', headers: { 'x-request-id': 'abc' } })
    expect(res.headers['x-request-id']).toBeUndefined()
    await app.stop()
  })

  it('answers 500 when a hook wrapper does not call next() or fails before it', async () => {
    const app = await createApp(usersMetadata(), {}, { start: false })
    const statuses: (number | undefined)[] = []
    app.app.hooks.on('http:request', event => {
      statuses.push(event.status)
    })
    const remove = app.app.hooks.wrap('http:request', async () => undefined)
    expect((await app.http.inject({ method: 'GET', url: '/users' })).status).toBe(500)
    remove()
    const removeFailing = app.app.hooks.wrap('http:request', () => Promise.reject(new Error('wrapper bug')))
    const failing = await app.http.inject({ method: 'GET', url: '/users' })
    expect(failing.status).toBe(500)
    removeFailing()
    expect(statuses).toEqual([500, 500])
    expect(
      app.logger.entries.some(entry => (entry.context?.['err'] as Error | undefined)?.message === 'wrapper bug'),
    ).toBe(true)
    await app.stop()
  })

  it('keeps the response when a hook wrapper fails after next()', async () => {
    const app = await createApp(usersMetadata(), {}, { start: false })
    app.app.hooks.wrap('http:request', async (_event, next) => {
      await next()
      throw new Error('late wrapper bug')
    })
    expect((await app.http.inject({ method: 'GET', url: '/users/3' })).json()).toEqual({ id: 3 })
    expect(app.logger.entries.some(entry => entry.message.includes('failed after the request was handled'))).toBe(true)
    await app.stop()
  })

  it('logs disposal failures of request-scoped providers without failing the response', async () => {
    class Leaky {
      [Symbol.dispose](): void {
        throw new Error('cannot dispose')
      }
    }
    class LeakyController {
      readonly leaky: Leaky
      constructor(leaky: Leaky) {
        this.leaky = leaky
      }
      get() {
        return 'ok'
      }
    }
    const meta = metadata(
      {
        [t('Leaky')]: provider(Leaky, [], 'request'),
        [t('LeakyController')]: provider(LeakyController, [t('Leaky')], 'request'),
      },
      [controller(t('LeakyController'), '/', [route('get', '/', (c: LeakyController) => c.get())])],
    )
    const app = await createApp(meta, {}, { start: false })
    const res = await app.http.inject({ method: 'GET', url: '/' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('ok')
    expect(app.logger.entries.some(entry => entry.message === 'Failed to dispose request-scoped providers')).toBe(true)
    await app.stop()
  })

  it('denies requests when a guard does not return true', async () => {
    const meta = usersMetadata()
    const app = await createApp(meta, { guards: [{ canActivate: () => undefined as never }] }, { start: false })
    expect((await app.http.inject({ method: 'GET', url: '/users' })).status).toBe(403)
    await app.stop()
  })

  it('serves @All routes with the default 200 and HEAD without body', async () => {
    const app = await createApp(
      usersMetadata([route('any', '/any', (_c, ctx) => ({ method: ctx.method }), { method: 'ALL' })]),
      {},
      { start: false },
    )
    const post = await app.http.inject({ method: 'POST', url: '/users/any' })
    expect(post.status).toBe(200)
    expect(post.json()).toEqual({ method: 'POST' })
    const head = await app.http.inject({ method: 'HEAD', url: '/users/any' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    const options = await app.http.inject({ method: 'OPTIONS', url: '/users/any' })
    expect(options.json()).toEqual({ method: 'OPTIONS' })
    await app.stop()
  })

  it('uses the built-in node adapter by default', async () => {
    const app = await createApp(usersMetadata(), { adapter: nodeAdapter() }, { start: false })
    expect(app.http.adapter.name).toBe('node')
    await app.stop()
  })
})
