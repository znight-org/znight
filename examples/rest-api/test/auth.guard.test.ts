import type { HttpContext } from '@znight/http'

import { UnauthorizedException } from '@znight/http'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { AuthGuard } from '../src/auth/auth.guard.js'
import { RequestUser } from '../src/auth/request-user.js'
import { ADMIN_KEY, READER_KEY } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/** The part of the request context the guard reads: headers and the route metadata. */
function request(headers: Record<string, string>, meta: Record<string, unknown> = {}): HttpContext {
  return {
    header: (name: string) => headers[name.toLowerCase()],
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
  return { guard: instance, requestUser: mocks.get(RequestUser) }
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

  it('answers 401 for an unknown API key', async () => {
    const { guard } = await setup()

    expect(() => guard.canActivate(request({ 'x-api-key': 'nope' }))).toThrow('Invalid API key')
  })

  it('authenticates the caller of the request', async () => {
    const { guard, requestUser } = await setup()

    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }))).toBe(true)
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
})
