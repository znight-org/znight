import type { TestApp } from '@znight/testing'

import { createHash } from 'node:crypto'
import { HttpPlugin } from '@znight/http'

import { createTestApp } from './support/app.js'
import { committedOpenApi } from './support/openapi.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/**
 * The documentation routes of `OpenApiPlugin`: `GET /openapi.json` and the API reference
 * (`GET /docs`, Scalar). They are plugin routes of `HttpPlugin`: same pipeline as the controllers
 * (request id, security headers, global `AuthGuard`), and the `access` decision given by
 * `meta: [Public.meta()]` (src/http.ts).
 */
describe('documentation routes', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('are public routes of the HTTP plugin, checked by the global guard', () => {
    const routes = app
      .get(HttpPlugin)
      .routes.filter(route => route.source === 'openapi' && route.method !== 'HEAD')
      .map(route => `${route.method} ${route.path} ${JSON.stringify(route.meta)} [${route.guards.join(', ')}]`)

    // no `/docs/_assets/*` route: Scalar comes from the CDN (see below)
    expect(routes).toEqual(['GET /docs {"public":true} [AuthGuard]', 'GET /openapi.json {"public":true} [AuthGuard]'])
  })

  it('serve the document with a strong ETag, revalidated by the clients', async () => {
    const document = await app.inject({ url: '/openapi.json' })
    const etag = String(document.headers.etag)

    expect(document.status).toBe(200)
    expect(etag).toMatch(/^"[\w-]{27}"$/)
    expect(document.headers['cache-control']).toBe('no-cache')

    const unchanged = await app.inject({ url: '/openapi.json', headers: { 'if-none-match': etag } })
    expect(unchanged.status).toBe(304)
    expect(unchanged.body).toBe('')

    const head = await app.inject({ method: 'HEAD', url: '/openapi.json' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(committedOpenApi())))
    expect(head.body).toBe('')
  })

  it('serve the API reference page with its own Content-Security-Policy', async () => {
    const page = await app.inject({ url: '/docs' })
    const csp = String(page.headers['content-security-policy'])

    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body).toContain('<title>Storefront API — API reference</title>')
    // the inline script is allowed by its hash: no 'unsafe-inline' for scripts, no nonce
    const inline = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1] ?? ''
    expect(inline).toContain(`Scalar.createApiReference('#app', {"url":"/openapi.json"`)
    const hash = createHash('sha256').update(inline).digest('base64')
    expect(csp).toContain(`'sha256-${hash}'`)
    expect(csp).toStartWith("default-src 'none'; script-src 'self' https://cdn.jsdelivr.net")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('load Scalar from the CDN version pinned by @znight/openapi, with Subresource Integrity', async () => {
    // `assets: 'auto'`: local assets once `@scalar/api-reference` is installed (`/docs/_assets/...`,
    // `cache-control: immutable`), the pinned jsDelivr build otherwise (this example installs nothing)
    const page = await app.inject({ url: '/docs' })
    const script = /<script src="([^"]+)" integrity="(sha384-[^"]+)" crossorigin="anonymous"><\/script>/.exec(page.body)

    expect(script?.[1]).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\/dist\/browser\/standalone\.js$/,
    )
    expect(script?.[2]).toBeDefined()
    expect((await app.inject({ url: '/docs/_assets/standalone.js' })).status).toBe(404)
  })

  it('go away with DOCS=false', async () => {
    await using internal = await createTestApp({ env: { DOCS: 'false' } })

    expect((await internal.inject({ url: '/openapi.json' })).status).toBe(404)
    expect((await internal.inject({ url: '/docs' })).status).toBe(404)
    expect(internal.get(HttpPlugin).routes.filter(route => route.source === 'openapi')).toEqual([])
  })
})
