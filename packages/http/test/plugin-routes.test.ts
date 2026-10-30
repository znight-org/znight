/**
 * Plugin routes and `HttpPlugin.prefix` (RFC 0002 H1, H2): validation, conflicts, guards,
 * interceptors and the boot check of route decisions.
 */
import type { Plugin } from '@znight/core'
import type { CanActivate, HttpContext, HttpInterceptor, HttpPluginOptions, PluginRoute } from '../src/index.ts'

import { Application, ErrorCode, silentLogger, ZnightError, type ZnightMetadata } from '@znight/core'

import { createRouteDecorator, HttpPlugin } from '../src/index.ts'
import { caught, controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const Public = createRouteDecorator('public', { group: 'access', required: true })
const Roles = createRouteDecorator<readonly string[]>('roles', { group: 'access', required: true })

class AccessGuard implements CanActivate {
  static readonly enforces = [Public, Roles]
  canActivate(ctx: HttpContext): boolean {
    return Public.get(ctx) === true || ctx.header('x-role') === 'admin'
  }
}

class HomeController {
  home() {
    return 'home'
  }
}

/** A plugin returning the given routes. */
function routesPlugin(name: string, routes: unknown): Plugin & { httpRoutes(): readonly PluginRoute[] } {
  return { name, httpRoutes: () => routes as readonly PluginRoute[] }
}

function homeMetadata(): ZnightMetadata {
  return metadata({ [t('HomeController')]: provider(HomeController), [t('AccessGuard')]: provider(AccessGuard) }, [
    controller(t('HomeController'), '/', [route('home', '/docs', (c: HomeController) => c.home())], {
      meta: { public: true },
    }),
  ])
}

async function bootError(plugins: readonly Plugin[], options: HttpPluginOptions = {}): Promise<ZnightError> {
  const error = await caught(() => createApp(homeMetadata(), options, { start: false, plugins }))
  expect(error).toBeInstanceOf(ZnightError)
  return error as ZnightError
}

const docs: PluginRoute = {
  method: 'GET',
  path: '/openapi.json',
  name: 'document',
  handler: () => ({ openapi: '3.1.1' }),
}

describe('plugin routes', () => {
  it.each([
    ['not an array', { routes: 'x' }, 'httpRoutes() must return an array of routes'],
    ['a route that is not an object', [42], 'invalid route 42'],
    ['a route without name', [{ ...docs, name: '' }], 'the route GET /openapi.json needs a name'],
    [
      'an unknown method',
      [{ ...docs, method: 'FETCH' }],
      'unknown method "FETCH" of the route FETCH /openapi.json (document)',
    ],
    ['a route without handler', [{ ...docs, handler: 'x' }], 'has no handler function'],
    ['a route without path', [{ ...docs, path: undefined }], 'has no path'],
    ['an invalid path', [{ ...docs, path: '/a//b' }], 'invalid path of the route GET /a//b (document): empty segment'],
    ['an invalid meta', [{ ...docs, meta: {} }], 'the meta of the route GET /openapi.json (document) must be an array'],
    ['an invalid meta entry', [{ ...docs, meta: [{ value: 1 }] }], 'invalid meta entry {"value":1}'],
    [
      'an invalid group',
      [{ ...docs, meta: [{ key: 'a', value: 1, group: '1' }] }],
      'invalid group of the meta entry "a"',
    ],
    [
      'two decisions of one group',
      [{ ...docs, meta: [Public.meta(), Roles.meta(['admin'])] }],
      'two entries of the "access" group (public, roles)',
    ],
    [
      'invalid guards',
      [{ ...docs, guards: 'x' }],
      'the guards of the route GET /openapi.json (document) must be an array',
    ],
  ])('rejects %s (ZNIGHT007 naming the plugin)', async (_, routes, message) => {
    const plugin = routesPlugin('openapi', (routes as { routes?: unknown }).routes ?? routes)
    const error = await bootError([plugin], { guards: [AccessGuard] })
    expect(error.code).toBe(ErrorCode.InvalidRoute)
    expect(error.message).toContain('HttpPlugin: plugin "openapi": ')
    expect(error.message).toContain(message)
  })

  it('rejects a guard that is not a guard', async () => {
    const error = await bootError([routesPlugin('openapi', [{ ...docs, meta: [Public.meta()], guards: [{}] }])], {
      guards: [AccessGuard],
    })
    expect(error.code).toBe(ErrorCode.InvalidRoute)
    expect(error.message).toContain('the guards of the route GET /openapi.json (document) must be classes or objects')
  })

  it('reports a collision with a controller route (ZNIGHT007 naming the plugin)', async () => {
    const plugin = routesPlugin('openapi', [{ ...docs, path: '/docs', meta: [Public.meta()] }])
    const error = await bootError([plugin], { guards: [AccessGuard] })
    expect(error.code).toBe(ErrorCode.InvalidRoute)
    expect(error.message).toBe(
      'ZNIGHT007: Duplicate route GET /docs: plugin "openapi" (document) conflicts with HomeController.home (/docs)',
    )
    expect(error.hints).toContain('Change the path of the route in the options of the plugin "openapi"')
  })

  it('reports a route without decision of a required group, naming the plugin', async () => {
    const error = await bootError([routesPlugin('openapi', [docs])], { guards: [AccessGuard] })
    expect(error.code).toBe(ErrorCode.MissingRouteDecision)
    expect(error.message).toBe(
      'ZNIGHT023: HttpPlugin: 1 route has no "access" decision: GET /openapi.json (plugin "openapi" (document))',
    )
    expect(error.hints).toContain(
      'Routes of the plugin "openapi" take their metadata from its options: meta: [Decorator.meta()]',
    )
  })

  it('accepts meta entries of decorators whose key is not a group name (their own group)', async () => {
    const Legacy = createRouteDecorator('auth:public')
    const plugin = routesPlugin('openapi', [{ ...docs, meta: [Public.meta(), Legacy.meta()] }])
    const app = await createApp(homeMetadata(), { guards: [AccessGuard] }, { start: false, plugins: [plugin] })
    try {
      const summary = app.http.routes.find(entry => entry.path === '/openapi.json' && entry.method === 'GET')
      expect(summary?.meta).toEqual({ public: true, 'auth:public': true })
    } finally {
      await app.stop()
    }
  })

  it('reports contradicting group declarations (ZNIGHT005)', async () => {
    const Other = createRouteDecorator('public', { group: 'visibility' })
    const error = await bootError([routesPlugin('openapi', [{ ...docs, meta: [Other.meta()] }])], {
      guards: [AccessGuard],
    })
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
    expect(error.message).toContain(
      'the route decorator "public" is declared with the group "access" (required) by the guard AccessGuard but with the group "visibility" by the plugin "openapi"',
    )
  })

  it('runs global and route guards (classes and instances), never global interceptors', async () => {
    const calls: string[] = []
    class Wrap implements HttpInterceptor {
      async intercept(_ctx: HttpContext, next: () => Promise<unknown>) {
        calls.push('interceptor')
        return { wrapped: await next() }
      }
    }
    const deny: CanActivate = {
      canActivate: ctx => {
        calls.push('route guard')
        return ctx.header('x-pass') === '1'
      },
    }
    const plugin = routesPlugin('openapi', [{ ...docs, meta: [Roles.meta(['admin'])], guards: [deny] }])
    const app = await createApp(
      homeMetadata(),
      { guards: [AccessGuard], interceptors: [new Wrap()] },
      {
        start: false,
        plugins: [plugin],
      },
    )
    try {
      expect((await app.http.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(403)
      const ok = await app.http.inject({
        method: 'GET',
        url: '/openapi.json',
        headers: { 'x-role': 'admin', 'x-pass': '1' },
      })
      expect(ok.status).toBe(200)
      expect(ok.json()).toEqual({ openapi: '3.1.1' })
      expect(calls).toEqual(['route guard'])
      expect((await app.http.inject({ method: 'GET', url: '/docs' })).json()).toEqual({ wrapped: 'home' })
      const summary = app.http.routes.find(entry => entry.path === '/openapi.json' && entry.method === 'GET')
      expect(summary?.guards).toEqual(['AccessGuard', 'guard instance'])
    } finally {
      await app.stop()
    }
  })

  it('maps handler errors like controller errors', async () => {
    const plugin = routesPlugin('openapi', [
      {
        ...docs,
        meta: [Public.meta()],
        handler: () => {
          throw new Error('not built')
        },
      },
    ])
    const app = await createApp(
      homeMetadata(),
      { guards: [AccessGuard], exposeErrors: true },
      {
        start: false,
        plugins: [plugin],
      },
    )
    try {
      const res = await app.http.inject({ method: 'GET', url: '/openapi.json' })
      expect(res.status).toBe(500)
      expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'not built' })
    } finally {
      await app.stop()
    }
  })

  it('collects the routes after the compiled ones, whatever the plugin order', async () => {
    const plugin = routesPlugin('openapi', [{ ...docs, meta: [Public.meta()] }])
    const http = HttpPlugin.configure({ port: 0, guards: [AccessGuard] })
    const app = await Application.create({
      metadata: homeMetadata(),
      plugins: [plugin, http],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    try {
      expect(http.routes.map(entry => `${entry.method} ${entry.path} ${entry.source}`)).toEqual([
        'HEAD /docs controller',
        'HEAD /openapi.json openapi',
        'GET /docs controller',
        'GET /openapi.json openapi',
      ])
    } finally {
      await app.stop()
    }
  })
})

describe('HttpPlugin.prefix', () => {
  it('is readable before the application with plain options', () => {
    expect(HttpPlugin.configure({ prefix: '/api/' }).prefix).toBe('/api')
    expect(HttpPlugin.configure().prefix).toBe('')
    expect(HttpPlugin.configure({ prefix: '/' }).prefix).toBe('')
  })

  it('throws the options error for invalid options', () => {
    expect(() => HttpPlugin.configure({ prefix: '/:v' }).prefix).toThrow('option "prefix" must be a static path')
  })

  it('needs the application when the options are a function of the container', () => {
    const http = HttpPlugin.configure(() => ({ prefix: '/v1' }))
    expect(() => http.prefix).toThrow('prefix is only available once the plugin is registered')
  })

  it('is read by another plugin before HttpPlugin bootstraps (options resolved once)', async () => {
    let evaluations = 0
    const seen: string[] = []
    const reader: Plugin = {
      name: 'reader',
      onBootstrap: ctx => {
        seen.push((ctx.getPlugin('http') as HttpPlugin).prefix)
      },
    }
    const http = HttpPlugin.configure(() => {
      evaluations++
      return { port: 0, prefix: '/v1', guards: [AccessGuard] }
    })
    const app = await Application.create({
      metadata: homeMetadata(),
      plugins: [reader, http],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    try {
      expect(seen).toEqual(['/v1'])
      expect(http.prefix).toBe('/v1')
      expect(evaluations).toBe(1)
      expect((await http.inject({ method: 'GET', url: '/v1/docs' })).body).toBe('home')
    } finally {
      await app.stop()
    }
  })
})
