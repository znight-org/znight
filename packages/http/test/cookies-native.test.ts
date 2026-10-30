/**
 * Cookies set by the native framework before the Znight route (Express middleware, Fastify hooks,
 * Hono middleware) are kept next to the plugin's (RFC 0006: cookies behave the same on every
 * adapter), for plain and event-stream replies, in memory and over the network.
 */
import type { HttpAdapter } from '../src/index.ts'

import express from 'express'
import Fastify from 'fastify'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'

import { expressAdapter } from '../src/adapters/express.ts'
import { fastifyAdapter } from '../src/adapters/fastify.ts'
import { honoAdapter } from '../src/adapters/hono.ts'
import { HttpResponse } from '../src/index.ts'
import { controller, createApp, metadata, provider, route, type TestApp, TRANSPORTS, t } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const NATIVE = 'csrf=token; Path=/'
const DEFAULTS = 'Path=/; Secure; HttpOnly; SameSite=Lax'

class CookieController {
  none() {
    return 'none'
  }
  set() {
    return 'set'
  }
  response() {
    return HttpResponse.ok('response').withCookie('reply', '2')
  }
  events() {
    return HttpResponse.sse([{ data: 'a' }]).withCookie('turn', '1')
  }
}

function cookieMetadata() {
  return metadata({ [t('CookieController')]: provider(CookieController) }, [
    controller(t('CookieController'), '/', [
      route('none', '/none', (c: CookieController) => c.none()),
      route('set', '/set', (c: CookieController, ctx) => {
        ctx.setCookie('app', '1')
        return c.set()
      }),
      route('response', '/response', (c: CookieController) => c.response()),
      route('events', '/events', (c: CookieController, ctx) => {
        ctx.setCookie('app', '1')
        return c.events()
      }),
    ]),
  ])
}

/** Adapters whose native application sets the `csrf` cookie before the Znight routes. */
const NATIVE_ADAPTERS: readonly { readonly name: string; readonly create: () => HttpAdapter }[] = [
  {
    name: 'express (res.cookie in a middleware)',
    create: () => {
      const app = express()
      app.use((_req, res, next) => {
        res.cookie('csrf', 'token')
        next()
      })
      return expressAdapter({ app })
    },
  },
  {
    name: 'fastify (reply.header in an onRequest hook)',
    create: () => {
      const instance = Fastify()
      instance.addHook('onRequest', (_request, reply, done) => {
        reply.header('set-cookie', NATIVE)
        done()
      })
      return fastifyAdapter({ instance })
    },
  },
  {
    name: 'hono (setCookie in a middleware)',
    create: () => {
      const app = new Hono()
      app.use(async (c, next) => {
        setCookie(c, 'csrf', 'token', { path: '/' })
        await next()
      })
      return honoAdapter({ app })
    },
  },
  {
    name: 'hono (a middleware reading c.res first)',
    create: () => {
      const app = new Hono()
      app.use(async (c, next) => {
        c.res.headers.set('x-touched', '1')
        setCookie(c, 'csrf', 'token', { path: '/' })
        await next()
      })
      return honoAdapter({ app })
    },
  },
]

for (const adapter of NATIVE_ADAPTERS) {
  describe(adapter.name, () => {
    let app: TestApp

    beforeAll(async () => {
      app = await createApp(cookieMetadata(), { adapter: adapter.create() })
    })

    afterAll(async () => {
      await app.stop()
    })

    for (const transport of TRANSPORTS) {
      describe(transport.name, () => {
        it('keeps the native cookie alone', async () => {
          const res = await transport.create(app.http)({ method: 'GET', url: '/none' })
          expect(res.body).toBe('none')
          expect(res.headers['set-cookie']).toEqual([NATIVE])
        })

        it('keeps the native cookie before ctx.setCookie()', async () => {
          const res = await transport.create(app.http)({ method: 'GET', url: '/set' })
          expect(res.body).toBe('set')
          expect(res.headers['set-cookie']).toEqual([NATIVE, `app=1; ${DEFAULTS}`])
        })

        it('keeps the native cookie before the cookies of an HttpResponse', async () => {
          const res = await transport.create(app.http)({ method: 'GET', url: '/response' })
          expect(res.headers['set-cookie']).toEqual([NATIVE, `reply=2; ${DEFAULTS}`])
        })

        it('keeps the native cookie on an event stream', async () => {
          let headers: Record<string, string | string[]>
          let body: string
          if (transport.name === 'inject') {
            const res = await app.http.injectStream({ method: 'GET', url: '/events' })
            headers = res.headers
            body = await new Response(res.body).text()
          } else {
            const res = await transport.create(app.http)({ method: 'GET', url: '/events' })
            headers = res.headers
            body = res.body
          }
          expect(headers['content-type']).toStartWith('text/event-stream')
          expect(body).toContain('data: a')
          expect(headers['set-cookie']).toEqual([NATIVE, `app=1; ${DEFAULTS}`, `turn=1; ${DEFAULTS}`])
        })
      })
    }
  })
}
