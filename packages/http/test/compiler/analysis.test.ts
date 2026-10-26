/**
 * Analysis of the fixture application (`fixtures/app`): controllers, routes, parameters, guards,
 * interceptors, route metadata; the extension passed explicitly and auto-discovered through the
 * manifest of `@znight/http`.
 */
import type { HttpAnalysis } from './helpers.ts'

import http from '../../src/compiler/index.ts'
import { analyzeApp, cleanupApps, fixtureApp, HTTP_ROOT, render, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

let explicit: HttpAnalysis
let discovered: HttpAnalysis

beforeAll(async () => {
  const app = fixtureApp('app')
  explicit = await analyzeApp(app.root)
  discovered = await analyzeApp(app.root, { discover: true })
})

afterAll(cleanupApps)

describe('extension', () => {
  it('is a valid compiler extension named http', () => {
    expect(http.apiVersion).toBe(1)
    expect(http.name).toBe('http')
    expect(Object.isFrozen(http)).toBe(true)
    expect(Object.keys(http.decorators).sort()).toEqual(
      [
        'All',
        'Body',
        'Controller',
        'Ctx',
        'Delete',
        'Get',
        'Head',
        'Header',
        'Headers',
        'HttpCode',
        'Options',
        'Param',
        'Patch',
        'Post',
        'Put',
        'Query',
        'Req',
        'Res',
        'UseGuard',
        'UseInterceptor',
        'Validate',
      ].map(name => `@znight/http#${name}`),
    )
    expect(http.decorators['@znight/http#Controller']).toEqual({ targets: ['class'], params: ['static'] })
    expect(http.decorators['@znight/http#Param']).toEqual({ targets: ['parameter'], params: ['value', 'value'] })
    expect(http.decorators['@znight/http#Headers']).toEqual({ targets: ['parameter'], params: ['static'] })
    expect(http.decorators['@znight/http#UseGuard']).toEqual({
      targets: ['class', 'method'],
      params: [],
      rest: 'value',
    })
    expect(http.decorators['@znight/http#Header']).toEqual({ targets: ['method'], params: ['static', 'static'] })
  })

  it('is auto-discovered through the manifest of @znight/http', () => {
    const loaded = discovered.extensions.find(entry => entry.extension.name === 'http')
    expect(loaded?.origin).toBe('package')
    expect(loaded?.packageName).toBe('@znight/http')
    expect(loaded?.specifier).toBe('@znight/http/compiler')
    expect(loaded?.path).toBe(`${HTTP_ROOT}/src/compiler/index.ts`) // source condition under Bun
    expect(loaded?.extension).toBe(http)
  })

  it('explicit and discovered extensions produce the same result', () => {
    expect(render(discovered)).toEqual(render(explicit))
    expect(discovered.graph.providers.map(provider => provider.token)).toEqual(
      explicit.graph.providers.map(provider => provider.token),
    )
    expect(JSON.stringify(summary(discovered))).toBe(JSON.stringify(summary(explicit)))
  })
})

describe('fixture application', () => {
  it('only warns about @Res()', () => {
    expect(render(explicit)).toEqual([
      'warning ZNIGHT005 src/root.controller.ts:14:44 @Res() makes RootController.raw adapter-specific: the handler writes the native response itself',
    ])
  })

  it('registers controllers as providers with their scope', () => {
    const providers = new Map(explicit.graph.providers.map(provider => [provider.token, provider]))
    expect(providers.get('src/users/user.controller.ts#UserController')).toMatchObject({
      registeredBy: 'http',
      scope: 'singleton',
    })
    expect(providers.get('src/health.controller.ts#HealthController')).toMatchObject({
      registeredBy: 'http',
      scope: 'request',
    })
    expect(providers.get('src/root.controller.ts#RootController')?.registeredBy).toBe('http')
  })

  it('auto-registers guards and binds interceptors, with validation edges', () => {
    const providers = new Map(explicit.graph.providers.map(provider => [provider.token, provider]))
    expect(providers.get('src/auth/auth.guard.ts#AuthGuard')).toMatchObject({
      registeredBy: 'auto',
      scope: 'singleton',
    })
    expect(providers.get('src/common/timing.interceptor.ts#TimingInterceptor')?.registeredBy).toBe('core')
    expect(
      explicit.graph.edges
        .filter(edge => edge.kind === 'extension')
        .map(edge => `${edge.from} -> ${edge.to} (${edge.label})`),
    ).toEqual([
      'src/users/user.controller.ts#UserController -> src/auth/auth.guard.ts#AuthGuard (guard)',
      'src/users/user.controller.ts#UserController -> src/common/timing.interceptor.ts#TimingInterceptor (interceptor)',
    ])
  })

  it('controllers and guards are roots / reachable (nothing is reported unused)', async () => {
    const app = fixtureApp('app')
    const result = await analyzeApp(app.root, { reportUnused: true })
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'ZNIGHT019')).toEqual([])
    expect(result.graph.reachability?.unreachable).toEqual([])
  })

  it('stores one entry per controller, in identity order', () => {
    expect(summary(explicit).map(controller => [controller.token, controller.basePath])).toEqual([
      ['src/health.controller.ts#HealthController', '/health'],
      ['src/root.controller.ts#RootController', '/'],
      ['src/users/user.controller.ts#UserController', '/users'],
    ])
  })

  it('stores routes in source order with methods, paths and handlers', () => {
    const users = controller('UserController')
    expect(users.routes.map(route => `${route.method} ${route.fullPath} ${route.handler}`)).toEqual([
      'GET /users list',
      'GET /users/search search',
      'GET /users/:id find',
      'POST /users create',
      'PUT /users/:id update',
      'DELETE /users/:id remove',
      'PATCH /users/:id/flags flags',
      'HEAD /users/:id exists',
      'OPTIONS /users options',
      'ALL /users/legacy/* legacy',
      'POST /users/ping ping',
      'GET /users/typed/:day typed',
    ])
    expect(users.rawBasePath).toBe('/users') // const BASE = '/users'
    expect(route('UserController', 'list')).toMatchObject({ rawPath: '', path: '/' })
  })

  it('stores guards, interceptors, statuses, headers and metadata', () => {
    const users = controller('UserController')
    expect(users.guards.map(ref => ref.token)).toEqual(['src/auth/auth.guard.ts#AuthGuard'])
    expect(users.interceptors).toEqual([])
    expect(users.meta.map(entry => [entry.key, entry.value])).toEqual([['roles', ['admin']]])

    const find = route('UserController', 'find')
    expect(find.interceptors.map(ref => ref.token)).toEqual(['src/common/timing.interceptor.ts#TimingInterceptor'])
    expect(find.meta.map(entry => [entry.key, entry.value])).toEqual([['roles', ['admin', 'reader']]])

    const remove = route('UserController', 'remove')
    expect(remove.status).toBe(202)
    expect(remove.headers).toEqual([['x-deleted', 'yes']])

    expect(route('UserController', 'list').meta.map(entry => [entry.key, entry.value])).toEqual([['public', true]])
    expect(route('UserController', 'list').status).toBeUndefined()
  })

  it('stores parameters with their source, name, schema and coercion', () => {
    const params = (handler: string) =>
      route('UserController', handler).params.map(param => ({
        index: param.index,
        source: param.source,
        key: param.key,
        schema: param.schema?.name,
        optional: param.optional,
        plan: param.coercion?.plan,
        cast: param.coercion?.cast,
      }))
    expect(params('find')).toEqual([
      {
        index: 0,
        source: 'param',
        key: 'id',
        schema: undefined,
        optional: false,
        plan: { kind: 'number' },
        cast: false,
      },
    ])
    expect(params('list')).toEqual([
      {
        index: 0,
        source: 'query',
        key: 'page',
        schema: undefined,
        optional: true,
        plan: { kind: 'optional', item: { kind: 'number' } },
        cast: false,
      },
      {
        index: 1,
        source: 'query',
        key: 'tag',
        schema: undefined,
        optional: true,
        plan: { kind: 'optional', item: { kind: 'array', item: { kind: 'string' } } },
        cast: false,
      },
      {
        index: 2,
        source: 'query',
        key: 'sort',
        schema: undefined,
        optional: true,
        plan: { kind: 'optional', item: { kind: 'enum', values: ['asc', 'desc'] } },
        cast: false,
      },
    ])
    expect(params('update')).toEqual([
      { index: 0, source: 'param', key: 'id', schema: 'IdParam', optional: false, plan: undefined, cast: undefined },
      // @Validate(UpdateUser) applies to the @Body() parameter
      {
        index: 1,
        source: 'body',
        key: undefined,
        schema: 'UpdateUser',
        optional: false,
        plan: undefined,
        cast: undefined,
      },
    ])
    expect(params('flags').map(param => [param.source, param.key, param.plan])).toEqual([
      ['param', undefined, undefined],
      ['headers', 'x-flag', { kind: 'boolean' }],
      ['headers', undefined, undefined],
    ])
    expect(route('UserController', 'ping').bodySchema?.name).toBe('Ping')
    expect(route('UserController', 'ping').params).toEqual([])
    expect(route('RootController', 'raw').rawResponse).toBe(true)
    expect(route('RootController', 'raw').params.map(param => param.source)).toEqual(['request', 'response'])
  })

  it('coerces typed parameters (dates, booleans, bigints, branded strings, enums, arrays)', () => {
    expect(
      route('UserController', 'typed').params.map(param => [
        param.key,
        param.type,
        param.coercion?.plan,
        param.coercion?.cast,
      ]),
    ).toEqual([
      ['day', 'Date', { kind: 'date' }, false],
      ['flag', 'boolean | undefined', { kind: 'optional', item: { kind: 'boolean' } }, false],
      ['big', 'bigint', { kind: 'optional', item: { kind: 'bigint' } }, false],
      [
        'ids',
        "({ readonly __brand: 'UserId' } & string)[]",
        { kind: 'optional', item: { kind: 'array', item: { kind: 'string' } } },
        true,
      ],
      ['color', 'Color', { kind: 'optional', item: { kind: 'enum', values: ['red', 'blue'] } }, true],
      ['x-id', "{ readonly __brand: 'UserId' } & string", { kind: 'optional', item: { kind: 'string' } }, true],
    ])
  })
})

describe('paths and handlers', () => {
  it('normalizes and joins paths, and accepts several route decorators per handler', async () => {
    const app = tempApp({
      'src/a.controller.ts': `
import { Controller, Delete, Get, Param, Post } from '@znight/http'

@Controller('users/')
export class A {
  @Get(':id/')
  @Delete('/:id')
  one(@Param('id') id: string) { return id }

  @Post()
  @Get('/')
  root() {}
}

@Controller()
export class B {
  @Get() index() {}
  @Get('health') health() {}
}
`,
    })
    const result = await analyzeApp(app.root)
    expect(render(result)).toEqual([])
    expect(
      result.controllers.map(data => [
        data.basePath,
        data.routes.map(route => `${route.method} ${route.path} ${route.fullPath} ${route.handler}`),
      ]),
    ).toEqual([
      ['/users', ['GET /:id /users/:id one', 'DELETE /:id /users/:id one', 'POST / /users root', 'GET / /users root']],
      ['/', ['GET / / index', 'GET /health /health health']],
    ])
  })
})

function summary(result: HttpAnalysis) {
  return result.controllers.map(controller => ({
    token: controller.token,
    basePath: controller.basePath,
    guards: controller.guards.map(ref => ref.token),
    routes: controller.routes.map(route => ({
      method: route.method,
      fullPath: route.fullPath,
      handler: route.handler,
      params: route.params.map(param => [param.source, param.key, param.coercion?.plan]),
    })),
  }))
}

function controller(name: string) {
  const found = explicit.controllers.find(candidate => candidate.displayName === name)
  if (!found) {
    throw new Error(`no controller ${name}`)
  }
  return found
}

function route(controllerName: string, handler: string) {
  const found = controller(controllerName).routes.find(candidate => candidate.handler === handler)
  if (!found) {
    throw new Error(`no route ${controllerName}.${handler}`)
  }
  return found
}
