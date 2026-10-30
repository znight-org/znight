/**
 * Route decisions (RFC 0001 §5.1, §5.2, §5.3): decorator groups, the effective metadata (nearest
 * decision wins), the boot check of required and enforced groups (ZNIGHT023) and the route
 * summaries used as an access matrix.
 */
import type { CanActivate, GuardClass, HttpContext, HttpPluginOptions } from '../src/index.ts'

import { Application, ErrorCode, silentLogger, ZnightError, type ZnightMetadata } from '@znight/core'

import { effectiveMeta, RouteGroups } from '../src/decisions.ts'
import { createRouteDecorator, ForbiddenException, HttpPlugin, UnauthorizedException } from '../src/index.ts'
import { caught, controller, createApp, metadata, provider, route, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const Public = createRouteDecorator('public', { group: 'access', required: true })
const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
const Roles = createRouteDecorator<readonly string[]>('roles', { group: 'access', required: true })
const RateLimit = createRouteDecorator<number>('rateLimit')

/** Users by API key. */
const USERS: Readonly<Record<string, readonly string[]>> = { admin: ['admin', 'reader'], reader: ['reader'] }

class AuthGuard implements CanActivate {
  static readonly enforces = [Public, Authenticated, Roles]
  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx)) return true
    const roles = USERS[ctx.header('x-api-key') ?? '']
    if (roles === undefined) throw new UnauthorizedException()
    const required = Roles.get(ctx)
    if (required !== undefined) return required.some(role => roles.includes(role))
    return Authenticated.get(ctx) === true
  }
}

class RateLimitGuard implements CanActivate {
  static readonly enforces = [RateLimit]
  canActivate(): boolean {
    return true
  }
}

class PlainGuard implements CanActivate {
  canActivate(): boolean {
    return true
  }
}

class StatusController {
  health() {
    return 'up'
  }
  details() {
    return 'details'
  }
}

class BookController {
  list() {
    return ['dune']
  }
  remove() {
    return undefined
  }
}

const ACCESS_GROUPS = { access: { keys: ['authenticated', 'public', 'roles'], required: true } }

/** `/status` is public at the controller level, `/status/details` is for admins (the former fail-open case). */
function appMetadata(
  options: {
    readonly controllerGuards?: readonly string[]
    readonly routeGuards?: readonly string[]
    readonly groups?: unknown
    readonly extraProviders?: Record<string, ReturnType<typeof provider>>
  } = {},
): ZnightMetadata {
  const meta = metadata(
    {
      [t('StatusController')]: provider(StatusController),
      [t('BookController')]: provider(BookController),
      [t('AuthGuard')]: provider(AuthGuard),
      [t('PlainGuard')]: provider(PlainGuard),
      ...options.extraProviders,
    },
    [
      controller(
        t('StatusController'),
        '/status',
        [
          route('health', '/', (c: StatusController) => c.health()),
          route('details', '/details', (c: StatusController) => c.details(), {
            meta: { roles: ['admin'] },
            guards: options.routeGuards ?? [],
          }),
        ],
        { meta: { public: true }, guards: options.controllerGuards ?? [] },
      ),
      controller(
        t('BookController'),
        '/books',
        [
          route('list', '/', (c: BookController) => c.list(), { meta: { rateLimit: 10 } }),
          route('remove', '/:id', (c: BookController) => c.remove(), { method: 'DELETE', meta: { roles: ['admin'] } }),
        ],
        { meta: { authenticated: true }, guards: options.controllerGuards ?? [] },
      ),
    ],
  )
  const groups = 'groups' in options ? options.groups : ACCESS_GROUPS
  return {
    ...meta,
    extensions: { http: { ...(meta.extensions?.http as object), ...(groups === undefined ? {} : { groups }) } },
  } as ZnightMetadata
}

async function bootError(meta: ZnightMetadata, options: HttpPluginOptions = {}): Promise<ZnightError> {
  const error = await caught(() => createApp(meta, options, { start: false }))
  expect(error).toBeInstanceOf(ZnightError)
  return error as ZnightError
}

describe('createRouteDecorator options', () => {
  it('exposes the key, the group and required', () => {
    expect({ key: Roles.key, group: Roles.group, required: Roles.required }).toEqual({
      key: 'roles',
      group: 'access',
      required: true,
    })
    expect({ key: RateLimit.key, group: RateLimit.group, required: RateLimit.required }).toEqual({
      key: 'rateLimit',
      group: 'rateLimit',
      required: false,
    })
  })

  it('builds metadata entries with meta()', () => {
    expect(Public.meta()).toEqual({ key: 'public', value: true, group: 'access', required: true })
    expect(Roles.meta(['admin'])).toEqual({ key: 'roles', value: ['admin'], group: 'access', required: true })
    expect(RateLimit.meta(5)).toEqual({ key: 'rateLimit', value: 5, group: 'rateLimit', required: false })
    expect(Object.isFrozen(Public.meta())).toBe(true)
  })

  it.each([
    [() => createRouteDecorator(''), 'the key must be a non-empty string'],
    [() => createRouteDecorator(42 as never), 'the key must be a non-empty string'],
    [() => createRouteDecorator('k', null as never), 'options must be an object'],
    [() => createRouteDecorator('k', { group: 1 as never }), '"group" must be a name'],
    [() => createRouteDecorator('k', { group: '1st' }), '"group" must be a name'],
    [() => createRouteDecorator('k', { group: '' }), '"group" must be a name'],
    [() => createRouteDecorator('k', { required: 'yes' as never }), '"required" must be a boolean'],
  ])('throws a TypeError at module load for invalid options (%#)', (create, message) => {
    expect(create).toThrow(TypeError)
    expect(create).toThrow(message)
  })

  it('accepts any non-empty key without explicit group, as before groups (its own group)', () => {
    for (const key of ['auth:public', 'app/roles', '_internal', '1st']) {
      expect(() => createRouteDecorator(key)).not.toThrow()
      const required = createRouteDecorator(key, { required: true })
      expect({ group: required.group, required: required.required }).toEqual({ group: key, required: true })
      expect(createRouteDecorator(key, { group: key }).group).toBe(key)
      expect(createRouteDecorator(key).meta()).toEqual({ key, value: true, group: key, required: false })
    }
    // the grammar applies to an explicit group
    expect(() => createRouteDecorator('auth:public', { group: 'auth:access' })).toThrow('"group" must be a name')
  })

  it('is assignable to `static enforces` of a guard class', () => {
    const guard: GuardClass = AuthGuard
    expect(guard.enforces?.map(info => info.key)).toEqual(['public', 'authenticated', 'roles'])
  })
})

describe('effectiveMeta', () => {
  const groups = RouteGroups.fromMetadata(ACCESS_GROUPS)
  const groupOf = (key: string): string => groups.groupOf(key)

  it('lets the route decision of a group replace the controller decision', () => {
    expect(effectiveMeta({ public: true }, { roles: ['admin'] }, groupOf)).toEqual({ roles: ['admin'] })
    expect(effectiveMeta({ roles: ['reader'] }, { public: true }, groupOf)).toEqual({ public: true })
  })

  it('keeps the controller decision when the route has none, and other groups', () => {
    expect(effectiveMeta({ roles: ['reader'], rateLimit: 5 }, { cache: 10 }, groupOf)).toEqual({
      roles: ['reader'],
      rateLimit: 5,
      cache: 10,
    })
  })

  it('merges key by key without groups (backward compatible)', () => {
    const none = RouteGroups.fromMetadata(undefined)
    expect(effectiveMeta({ public: true, a: 1 }, { roles: ['x'], a: 2 }, key => none.groupOf(key))).toEqual({
      public: true,
      roles: ['x'],
      a: 2,
    })
  })

  it('freezes the result', () => {
    expect(Object.isFrozen(effectiveMeta({}, { a: 1 }, groupOf))).toBe(true)
  })
})

describe('metadata groups', () => {
  it.each([
    [[], 'expected an object'],
    [{ access: { keys: [], required: true } }, 'group "access" must be'],
    [{ access: { keys: ['a', 'a'], required: true } }, 'group "access" must be'],
    [{ access: { keys: ['a'], required: 'yes' } }, 'group "access" must be'],
    [{ access: { keys: [''], required: true } }, 'group "access" must be'],
    [{ access: null }, 'group "access" must be'],
    [{ '1x': { keys: ['a'], required: false } }, 'invalid group name'],
    [
      { access: { keys: ['roles'], required: true }, other: { keys: ['roles'], required: false } },
      'the key "roles" belongs to the groups "access" and "other"',
    ],
  ])('rejects malformed groups with ZNIGHT007 (%#)', async (groups, message) => {
    const error = await bootError(appMetadata({ groups }), { guards: [AuthGuard], enforcement: 'warn' })
    expect(error.code).toBe(ErrorCode.InvalidRoute)
    expect(error.message).toContain(message)
  })

  it('accepts a group named after its single key, whatever the key (decorator without group)', async () => {
    const Legacy = createRouteDecorator('auth:public', { required: true })
    class LegacyGuard implements CanActivate {
      static readonly enforces = [Legacy]
      canActivate(): boolean {
        return true
      }
    }
    const meta = metadata({ [t('BookController')]: provider(BookController) }, [
      controller(t('BookController'), '/books', [route('list', '/', (c: BookController) => c.list())], {
        meta: { 'auth:public': true },
      }),
    ])
    const groups = { 'auth:public': { keys: ['auth:public'], required: true } }
    const withGroups = { ...meta, extensions: { http: { ...meta.extensions?.http, groups } } } as ZnightMetadata
    const app = await createApp(withGroups, { guards: [new LegacyGuard()] })
    try {
      expect((await app.http.inject({ method: 'GET', url: '/books' })).status).toBe(200)
    } finally {
      await app.stop()
    }
    const shared = {
      ...meta,
      extensions: { http: { ...meta.extensions?.http, groups: { 'a:b': { keys: ['a:b', 'c'], required: false } } } },
    }
    const error = await bootError(shared as ZnightMetadata, { guards: [new LegacyGuard()] })
    expect(error.message).toContain('invalid group name "a:b"')
  })

  it('rejects two decisions of one group on a hand-written target (ZNIGHT007)', async () => {
    const meta = metadata({ [t('BookController')]: provider(BookController), [t('AuthGuard')]: provider(AuthGuard) }, [
      controller(t('BookController'), '/books', [
        route('list', '/', (c: BookController) => c.list(), { meta: { public: true, roles: ['admin'] } }),
      ]),
    ])
    const withGroups = { ...meta, extensions: { http: { ...meta.extensions?.http, groups: ACCESS_GROUPS } } }
    const error = await bootError(withGroups as ZnightMetadata, { guards: [AuthGuard] })
    expect(error.code).toBe(ErrorCode.InvalidRoute)
    expect(error.message).toContain(
      'Invalid route metadata of BookController.list: "public" and "roles" are two decisions of the "access" group',
    )
  })
})

describe('nearest decision wins (fail-open regression)', () => {
  it('a route @Roles(["admin"]) under a public controller requires an admin', async () => {
    const app = await createApp(appMetadata(), { guards: [AuthGuard] })
    try {
      expect((await app.http.inject({ method: 'GET', url: '/status' })).status).toBe(200)
      expect((await app.http.inject({ method: 'GET', url: '/status/details' })).status).toBe(401)
      const reader = await app.http.inject({
        method: 'GET',
        url: '/status/details',
        headers: { 'x-api-key': 'reader' },
      })
      expect(reader.status).toBe(403)
      const admin = await app.http.inject({ method: 'GET', url: '/status/details', headers: { 'x-api-key': 'admin' } })
      expect(admin.status).toBe(200)
      expect((await app.http.inject({ method: 'GET', url: '/books' })).status).toBe(401)
      expect((await app.http.inject({ method: 'GET', url: '/books', headers: { 'x-api-key': 'reader' } })).status).toBe(
        200,
      )
    } finally {
      await app.stop()
    }
  })

  it('learns the groups from `static enforces` when the metadata has none', async () => {
    const app = await createApp(appMetadata({ groups: undefined }), { guards: [AuthGuard] })
    try {
      expect((await app.http.inject({ method: 'GET', url: '/status/details' })).status).toBe(401)
      const details = app.http.routes.find(entry => entry.path === '/status/details' && entry.method === 'GET')
      expect(details?.meta).toEqual({ roles: ['admin'] })
    } finally {
      await app.stop()
    }
  })

  it('merges key by key when no group is known (decorators without group)', async () => {
    const app = await createApp(appMetadata({ groups: undefined }), { guards: [PlainGuard] }, { start: false })
    try {
      const details = app.http.routes.find(entry => entry.path === '/status/details' && entry.method === 'GET')
      expect(details?.meta).toEqual({ public: true, roles: ['admin'] })
    } finally {
      await app.stop()
    }
  })
})

describe('boot check (ZNIGHT023)', () => {
  it('accepts a global guard class enforcing the group', async () => {
    const app = await createApp(appMetadata(), { guards: [AuthGuard] }, { start: false })
    await app.stop()
  })

  it('accepts a global guard instance', async () => {
    const app = await createApp(appMetadata(), { guards: [new AuthGuard()] }, { start: false })
    await app.stop()
  })

  it('accepts the guard on every controller', async () => {
    const app = await createApp(appMetadata({ controllerGuards: [t('AuthGuard')] }), {}, { start: false })
    await app.stop()
  })

  it('accepts options given as a function of the container', async () => {
    const http = HttpPlugin.configure(() => ({ port: 0, guards: [AuthGuard] }))
    const app = await Application.create({
      metadata: appMetadata(),
      plugins: [http],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    expect(http.routes.length).toBeGreaterThan(0)
    await app.stop()
  })

  it('reads the compiled class of a guard replaced through overrides', async () => {
    class FakeGuard implements CanActivate {
      canActivate(): boolean {
        return true
      }
    }
    const app = await createApp(
      appMetadata({ controllerGuards: [t('AuthGuard')] }),
      {},
      { start: false, overrides: { [t('AuthGuard')]: new FakeGuard() } },
    )
    try {
      expect((await app.http.inject({ method: 'GET', url: '/status/details' })).status).toBe(200)
    } finally {
      await app.stop()
    }
  })

  it('fails when no guard enforces the required group', async () => {
    const error = await bootError(appMetadata())
    expect(error.code).toBe(ErrorCode.MissingRouteDecision)
    expect(error.message).toBe(
      'ZNIGHT023: HttpPlugin: No guard enforces the required "access" group on 4 routes: GET /status (StatusController.health), GET /status/details (StatusController.details), GET /books (BookController.list), DELETE /books/:id (BookController.remove)',
    )
    expect(error.hints).toContain(
      'Register a guard declaring `static enforces` with the decorators of the "access" group (authenticated, public, roles), e.g. HttpPlugin.configure({ guards: [AuthGuard] })',
    )
  })

  it('names a guard after the group when no guard of the application enforces it', async () => {
    const meta = appMetadata()
    const { [t('AuthGuard')]: _, ...providers } = meta.providers
    const error = await bootError({ ...meta, providers })
    expect(error.code).toBe(ErrorCode.MissingRouteDecision)
    expect(error.hints).toContain(
      'Register a guard declaring `static enforces` with the decorators of the "access" group (authenticated, public, roles), e.g. HttpPlugin.configure({ guards: [AccessGuard] })',
    )
  })

  it('names a guard after a group that is not an identifier', async () => {
    const groups = { ...ACCESS_GROUPS, 'rate-limit': { keys: ['rateLimit'], required: true } }
    const error = await bootError(appMetadata({ groups }), { guards: [AuthGuard] })
    expect(error.hints).toContain(
      'Register a guard declaring `static enforces` with the decorators of the "rate-limit" group (rateLimit), e.g. HttpPlugin.configure({ guards: [RateLimitGuard] })',
    )
  })

  it('fails when only some chains enforce the group', async () => {
    const error = await bootError(appMetadata({ routeGuards: [t('AuthGuard')] }))
    expect(error.code).toBe(ErrorCode.MissingRouteDecision)
    expect(error.message).toContain('on 3 routes:')
    expect(error.message).not.toContain('StatusController.details')
  })

  it('fails when a route has no decision of a required group', async () => {
    const meta = appMetadata()
    const http = meta.extensions?.http as { controllers: ReturnType<typeof controller>[] }
    const books = http.controllers[1] as ReturnType<typeof controller>
    const undecided = { ...meta, extensions: { http: { ...http, controllers: [{ ...books, meta: {} }] } } }
    const error = await bootError(undecided as ZnightMetadata, { guards: [AuthGuard] })
    expect(error.message).toBe(
      'ZNIGHT023: HttpPlugin: 1 route has no "access" decision: GET /books (BookController.list)',
    )
    expect(error.hints[0]).toBe(
      'Add a decision of the "access" group (authenticated, public, roles) to the route or to its controller',
    )
  })

  it('knows a required group through `enforces` only (no compiled groups)', async () => {
    const meta = metadata({ [t('BookController')]: provider(BookController), [t('AuthGuard')]: provider(AuthGuard) }, [
      controller(t('BookController'), '/books', [route('list', '/', (c: BookController) => c.list())]),
    ])
    const error = await bootError(meta, { guards: [AuthGuard] })
    expect(error.code).toBe(ErrorCode.MissingRouteDecision)
    expect(error.message).toContain('1 route has no "access" decision: GET /books (BookController.list)')
  })

  it('checks decisions of groups some guard enforces (not required)', async () => {
    // no guard of the application enforces rateLimit: the decorator is inert, as before
    const app = await createApp(appMetadata(), { guards: [AuthGuard] }, { start: false })
    await app.stop()
    const routeLimited = appMetadata({
      routeGuards: [t('RateLimitGuard')],
      extraProviders: { [t('RateLimitGuard')]: provider(RateLimitGuard) },
    })
    const failure = await bootError(routeLimited, { guards: [AuthGuard] })
    expect(failure.message).toBe(
      'ZNIGHT023: HttpPlugin: No guard enforces the "rateLimit" group on 1 route: GET /books (BookController.list)',
    )
  })

  it('checks decisions of a group whose guard class sits in no chain (forgotten guard)', async () => {
    // the security guide's rate-limit recipe booted from a second entrypoint without the guard
    const meta = appMetadata({ extraProviders: { [t('RateLimitGuard')]: provider(RateLimitGuard) } })
    const failure = await bootError(meta, { guards: [AuthGuard] })
    expect(failure.code).toBe(ErrorCode.MissingRouteDecision)
    expect(failure.message).toBe(
      'ZNIGHT023: HttpPlugin: No guard enforces the "rateLimit" group on 1 route: GET /books (BookController.list)',
    )
    expect(failure.hints).toContain('Guards of the application enforcing the "rateLimit" group: RateLimitGuard')
    // the example names the guard of this group, not the access guard
    expect(failure.hints).toContain(
      'Register a guard declaring `static enforces` with the decorators of the "rateLimit" group (rateLimit), e.g. HttpPlugin.configure({ guards: [RateLimitGuard] })',
    )
    const app = await createApp(meta, { guards: [AuthGuard, RateLimitGuard] }, { start: false })
    await app.stop()
    // only its groups become known: an unused guard class does not make its required groups required
    const warned = await createApp(meta, { guards: [AuthGuard], enforcement: 'warn' }, { start: false })
    try {
      expect(warned.logger.entries.filter(entry => entry.level === 'warn').map(entry => entry.context)).toEqual([
        { code: 'ZNIGHT023', group: 'rateLimit' },
      ])
    } finally {
      await warned.stop()
    }
  })

  it('does not require the groups of a guard class that sits in no chain', async () => {
    const Tenant = createRouteDecorator('tenant', { required: true })
    class TenantGuard implements CanActivate {
      static readonly enforces = [Tenant]
      canActivate(): boolean {
        return true
      }
    }
    const meta = appMetadata({ extraProviders: { [t('TenantGuard')]: provider(TenantGuard) } })
    const app = await createApp(meta, { guards: [AuthGuard] }, { start: false })
    await app.stop()
  })

  it("logs one warning per group with enforcement: 'warn'", async () => {
    const app = await createApp(appMetadata(), { enforcement: 'warn' }, { start: false })
    try {
      const warnings = app.logger.entries.filter(entry => entry.level === 'warn')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.message).toContain('HttpPlugin: no guard enforces the required "access" group on 4 routes')
      expect(warnings[0]?.context).toEqual({ code: 'ZNIGHT023', group: 'access' })
    } finally {
      await app.stop()
    }
  })

  it('rejects a malformed `static enforces` (ZNIGHT005)', async () => {
    class BadGuard implements CanActivate {
      static readonly enforces = ['access']
      canActivate(): boolean {
        return true
      }
    }
    const error = await bootError(appMetadata({ extraProviders: { [t('BadGuard')]: provider(BadGuard) } }), {
      guards: [BadGuard as unknown as GuardClass],
    })
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
    expect(error.message).toContain('invalid static enforces of the guard BadGuard')
  })

  it('rejects enforces contradicting the compiled groups (ZNIGHT005)', async () => {
    const Loose = createRouteDecorator('roles', { group: 'access' })
    class LooseGuard implements CanActivate {
      static readonly enforces = [Loose]
      canActivate(): boolean {
        return true
      }
    }
    const error = await bootError(appMetadata({ extraProviders: { [t('LooseGuard')]: provider(LooseGuard) } }), {
      guards: [LooseGuard, AuthGuard],
    })
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
    expect(error.message).toContain(
      'the route decorator "roles" is declared with the group "access" by the guard LooseGuard but with the group "access" (required) by the compiled metadata',
    )
  })

  it('rejects an invalid enforcement option', async () => {
    const error = await bootError(appMetadata(), { guards: [AuthGuard], enforcement: 'off' as never })
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
    expect(error.message).toContain('option "enforcement"')
  })
})

describe('route summaries (access matrix)', () => {
  it('list the effective metadata, the guards in chain order and the source', async () => {
    const app = await createApp(
      appMetadata({ routeGuards: [t('PlainGuard')] }),
      { guards: [AuthGuard, new RateLimitGuard()] },
      { start: false },
    )
    try {
      const matrix = app.http.routes
        .filter(entry => entry.method !== 'HEAD')
        .map(
          entry =>
            `${entry.method} ${entry.path} ${JSON.stringify(entry.meta)} [${entry.guards.join(', ')}] ${entry.source}`,
        )
      expect(matrix).toEqual([
        'GET /books {"authenticated":true,"rateLimit":10} [AuthGuard, RateLimitGuard] controller',
        'DELETE /books/:id {"roles":["admin"]} [AuthGuard, RateLimitGuard] controller',
        'GET /status {"public":true} [AuthGuard, RateLimitGuard] controller',
        'GET /status/details {"roles":["admin"]} [AuthGuard, RateLimitGuard, PlainGuard] controller',
      ])
      expect(Object.isFrozen(app.http.routes[0]?.meta)).toBe(true)
    } finally {
      await app.stop()
    }
  })

  it('reach guards through ctx.route.meta', async () => {
    const seen: unknown[] = []
    class SpyGuard implements CanActivate {
      static readonly enforces = [Public, Authenticated, Roles]
      canActivate(ctx: HttpContext): boolean {
        seen.push(ctx.route?.meta)
        if (Roles.get(ctx) !== undefined) throw new ForbiddenException()
        return true
      }
    }
    const app = await createApp(appMetadata(), { guards: [new SpyGuard()] })
    try {
      expect((await app.http.inject({ method: 'GET', url: '/status/details' })).status).toBe(403)
      expect(seen).toEqual([{ roles: ['admin'] }])
    } finally {
      await app.stop()
    }
  })
})
