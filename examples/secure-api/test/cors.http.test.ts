import type { TestApp } from '@znight/testing'

import { bearer, createTestApp } from './support/app.js'
import { BROWSER_ORIGIN } from './support/fixtures.js'
import { mintToken } from './support/tokens.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const EVIL_ORIGIN = 'https://evil.example'

/** CORS (`cors` option of `httpPlugin()`): answered by the pipeline, before the guards. */
describe('CORS', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  function preflight(origin: string, method: string, url = '/notes', requestHeaders = 'authorization') {
    return app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': requestHeaders,
      },
    })
  }

  it('answers the preflight of an allowed origin with 204, without credentials (never a 401)', async () => {
    const response = await preflight(BROWSER_ORIGIN, 'POST', '/notes', 'authorization, content-type')

    expect(response.status).toBe(204)
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': BROWSER_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
    })
    expect(response.headers.vary).toContain('origin')
    expect(response.headers['www-authenticate']).toBeUndefined()
  })

  it('answers the preflight of an admin route too: guards never run on preflights', async () => {
    const response = await preflight(BROWSER_ORIGIN, 'GET', '/status/details')

    expect(response.status).toBe(204)
  })

  it('refuses the preflight of another origin with 403, without CORS headers', async () => {
    const response = await preflight(EVIL_ORIGIN, 'DELETE', '/notes/n-1', 'x-csrf-token')

    expect(response.status).toBe(403)
    expect(response.json()).toMatchObject({ message: 'CORS origin not allowed' })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers 404 to the preflight of a path without route', async () => {
    expect((await preflight(BROWSER_ORIGIN, 'GET', '/nope')).status).toBe(404)
  })

  it('adds the CORS headers to the replies to an allowed origin, errors included', async () => {
    const token = bearer(await mintToken({ sub: 'u-1', roles: ['editor'] }))
    const created = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: { ...token, origin: BROWSER_ORIGIN },
      body: { text: 'From the browser' },
    })
    const denied = await app.inject({ url: '/notes', headers: { origin: BROWSER_ORIGIN } })

    for (const response of [created, denied]) {
      expect(response.headers['access-control-allow-origin']).toBe(BROWSER_ORIGIN)
      expect(response.headers['access-control-allow-credentials']).toBe('true')
      // a page may read where the note is, and when to retry after a 429
      expect(response.headers['access-control-expose-headers']).toBe('location, retry-after, x-request-id')
    }
    expect(created.status).toBe(201)
    expect(denied.status).toBe(401)
  })

  it('serves another origin normally, without CORS headers: CORS is not access control', async () => {
    const response = await app.inject({ url: '/status', headers: { origin: EVIL_ORIGIN } })

    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers.vary).toContain('origin') // shared caches keep one reply per origin
  })
})
