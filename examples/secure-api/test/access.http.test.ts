import type { TestApp } from '@znight/testing'

import { HttpPlugin } from '@znight/http'

import { bearer, createTestApp } from './support/app.js'
import { EXPORT_KEY } from './support/fixtures.js'
import { mintToken } from './support/tokens.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const CHALLENGES = 'Bearer realm="api", ApiKey header="x-api-key"'

/**
 * Every access rule of the API, over the whole pipeline (`app.inject()`): the decisions of the
 * routes, the guards, the 401 challenges and the 403s.
 */
describe('access decisions', () => {
  let app: TestApp
  const tokens: Record<'reader' | 'editor' | 'admin', Record<string, string>> = { reader: {}, editor: {}, admin: {} }

  beforeAll(async () => {
    app = await createTestApp()
    tokens.reader = bearer(await mintToken({ sub: 'u-reader', roles: ['reader'] }))
    tokens.editor = bearer(await mintToken({ sub: 'u-editor', roles: ['editor'] }))
    tokens.admin = bearer(await mintToken({ sub: 'u-admin', roles: ['admin'] }))
  })

  afterAll(async () => {
    await app.close()
  })

  it('answers 401 with every challenge on every route that is not public', async () => {
    const routes = app.get(HttpPlugin).routes.filter(route => route.method !== 'HEAD' && route.meta.public !== true)
    expect(routes.length).toBe(11)

    for (const route of routes) {
      const response = await app.inject({ method: route.method, url: route.path.replace(':id', 'n-1'), body: {} })
      expect({ route: `${route.method} ${route.path}`, status: response.status }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 401,
      })
      expect(response.headers['www-authenticate']).toBe(CHALLENGES)
      expect(response.json()).toMatchObject({ statusCode: 401, message: 'Authentication required' })
    }
  })

  it('serves the public routes to anyone', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' })
    expect((await app.inject({ url: '/status' })).json()).toMatchObject({ status: 'ok' })
    // public, but not open: the signature guard of the route still runs
    const webhook = await app.inject({ method: 'POST', url: '/webhooks/billing', body: {} })
    expect(webhook.status).toBe(401)
    expect(webhook.json()).toMatchObject({ message: 'Missing signature' })
  })

  it('accepts any authenticated caller on @Authenticated routes', async () => {
    const me = await app.inject({ url: '/me', headers: tokens.reader })

    expect(me.status).toBe(200)
    expect(me.json()).toMatchObject({ id: 'u-reader', roles: ['reader'], via: 'token' })
    expect((await app.inject({ url: '/notes', headers: tokens.reader })).status).toBe(200)
  })

  it('answers 403 when the caller lacks the role of the route', async () => {
    const note = { text: 'Meeting notes' }

    expect((await app.inject({ method: 'POST', url: '/notes', headers: tokens.reader, body: note })).status).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/notes', headers: tokens.editor, body: note })).status).toBe(201)

    expect((await app.inject({ url: '/admin/notes', headers: tokens.editor })).status).toBe(403)
    expect((await app.inject({ url: '/admin/notes', headers: tokens.admin })).status).toBe(200)
  })

  it("lets a route's decision replace its controller's", async () => {
    // AdminController is @Roles(['admin']), its export route @Roles(['admin', 'exporter'])
    const exporter = { 'x-api-key': EXPORT_KEY }
    expect((await app.inject({ url: '/admin/export', headers: exporter })).status).toBe(200)
    expect((await app.inject({ url: '/admin/export', headers: tokens.admin })).status).toBe(200)
    expect((await app.inject({ url: '/admin/notes', headers: exporter })).status).toBe(403)
  })

  /**
   * The former fail-open: with route metadata merged key by key, `@Public()` on StatusController and
   * `@Roles(['admin'])` on `details` gave `{ public: true, roles: ['admin'] }`, and a guard checking
   * `public` first served the admin route to anyone.
   */
  it('keeps /status/details admin-only on a public controller', async () => {
    const details = app.get(HttpPlugin).routes.find(route => route.path === '/status/details')
    expect(details?.meta).toEqual({ roles: ['admin'] })

    expect((await app.inject({ url: '/status/details' })).status).toBe(401)
    expect((await app.inject({ url: '/status/details', headers: tokens.reader })).status).toBe(403)
    const admin = await app.inject({ url: '/status/details', headers: tokens.admin })
    expect(admin.status).toBe(200)
    expect(admin.json()).toMatchObject({ status: 'ok', inflightRequests: 1, passwordHashing: { running: 0 } })
  })

  it('refuses to boot when no guard enforces the access decisions (ZNIGHT023)', async () => {
    // a second entrypoint (a worker, a test) that forgets `guards: [AuthGuard, ...]`
    const unguarded = HttpPlugin.configure({ port: 0, cookies: { secrets: 'x'.repeat(32) } })
    const boot = createTestApp({ http: unguarded })

    await expect(boot).rejects.toMatchObject({ code: 'ZNIGHT023' })
    await expect(boot).rejects.toThrow('No guard enforces the required "access" group on 15 routes')
    // the rate-limited routes are reported too: their decision is enforced by RateLimitGuard only
    await expect(boot).rejects.toThrow('"rateLimit"')
  })
})
