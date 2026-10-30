import type { HttpContext } from '@znight/http'

import { UnauthorizedException } from '@znight/http'
import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { AuthGuard } from '../src/auth/auth.guard.js'
import { RequestUser } from '../src/auth/request-user.js'
import { ADMIN_KEY, READER_KEY } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/** The access decision of most routes: any valid API key. */
const authenticated = { authenticated: true }

/**
 * The part of the request context the guard reads: headers, client address and the route metadata
 * (the **effective** metadata, which holds one decision of the "access" group).
 */
function request(headers: Record<string, string>, meta: Record<string, unknown> = authenticated): HttpContext {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    ip: '203.0.113.7',
    route: { method: 'GET', path: '/books', controller: 'test', handler: 'test', meta },
  } as unknown as HttpContext
}

/**
 * `@Config` classes are not mocked by TestBed: it builds real instances from the `config` values
 * (keyed by the `@Config` prefix). `Lazy<RequestUser>` receives `{ get: () => mock }`, the same
 * mock as `mocks.get(RequestUser)`.
 */
async function setup() {
  const { instance, mocks } = await TestBed.create(AuthGuard, {
    metadata,
    config: { auth: { apiKey: ADMIN_KEY, readonlyApiKey: READER_KEY } },
  })
  return { guard: instance, requestUser: mocks.get(RequestUser), logger: mocks.get(Logger) }
}

describe('AuthGuard', () => {
  it('lets public routes through without API key', async () => {
    const { guard, requestUser } = await setup()

    expect(guard.canActivate(request({}, { public: true }))).toBe(true)
    expect(requestUser.authenticate).not.toHaveBeenCalled()
  })

  it('answers 401 without API key', async () => {
    const { guard } = await setup()

    expect(() => guard.canActivate(request({}))).toThrow(UnauthorizedException)
  })

  it('answers 401 for an unknown API key, and logs the client address', async () => {
    const { guard, logger } = await setup()

    expect(() => guard.canActivate(request({ 'x-api-key': 'nope' }))).toThrow('Invalid API key')
    // never the key itself
    expect(logger.warn).toHaveBeenCalledWith('Invalid API key', { ip: '203.0.113.7', route: '/books' })
  })

  it('authenticates the caller of the request', async () => {
    const { guard, requestUser } = await setup()

    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }, { authenticated: true }))).toBe(true)
    expect(requestUser.authenticate).toHaveBeenCalledWith({ name: 'admin', roles: ['admin', 'reader'] })
  })

  it('enforces @Roles', async () => {
    const { guard } = await setup()
    const adminOnly = { roles: ['admin'] }

    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }, adminOnly))).toBe(true)
    // false answers 403 Forbidden
    expect(guard.canActivate(request({ 'x-api-key': READER_KEY }, adminOnly))).toBe(false)
    expect(guard.canActivate(request({ 'x-api-key': READER_KEY }, { roles: ['reader'] }))).toBe(true)
  })

  it('denies a route without access decision, even to the administrator', async () => {
    const { guard } = await setup()

    // unreachable in the application (ZNIGHT023 at build time): deny by default, never allow
    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }, {}))).toBe(false)
  })

  it('enforces the decisions of the "access" group (checked at boot)', () => {
    expect(AuthGuard.enforces.map(decorator => decorator.key)).toEqual(['public', 'authenticated', 'roles'])
    expect(new Set(AuthGuard.enforces.map(decorator => decorator.group))).toEqual(new Set(['access']))
  })
})
