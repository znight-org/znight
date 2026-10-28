import { bearer, createTestApp } from './support/app.js'
import { mintToken } from './support/tokens.js'
import { expect, test as it } from 'bun:test'

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store', // added by httpPlugin(): answers depend on the caller
}

/** The security headers are on by default, on every reply: successes, refusals and unknown routes. */
it('security headers on 200, 401, 403, 404 and 405', async () => {
  await using app = await createTestApp()
  const reader = bearer(await mintToken({ sub: 'u-1', roles: ['reader'] }))

  const responses = {
    ok: await app.inject({ url: '/notes', headers: reader }),
    unauthorized: await app.inject({ url: '/notes' }),
    forbidden: await app.inject({ url: '/admin/notes', headers: reader }),
    notFound: await app.inject({ url: '/nope' }),
    methodNotAllowed: await app.inject({ method: 'PUT', url: '/notes' }),
  }

  expect(Object.values(responses).map(response => response.status)).toEqual([200, 401, 403, 404, 405])
  for (const response of Object.values(responses)) expect(response.headers).toMatchObject(SECURITY_HEADERS)
  // no HSTS from the application: the TLS terminator sets it
  expect(responses.ok.headers['strict-transport-security']).toBeUndefined()
})
