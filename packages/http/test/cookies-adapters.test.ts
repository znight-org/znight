/**
 * Cookies on every adapter (RFC 0006 §10.3), in memory (`inject`) and over real sockets (`fetch`,
 * raw `net` for the wire format): parameters and 400s, signed cookies and rotation, the merge of
 * the jars and raw `set-cookie` values, cookies on error responses and redirects, Web `Response`
 * cookies, invalid cookies detected when serialised, and the inject helpers.
 */
import net from 'node:net'

import { signValue } from '../src/cookie-settings.ts'
import { CookieSigner } from '../src/cookie-signer.ts'
import { decodeCookieValue } from '../src/cookies.ts'
import { cookiesSseMetadata, cookiesSseOptions, SECRETS } from './cookies-sse-app.ts'
import { ADAPTERS, createApp, type Send, type TestApp, TRANSPORTS } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

/** Sends a raw HTTP/1.1 request and resolves with the response head (status line and header lines). */
function rawHead(port: number, request: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    const done = (): void => {
      socket.destroy()
      resolve(received.split('\r\n\r\n')[0]?.split('\r\n') ?? [])
    }
    socket.on('connect', () => socket.write(request))
    socket.on('data', data => {
      received += data.toString('latin1')
      if (received.includes('\r\n\r\n')) done()
    })
    socket.on('error', reject)
    setTimeout(done, 3_000)
  })
}

const SET_COOKIE_DEFAULTS = 'Path=/; Secure; HttpOnly; SameSite=Lax'

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter`, () => {
    let app: TestApp

    beforeAll(async () => {
      app = await createApp(cookiesSseMetadata(), { ...cookiesSseOptions(), adapter: adapter.create() })
    })

    afterAll(async () => {
      await app.stop()
    })

    for (const transport of TRANSPORTS) {
      describe(transport.name, () => {
        let send: Send
        beforeAll(() => {
          send = transport.create(app.http)
        })

        it('reads cookies with coercion and schemas', async () => {
          const res = await send({ method: 'GET', url: '/prefs', cookies: { theme: 'dark', visits: '3' } })
          expect(res.json()).toEqual({ theme: 'dark', visits: 3 })
          // a stale value falls back through the schema; an absent optional cookie is undefined
          expect((await send({ method: 'GET', url: '/prefs', cookies: { theme: 'blue' } })).json()).toEqual({
            theme: 'light',
            visits: 0,
          })
          const all = await send({ method: 'GET', url: '/prefs/all', cookies: { a: 'x y', b: 'é' } })
          expect(all.json()).toEqual({ a: 'x y', b: 'é' })
        })

        it('answers 400 without echoing cookie values', async () => {
          const invalid = await send({ method: 'GET', url: '/prefs/count', cookies: { n: 'secret-token' } })
          expect(invalid.status).toBe(400)
          expect(invalid.json()).toMatchObject({ message: 'Invalid cookie "n": expected a number' })
          expect(invalid.body).not.toContain('secret-token')
          const missing = await send({ method: 'GET', url: '/prefs/count' })
          expect(missing.status).toBe(400)
          expect(missing.json()).toMatchObject({ message: 'Missing cookie "n"' })
          const coerced = await send({ method: 'GET', url: '/prefs/count', cookies: { n: '42' } })
          expect(coerced.json()).toEqual({ n: 42 })
        })

        it('sets cookies with the secure defaults', async () => {
          const res = await send({ method: 'POST', url: '/prefs/theme' })
          expect(res.status).toBe(204)
          expect(res.headers['set-cookie']).toEqual(['theme=dark; Max-Age=31536000; Path=/; Secure; SameSite=Lax'])
          expect(res.cookies['theme']).toMatchObject({
            value: 'dark',
            maxAge: 31_536_000,
            httpOnly: false,
            secure: true,
          })
        })

        it('signs, verifies and clears a __Host- cookie', async () => {
          const login = await send({ method: 'POST', url: '/auth/login' })
          expect(login.status).toBe(200)
          const cookie = login.cookies['__Host-uid']
          expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 28_800 })
          expect(cookie?.value).toMatch(/^u-1\.[\w-]{43}$/)
          const me = await send({ method: 'GET', url: '/auth/me', cookies: { '__Host-uid': cookie?.value as string } })
          expect(me.json()).toEqual({ uid: 'u-1' })
          const signed = await send({ method: 'GET', url: '/auth/me', signedCookies: { '__Host-uid': 'u-2' } })
          expect(signed.json()).toEqual({ uid: 'u-2' })
          const logout = await send({ method: 'POST', url: '/auth/logout' })
          expect(logout.headers['set-cookie']).toEqual([
            `__Host-uid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${SET_COOKIE_DEFAULTS}`,
          ])
        })

        it('treats tampered and unknown-key signatures as absent; verifies the previous key', async () => {
          for (const value of ['u-2.AAAA', `u-2.${'A'.repeat(43)}`, 'u-2']) {
            const res = await send({ method: 'GET', url: '/auth/me', cookies: { '__Host-uid': value } })
            expect(res.status).toBe(400)
            expect(res.json()).toMatchObject({ message: 'Missing cookie "__Host-uid"' })
          }
          const retired = decodeCookieValue(
            signValue(new CookieSigner(['retired-secret-retired-secret-0001']), '__Host-uid', 'u-3'),
          )
          expect((await send({ method: 'GET', url: '/auth/me', cookies: { '__Host-uid': retired } })).status).toBe(400)
          const previous = decodeCookieValue(signValue(new CookieSigner([SECRETS[1] as string]), '__Host-uid', 'u-4'))
          const rotated = await send({ method: 'GET', url: '/auth/me', cookies: { '__Host-uid': previous } })
          expect(rotated.json()).toEqual({ uid: 'u-4' })
          // the MAC covers the name
          const other = decodeCookieValue(app.http.signCookie('uid', 'u-5'))
          expect((await send({ method: 'GET', url: '/auth/me', cookies: { '__Host-uid': other } })).status).toBe(400)
        })

        it('merges raw set-cookie values, the context jar and the response jar in order', async () => {
          const res = await send({ method: 'GET', url: '/auth/merge' })
          expect(res.headers['set-cookie']).toEqual([
            'raw=1; Path=/',
            `a=response; ${SET_COOKIE_DEFAULTS}`,
            `c=kept; ${SET_COOKIE_DEFAULTS}`,
            `b=two%20words; ${SET_COOKIE_DEFAULTS}`,
          ])
          expect(res.cookies['b']?.value).toBe('two words')
        })

        it('sends the context jar with errors and redirects, none with a 404', async () => {
          const denied = await send({ method: 'GET', url: '/auth/guarded' })
          expect(denied.status).toBe(401)
          expect(denied.headers['set-cookie']).toEqual([
            `sid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${SET_COOKIE_DEFAULTS}`,
          ])
          const redirect = await send({ method: 'GET', url: '/auth/redirect' })
          expect(redirect.status).toBe(302)
          expect(redirect.headers['set-cookie']).toEqual([`flash=saved; ${SET_COOKIE_DEFAULTS}`])
          const missing = await send({ method: 'GET', url: '/nowhere' })
          expect(missing.status).toBe(404)
          expect(missing.headers['set-cookie']).toBeUndefined()
          expect(missing.cookies).toEqual({})
        })

        it("keeps a Web Response's own cookies, then the jar", async () => {
          const res = await send({ method: 'GET', url: '/auth/web' })
          expect(res.body).toBe('web')
          expect(res.headers['set-cookie']).toEqual([
            'web=1; Path=/',
            'web2=2; Expires=Wed, 02 Jan 2030 03:04:05 GMT',
            `jar=1; ${SET_COOKIE_DEFAULTS}`,
          ])
        })

        it('turns a cookie invalid with the plugin defaults into a logged 500', async () => {
          const before = app.logger.entries.length
          const res = await send({ method: 'GET', url: '/auth/invalid' })
          expect(res.status).toBe(500)
          expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
          expect(res.headers['set-cookie']).toEqual([`kept=1; ${SET_COOKIE_DEFAULTS}`])
          const logged = app.logger.entries.slice(before).find(entry => entry.level === 'error')
          expect(logged?.context?.['err']).toMatchObject({
            message: 'Invalid cookie "__Host-x": the __Host- prefix requires secure: true',
          })
        })

        it('appends inject cookies after an explicit cookie header', async () => {
          const res = await send({
            method: 'GET',
            url: '/auth/echo',
            headers: { cookie: 'a=1' },
            cookies: { b: 'x;y', a: 'ignored' },
          })
          expect(res.json()).toEqual({ header: 'a=1; b=x%3By; a=ignored', cookies: { a: '1', b: 'x;y' } })
        })
      })
    }

    it('joins repeated Cookie header fields with "; " (raw socket)', async () => {
      const port = app.http.address?.port as number
      const head = await rawHead(
        port,
        'GET /auth/echo HTTP/1.1\r\nHost: x\r\nCookie: a=1\r\nCookie: b=2; c=3\r\nConnection: close\r\n\r\n',
      )
      expect(head[0]).toBe('HTTP/1.1 200 OK')
      const response = await fetch(`${String(app.http.address)}/auth/echo`, {
        headers: [
          ['cookie', 'a=1'],
          ['cookie', 'b=2'],
        ],
      })
      const body = (await response.json()) as { header: string; cookies: Record<string, string> }
      expect(body.cookies).toEqual({ a: '1', b: '2' })
    })

    it('sends one field line per cookie on the wire', async () => {
      const port = app.http.address?.port as number
      const head = await rawHead(port, 'GET /auth/merge HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      const lines = head.filter(line => line.toLowerCase().startsWith('set-cookie:'))
      expect(lines.map(line => line.slice('set-cookie:'.length).trim())).toEqual([
        'raw=1; Path=/',
        `a=response; ${SET_COOKIE_DEFAULTS}`,
        `c=kept; ${SET_COOKIE_DEFAULTS}`,
        `b=two%20words; ${SET_COOKIE_DEFAULTS}`,
      ])
    })

    it('reads repeated Cookie fields on the raw socket as one joined header', async () => {
      const port = app.http.address?.port as number
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        let received = ''
        socket.on('connect', () =>
          socket.write('GET /auth/echo HTTP/1.1\r\nHost: x\r\nCookie: a=1\r\nCookie: b=2\r\nConnection: close\r\n\r\n'),
        )
        socket.on('data', data => {
          received += data.toString('utf8')
        })
        socket.on('end', () => resolve(received))
        socket.on('error', reject)
      })
      const body = response.slice(response.indexOf('{'), response.lastIndexOf('}') + 1)
      expect(JSON.parse(body)).toEqual({ header: 'a=1; b=2', cookies: { a: '1', b: '2' } })
    })

    it('fails the boot when a route reads a signed cookie without cookies.secrets (ZNIGHT006)', async () => {
      const bare = await createApp(cookiesSseMetadata(), { adapter: adapter.create() }, { start: false }).catch(
        (error: unknown) => error,
      )
      expect(bare).toMatchObject({
        code: 'ZNIGHT006',
        message:
          "ZNIGHT006: HttpPlugin: AuthController.me reads a signed cookie (@SignedCookie('__Host-uid')) but cookies.secrets is not set",
      })
    })
  })
}
