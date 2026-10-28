import type { HttpContext } from '@znight/http'
import type { Principal } from '../src/auth/principal.js'

import { UnauthorizedException } from '@znight/http'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { AuthGuard } from '../src/auth/auth.guard.js'
import { Authenticator } from '../src/auth/authenticator.js'
import { CurrentUser } from '../src/auth/current-user.js'
import { describe, expect, test as it } from 'bun:test'

const EDITOR: Principal = { id: 'u-1', roles: ['editor'], via: 'token' }

/** A request whose route has the given effective metadata (one decision of the "access" group). */
function request(meta: Record<string, unknown>): HttpContext {
  return { route: { method: 'GET', path: '/x', controller: 'X', handler: 'x', meta } } as unknown as HttpContext
}

/** `TestBed`: the real guard, its `Authenticator` and `Lazy<CurrentUser>` auto-mocked. */
async function setup(principal: Principal | Error = EDITOR) {
  const { instance, mocks } = await TestBed.create(AuthGuard, { metadata })
  const authenticate = mocks.get(Authenticator).authenticate
  if (principal instanceof Error) authenticate.mockRejectedValue(principal)
  else authenticate.mockResolvedValue(principal)
  return { guard: instance, authenticate, user: mocks.get(CurrentUser) }
}

describe('AuthGuard', () => {
  it('lets public routes through without authenticating', async () => {
    const { guard, authenticate } = await setup()

    expect(await guard.canActivate(request({ public: true }))).toBe(true)
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('authenticates every other request and records the caller', async () => {
    const { guard, user } = await setup()

    expect(await guard.canActivate(request({ authenticated: true }))).toBe(true)
    expect(user.authenticate).toHaveBeenCalledWith(EDITOR)
  })

  it('lets the 401 of the authenticator through', async () => {
    const { guard, user } = await setup(new UnauthorizedException('Authentication required'))

    await expect(guard.canActivate(request({ authenticated: true }))).rejects.toThrow(UnauthorizedException)
    expect(user.authenticate).not.toHaveBeenCalled()
  })

  it('checks the roles of @Roles routes: false answers 403', async () => {
    const { guard } = await setup()

    expect(await guard.canActivate(request({ roles: ['editor'] }))).toBe(true)
    expect(await guard.canActivate(request({ roles: ['admin', 'editor'] }))).toBe(true)
    expect(await guard.canActivate(request({ roles: ['admin'] }))).toBe(false)
  })

  it('denies a route without decision, even to an authenticated caller', async () => {
    const { guard } = await setup({ ...EDITOR, roles: ['admin', 'editor', 'reader', 'exporter'] })

    expect(await guard.canActivate(request({}))).toBe(false)
  })

  it('declares the decisions it enforces, for the boot check', () => {
    expect(AuthGuard.enforces.map(decorator => decorator.key)).toEqual(['public', 'authenticated', 'roles'])
  })
})
