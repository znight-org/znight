import type { HttpContext } from '@znight/http'
import type { Principal } from '../src/auth/principal.js'

import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { CurrentUser } from '../src/auth/current-user.js'
import { CsrfGuard } from '../src/security/csrf.guard.js'
import { SessionCookies } from '../src/session/session-cookies.js'
import { describe, expect, test as it } from 'bun:test'

const FRONT_END = 'https://notes.example.com'
const TOKEN = 'csrf-token-of-the-session'

/** The part of the request context the guard reads. */
function request(method: string, headers: Record<string, string> = {}): HttpContext {
  return { method, header: (name: string) => headers[name] } as unknown as HttpContext
}

/**
 * A unit test with `TestBed`: `CorsConfig` is built from `config` values, `SessionCookies` is
 * auto-mocked, and the request-scoped `CurrentUser` is a real instance given with `provide` (the
 * guard receives `{ get: () => user }` for its `Lazy<CurrentUser>`).
 */
async function setup(via?: Principal['via']) {
  const user = new CurrentUser()
  const principal: Principal = { id: 'u-1', roles: ['editor'], via: via ?? 'session' }
  if (via !== undefined) user.authenticate(principal)
  const { instance, mocks } = await TestBed.create(CsrfGuard, {
    metadata,
    config: { cors: { origins: [FRONT_END] } },
    provide: [[CurrentUser, user]],
  })
  mocks.get(SessionCookies).read.mockReturnValue({ principal, csrfToken: TOKEN, expiresAt: new Date() })
  return instance
}

describe('CsrfGuard', () => {
  it('lets safe methods through', async () => {
    const guard = await setup('session')

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard.canActivate(request(method, { 'sec-fetch-site': 'cross-site' }))).toBe(true)
    }
  })

  it('needs nothing from callers authenticated with a token or an API key', async () => {
    for (const via of ['token', 'api-key'] as const) {
      const guard = await setup(via)
      expect(guard.canActivate(request('POST', { 'sec-fetch-site': 'cross-site' }))).toBe(true)
    }
  })

  it('refuses cross-site unsafe requests (fetch metadata), unless they come from a front-end of ours', async () => {
    const anonymous = await setup()

    expect(anonymous.canActivate(request('POST', { 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(anonymous.canActivate(request('POST', { 'sec-fetch-site': 'same-site' }))).toBe(true)
    expect(anonymous.canActivate(request('POST', { 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(anonymous.canActivate(request('POST', { 'sec-fetch-site': 'none' }))).toBe(true) // typed by the user
    expect(anonymous.canActivate(request('POST', { 'sec-fetch-site': 'cross-site', origin: FRONT_END }))).toBe(true)
  })

  it('falls back on the origin for browsers without fetch metadata', async () => {
    const anonymous = await setup()

    expect(anonymous.canActivate(request('POST', { origin: 'https://evil.example' }))).toBe(false)
    expect(anonymous.canActivate(request('POST', { origin: FRONT_END }))).toBe(true)
    expect(anonymous.canActivate(request('POST'))).toBe(true) // no origin: not a browser
  })

  it('requires the token of the session from cookie-authenticated callers', async () => {
    const guard = await setup('session')
    const sameSite = { 'sec-fetch-site': 'same-site' }

    expect(guard.canActivate(request('DELETE', sameSite))).toBe(false)
    expect(guard.canActivate(request('DELETE', { ...sameSite, 'x-csrf-token': 'wrong' }))).toBe(false)
    expect(guard.canActivate(request('DELETE', { ...sameSite, 'x-csrf-token': `${TOKEN}x` }))).toBe(false)
    expect(guard.canActivate(request('DELETE', { ...sameSite, 'x-csrf-token': TOKEN }))).toBe(true)
  })
})
