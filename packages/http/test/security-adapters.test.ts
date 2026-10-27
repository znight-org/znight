/**
 * Security matrix (RFC 0001 §5.4–5.6) and plugin routes (RFC 0002 H1): every adapter × (in-memory
 * inject, real socket + fetch) answers the same. On Bun, the Hono adapter runs on `Bun.serve()`.
 */
import { ADAPTERS, createApp, type Send, type TestApp, TRANSPORTS } from './helpers.ts'
import { guardCalls, StatusPlugin, securityMetadata, securityOptions } from './security-app.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const APP = 'https://app.example.com'
const PREVIEW = 'https://pr-42.preview.example.com'
const EVIL = 'https://evil.example.net'

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

function preflight(url: string, origin = APP, requestHeaders?: string): Parameters<Send>[0] {
  return {
    method: 'OPTIONS',
    url,
    headers: {
      origin,
      'access-control-request-method': 'POST',
      ...(requestHeaders === undefined ? {} : { 'access-control-request-headers': requestHeaders }),
    },
  }
}

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter`, () => {
    let app: TestApp
    let status: StatusPlugin

    beforeAll(async () => {
      status = new StatusPlugin()
      app = await createApp(
        securityMetadata(),
        { ...securityOptions(), adapter: adapter.create() },
        { plugins: [status] },
      )
      app.app.hooks.wrap('http:request', async (event, next) => {
        if (event.path === '/api/site/hooked') event.responseHeaders['referrer-policy'] = 'same-origin'
        await next()
      })
    })

    afterAll(async () => {
      await app.stop()
    })

    for (const transport of TRANSPORTS) {
      describe(`via ${transport.name}`, () => {
        let send: Send
        beforeAll(() => {
          send = transport.create(app.http)
        })

        describe('CORS preflights', () => {
          it('answers an automatic OPTIONS path without running guards', async () => {
            const before = guardCalls.count
            const res = await send(preflight('/api/site', APP, 'Content-Type, X-Api-Key'))
            expect(res.status).toBe(204)
            expect(res.body).toBe('')
            expect(res.headers).toMatchObject({
              'access-control-allow-origin': APP,
              'access-control-allow-credentials': 'true',
              'access-control-allow-methods': 'GET, HEAD, OPTIONS',
              'access-control-allow-headers': 'content-type, x-api-key',
              'access-control-max-age': '600',
              allow: 'GET, HEAD, OPTIONS',
              vary: 'origin, access-control-request-method, access-control-request-headers',
            })
            expect(res.headers['access-control-expose-headers']).toBeUndefined()
            expect(guardCalls.count).toBe(before)
          })

          it('answers on @Options and @All routes without running the guard or the handler', async () => {
            const before = guardCalls.count
            const options = await send(preflight('/api/site/opt'))
            expect(options.status).toBe(204)
            expect(options.headers['allow']).toBe('OPTIONS')
            const any = await send(preflight('/api/site/any', PREVIEW))
            expect(any.status).toBe(204)
            expect(any.headers['access-control-allow-origin']).toBe(PREVIEW)
            expect(any.headers['access-control-allow-headers']).toBeUndefined()
            expect(any.headers['access-control-allow-methods']).toBe('DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT')
            expect(guardCalls.count).toBe(before)
          })

          it('still runs an OPTIONS route for a request that is not a preflight', async () => {
            const res = await send({ method: 'OPTIONS', url: '/api/site/opt', headers: { origin: APP } })
            expect(res.status).toBe(401)
            expect(res.headers['access-control-allow-origin']).toBe(APP)
          })

          it('answers 404 without CORS headers for an unknown path', async () => {
            const res = await send(preflight('/api/nowhere'))
            expect(res.status).toBe(404)
            expect(res.headers['access-control-allow-origin']).toBeUndefined()
            expect(res.headers['vary']).toBe('origin')
          })

          it('answers 403 without CORS headers for a denied origin', async () => {
            const res = await send(preflight('/api/site', EVIL))
            expect(res.status).toBe(403)
            expect(res.json()).toEqual({ statusCode: 403, error: 'Forbidden', message: 'CORS origin not allowed' })
            expect(res.headers['access-control-allow-origin']).toBeUndefined()
            expect(res.headers['access-control-allow-methods']).toBeUndefined()
            expect(res.headers['vary']).toBe('origin')
          })

          it('answers preflights of plugin routes', async () => {
            const res = await send(preflight('/api/status/reset'))
            expect(res.status).toBe(204)
            expect(res.headers['allow']).toBe('POST, OPTIONS')
          })
        })

        describe('CORS headers of replies', () => {
          it('adds them to a reply for an allowed origin', async () => {
            const res = await send({ method: 'GET', url: '/api/site', headers: { origin: APP } })
            expect(res.status).toBe(200)
            expect(res.headers).toMatchObject({
              'access-control-allow-origin': APP,
              'access-control-allow-credentials': 'true',
              'access-control-expose-headers': 'x-request-id',
              vary: 'origin',
            })
          })

          it.each([
            ['a guard 401', '/api/site/secret', 401],
            ['a 404', '/api/missing', 404],
            ['a 500', '/api/site/boom', 500],
            ['a redirect', '/api/site/redirect', 302],
            ['a plugin route', '/api/status', 200],
          ])('adds them to %s', async (_, url, code) => {
            const res = await send({ method: 'GET', url, headers: { origin: PREVIEW } })
            expect(res.status).toBe(code)
            expect(res.headers['access-control-allow-origin']).toBe(PREVIEW)
            expect(res.headers['access-control-allow-credentials']).toBe('true')
          })

          it('adds them to a 405 and to an automatic OPTIONS that is not a preflight', async () => {
            const notAllowed = await send({ method: 'DELETE', url: '/api/site', headers: { origin: APP } })
            expect(notAllowed.status).toBe(405)
            expect(notAllowed.headers['access-control-allow-origin']).toBe(APP)
            const options = await send({ method: 'OPTIONS', url: '/api/site', headers: { origin: APP } })
            expect(options.status).toBe(204)
            expect(options.headers['access-control-allow-origin']).toBe(APP)
            expect(options.headers['access-control-allow-methods']).toBeUndefined()
          })

          it('serves a denied origin normally, without CORS headers', async () => {
            const res = await send({ method: 'GET', url: '/api/site', headers: { origin: EVIL } })
            expect(res.status).toBe(200)
            expect(res.headers['access-control-allow-origin']).toBeUndefined()
            expect(res.headers['vary']).toBe('origin')
          })

          it('varies on origin without an origin header', async () => {
            const res = await send({ method: 'GET', url: '/api/site' })
            expect(res.headers['access-control-allow-origin']).toBeUndefined()
            expect(res.headers['vary']).toBe('origin')
          })

          it('merges vary with the headers of the handler and keeps theirs', async () => {
            const res = await send({ method: 'GET', url: '/api/site/headers', headers: { origin: APP } })
            expect(res.headers['vary']).toBe('accept, origin')
            const exposed = await send({ method: 'GET', url: '/api/site/exposed', headers: { origin: APP } })
            expect(exposed.headers['access-control-expose-headers']).toBe('x-custom')
          })
        })

        describe('security headers', () => {
          it.each([
            ['a 200', 'GET', '/api/site', 200],
            ['a 401', 'GET', '/api/site/secret', 401],
            ['a 404', 'GET', '/api/missing', 404],
            ['a 405', 'DELETE', '/api/site', 405],
            ['an automatic OPTIONS', 'OPTIONS', '/api/site', 204],
            ['a 500', 'GET', '/api/site/boom', 500],
            ['a HEAD', 'HEAD', '/api/site', 200],
            ['a plugin route', 'GET', '/api/status/files/a.txt', 200],
          ])('are sent with %s', async (_, method, url, code) => {
            const res = await send({ method, url })
            expect(res.status).toBe(code)
            expect(res.headers).toMatchObject(SECURITY_HEADERS)
          })

          it('lose to the headers of the handler and of hook wrappers', async () => {
            const res = await send({ method: 'GET', url: '/api/site/headers' })
            expect(res.headers['content-security-policy']).toBe("default-src 'self'")
            expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
            expect(res.headers['x-content-type-options']).toBe('nosniff')
            const hooked = await send({ method: 'GET', url: '/api/site/hooked' })
            expect(hooked.status).toBe(404)
            expect(hooked.headers['referrer-policy']).toBe('same-origin')
          })

          it('are not added to @Res() raw replies', async () => {
            const res = await send({ method: 'GET', url: '/api/site/raw', headers: { origin: APP } })
            expect(res.status).toBe(299)
            expect(res.body).toBe('raw')
            // Hono handlers answer with a Web Response, a regular result: only the others write raw replies
            const expected = adapter.name === 'hono' ? APP : undefined
            expect(res.headers['access-control-allow-origin']).toBe(expected as string)
            expect(res.headers['content-security-policy'] === undefined).toBe(adapter.name !== 'hono')
          })
        })

        describe('trusted proxies', () => {
          it('reads x-forwarded-for and x-forwarded-proto behind a trusted (loopback) peer', async () => {
            const res = await send({
              method: 'GET',
              url: '/api/site/client',
              headers: { 'x-forwarded-for': '203.0.113.7, 127.0.0.1', 'x-forwarded-proto': 'https' },
            })
            expect(res.json()).toEqual({ ip: '203.0.113.7', protocol: 'https' })
          })

          it('uses the socket peer without forwarded headers', async () => {
            const res = await send({ method: 'GET', url: '/api/site/client' })
            expect(res.json()).toEqual({ ip: '127.0.0.1', protocol: 'http' })
          })

          it('stops at a malformed entry', async () => {
            const res = await send({
              method: 'GET',
              url: '/api/site/client',
              headers: { 'x-forwarded-for': '203.0.113.7, not-an-ip', 'x-forwarded-proto': 'gopher' },
            })
            expect(res.json()).toEqual({ ip: '127.0.0.1', protocol: 'http' })
          })
        })

        describe('plugin routes', () => {
          it('serves them under the prefix with their metadata', async () => {
            const res = await send({ method: 'GET', url: '/api/status' })
            expect(res.status).toBe(200)
            expect(res.json()).toEqual({ up: true, route: '/api/status', meta: { open: true } })
            const head = await send({ method: 'HEAD', url: '/api/status' })
            expect(head.status).toBe(200)
            expect(head.body).toBe('')
          })

          it('serves wildcards and response headers', async () => {
            const res = await send({ method: 'GET', url: '/api/status/files/a/b.txt' })
            expect(res.body).toBe('file a/b.txt')
            expect(res.headers['cache-control']).toBe('public, max-age=60')
          })

          it('runs the global guards with the route metadata', async () => {
            const before = guardCalls.count
            const denied = await send({ method: 'POST', url: '/api/status/reset', body: { all: true } })
            expect(denied.status).toBe(401)
            expect(denied.headers['www-authenticate']).toBe('ApiKey')
            const allowed = await send({
              method: 'POST',
              url: '/api/status/reset',
              headers: { 'x-api-key': 'secret' },
              body: { all: true },
            })
            expect(allowed.status).toBe(201)
            expect(allowed.json()).toEqual({ reset: { all: true } })
            expect(guardCalls.count).toBe(before + 2)
          })

          it('answers 405 with the methods of the plugin route', async () => {
            const res = await send({ method: 'PUT', url: '/api/status/reset' })
            expect(res.status).toBe(405)
            expect(res.headers['allow']).toBe('POST, OPTIONS')
          })
        })
      })
    }

    it('lists plugin routes in HttpPlugin.routes', () => {
      const routes = app.http.routes
        .filter(entry => entry.source === 'status')
        .map(entry => `${entry.method} ${entry.path}`)
      expect(routes.sort()).toEqual([
        'GET /api/status',
        'GET /api/status/files/*',
        'HEAD /api/status',
        'HEAD /api/status/files/*',
        'POST /api/status/reset',
      ])
      const summary = app.http.routes.find(entry => entry.path === '/api/status' && entry.method === 'GET')
      expect(summary).toMatchObject({
        controller: 'status',
        handler: 'status',
        source: 'status',
        meta: { open: true },
        guards: ['KeyGuard'],
      })
    })

    it('gives plugins the prefix and the container', () => {
      expect(status.prefix).toBe('/api')
      expect(status.context?.prefix).toBe('/api')
      expect(status.context?.container).toBe(app.app.container)
    })
  })
}
