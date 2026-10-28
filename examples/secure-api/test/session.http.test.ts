import type { InjectResponse, TestApp } from '@znight/testing'
import type { SessionResponse } from '../src/session/session.controller.js'

import { CSRF_HEADER } from '../src/security/csrf.guard.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/session/session-cookies.js'
import { bearer, createTestApp, type LogEntry } from './support/app.js'
import { ADA, BROWSER_ORIGIN, GRACE, LINUS } from './support/fixtures.js'
import { mintToken } from './support/tokens.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** The requests of the front-end, as a current browser sends them from https://notes.example.com. */
const SAME_SITE = { origin: BROWSER_ORIGIN, 'sec-fetch-site': 'same-site' }
/** What a page of another site makes the browser send. */
const CROSS_SITE = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }

/** What a browser keeps after a sign-in: the cookies it sends back, and the token the page read. */
interface Browser {
  readonly cookies: Record<string, string>
  readonly csrfToken: string
}

function browserAfter(signIn: InjectResponse): Browser {
  expect(signIn.status).toBe(200)
  return {
    cookies: {
      [SESSION_COOKIE]: signIn.cookies[SESSION_COOKIE]?.value ?? '',
      [CSRF_COOKIE]: signIn.cookies[CSRF_COOKIE]?.value ?? '',
    },
    csrfToken: signIn.json<SessionResponse>().csrfToken,
  }
}

/** Password sign-in, cookie sessions and the CSRF defences that cookies need. */
describe('cookie sessions', () => {
  let app: TestApp
  const logs: LogEntry[] = []
  let client = 0

  beforeAll(async () => {
    app = await createTestApp({ logs })
  })

  afterAll(async () => {
    await app.close()
  })

  /** Each sign-in from its own address: POST /session allows 5 attempts per minute and address. */
  function signIn(username: string, password: string, headers: Record<string, string> = SAME_SITE) {
    return app.inject({
      method: 'POST',
      url: '/session',
      headers: { ...headers, 'x-forwarded-for': `198.51.100.${++client}` },
      body: { username, password },
    })
  }

  it('signs in with a password: a signed session cookie and a CSRF cookie', async () => {
    const response = await signIn(ADA.username, ADA.password)

    expect(response.status).toBe(200)
    const session = response.json<SessionResponse>()
    expect(session).toMatchObject({ id: ADA.id, roles: ['editor'] })
    expect(response.cookies[SESSION_COOKIE]).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 28_800,
    })
    // signed: `<base64url payload>.<base64url HMAC>`
    expect(response.cookies[SESSION_COOKIE]?.value).toMatch(/^[\w-]+\.[\w-]+$/)
    // readable by the pages (not HttpOnly), the same token as in the body
    expect(response.cookies[CSRF_COOKIE]).toMatchObject({ httpOnly: false, secure: true, sameSite: 'strict' })
    expect(response.cookies[CSRF_COOKIE]?.value).toBe(session.csrfToken)
  })

  it('answers the same 401 for an unknown name and a wrong password', async () => {
    const unknown = await signIn('mallory', ADA.password)
    const wrong = await signIn(ADA.username, 'not-the-password')

    for (const response of [unknown, wrong]) {
      expect(response.status).toBe(401)
      expect(response.json()).toMatchObject({ message: 'Invalid username or password' })
      expect(response.cookies[SESSION_COOKIE]).toBeUndefined()
    }
  })

  it('authenticates the requests carrying the session cookie', async () => {
    const { cookies, csrfToken } = browserAfter(await signIn(ADA.username, ADA.password))

    const me = await app.inject({ url: '/me', cookies })
    expect(me.status).toBe(200)
    expect(me.json()).toMatchObject({ id: ADA.id, roles: ['editor'], via: 'session' })
    // the token again, for a front-end that cannot read the cookie
    expect((await app.inject({ url: '/session', cookies })).json()).toMatchObject({ csrfToken })
  })

  it('requires the CSRF token of the session on unsafe requests (double submit)', async () => {
    const ada = browserAfter(await signIn(ADA.username, ADA.password))
    const grace = browserAfter(await signIn(GRACE.username, GRACE.password))
    const create = (token?: string) =>
      app.inject({
        method: 'POST',
        url: '/notes',
        cookies: ada.cookies,
        headers: token === undefined ? SAME_SITE : { ...SAME_SITE, [CSRF_HEADER]: token },
        body: { text: 'x' },
      })

    expect((await create()).status).toBe(403) // a forged form or fetch() cannot read the token
    expect((await create('guessed')).status).toBe(403)
    expect((await create(grace.csrfToken)).status).toBe(403) // bound to its session
    expect((await create(ada.csrfToken)).status).toBe(201)
    // safe methods need none
    expect((await app.inject({ url: '/notes', cookies: ada.cookies })).status).toBe(200)
  })

  it('refuses unsafe requests coming from another site, whatever they carry', async () => {
    const { cookies, csrfToken } = browserAfter(await signIn(ADA.username, ADA.password))

    const create = await app.inject({
      method: 'POST',
      url: '/notes',
      cookies,
      headers: { ...CROSS_SITE, [CSRF_HEADER]: csrfToken },
      body: { text: 'x' },
    })
    expect(create.status).toBe(403)
    // login CSRF: signing a victim into the attacker's account
    expect((await signIn(ADA.username, ADA.password, CROSS_SITE)).status).toBe(403)
    // older browsers without fetch metadata: the origin decides
    expect((await signIn(ADA.username, ADA.password, { origin: 'https://evil.example' })).status).toBe(403)
    // no origin, no fetch metadata: not a browser (curl, a server), nothing ambient to abuse
    expect((await signIn(ADA.username, ADA.password, {})).status).toBe(200)
  })

  it('needs no CSRF token with a bearer token: browsers never attach it by themselves', async () => {
    const token = bearer(await mintToken({ sub: 'u-1', roles: ['editor'] }))

    const response = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: { ...token, ...CROSS_SITE },
      body: { text: 'x' },
    })

    expect(response.status).toBe(201)
  })

  it('signs out: clears both cookies (with the CSRF token, an unsafe method)', async () => {
    const { cookies, csrfToken } = browserAfter(await signIn(ADA.username, ADA.password))

    expect((await app.inject({ method: 'DELETE', url: '/session', cookies, headers: SAME_SITE })).status).toBe(403)
    const signedOut = await app.inject({
      method: 'DELETE',
      url: '/session',
      cookies,
      headers: { ...SAME_SITE, [CSRF_HEADER]: csrfToken },
    })

    expect(signedOut.status).toBe(204)
    expect(signedOut.cookies[SESSION_COOKIE]).toMatchObject({ value: '', maxAge: 0 })
    expect(signedOut.cookies[CSRF_COOKIE]).toMatchObject({ value: '', maxAge: 0 })
  })

  it('ignores a tampered cookie, and tells the browser to drop it', async () => {
    const { cookies } = browserAfter(await signIn(ADA.username, ADA.password))
    const [value = '', mac = ''] = (cookies[SESSION_COOKIE] ?? '').split('.')
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString()) as Record<string, unknown>
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: GRACE.id })).toString('base64url')

    const response = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: `${forged}.${mac}` } })

    expect(response.status).toBe(401)
    expect(response.cookies[SESSION_COOKIE]).toMatchObject({ maxAge: 0 })
  })

  it('upgrades a password hash made with older parameters at sign-in', async () => {
    const first = await signIn(LINUS.username, LINUS.password)
    const second = await signIn(LINUS.username, LINUS.password)

    expect([first.status, second.status]).toEqual([200, 200])
    expect(logs.filter(log => log.msg === 'Password hash upgraded')).toEqual([
      expect.objectContaining({ level: 30, account: LINUS.id }),
    ])
  })
})

describe('session lifetime and accounts', () => {
  it('ends the session at its signed expiry', async () => {
    await using app = await createTestApp({ env: { SESSION_MAX_AGE: '1' } })
    const signedIn = await app.inject({
      method: 'POST',
      url: '/session',
      body: { username: ADA.username, password: ADA.password },
    })
    const { cookies } = browserAfter(signedIn)
    expect((await app.inject({ url: '/me', cookies })).status).toBe(200)

    await Bun.sleep(1_100) // the browser would have dropped the cookie; a copied one still arrives

    expect((await app.inject({ url: '/me', cookies })).status).toBe(401)
  })

  it('refuses to boot with malformed accounts, without printing their hashes', async () => {
    const accounts = JSON.stringify([{ id: 'x', username: 'x', roles: ['root'], passwordHash: 'plain-text-password' }])

    const boot = createTestApp({ env: { LOCAL_ACCOUNTS: accounts } })

    await expect(boot).rejects.toThrow('Invalid LOCAL_ACCOUNTS')
    await boot.catch((error: unknown) => {
      const messages: string[] = []
      for (let cause = error; cause instanceof Error; cause = cause.cause) messages.push(cause.message)
      expect(messages.join('\n')).not.toContain('plain-text-password')
    })
  })
})
