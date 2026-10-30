import type { TestApp } from '@znight/testing'

import { bearer, createTestApp, testJwksServer } from './support/app.js'
import {
  AUDIENCE,
  confusedToken,
  foreignToken,
  ISSUER,
  mintToken,
  tokenWithoutSubject,
  unsecuredToken,
} from './support/tokens.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** The answer to an invalid token (RFC 6750). */
const REJECTED = {
  status: 401,
  challenge: 'Bearer realm="api", error="invalid_token"',
  body: { statusCode: 401, error: 'Unauthorized', message: 'Invalid token' },
}
const now = (): number => Math.floor(Date.now() / 1000)

/**
 * The JWT recipe (`TokenVerifier`) against real tokens: signed by the test key pair, verified with
 * the key set fetched over HTTP from a local identity provider (`support/jwks-server.ts`).
 */
describe('bearer tokens', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  /** The answer of `GET /me` to a token (awaited when it is still being signed). */
  async function me(token: string | Promise<string>): Promise<{ status: number; challenge: unknown; body: unknown }> {
    const response = await app.inject({ url: '/me', headers: bearer(await token) })
    return { status: response.status, challenge: response.headers['www-authenticate'], body: response.json() }
  }

  it('accepts a token of the identity provider for this API', async () => {
    const response = await me(await mintToken({ sub: 'u-1', roles: ['reader', 'editor'] }))

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ id: 'u-1', roles: ['reader', 'editor'], via: 'token' })
  })

  it('keeps only the roles the API knows', async () => {
    const response = await me(await mintToken({ sub: 'u-1', roles: ['reader', 'superuser', 'ADMIN'] }))

    expect(response.body).toMatchObject({ roles: ['reader'] })
  })

  it('rejects expired tokens and tokens not valid yet, beyond 30 s of clock skew', async () => {
    expect(await me(mintToken({ sub: 'u-1', exp: now() - 60 }))).toEqual(REJECTED)
    expect(await me(mintToken({ sub: 'u-1', nbf: now() + 120 }))).toEqual(REJECTED)
    // within the tolerance: accepted
    expect((await me(await mintToken({ sub: 'u-1', exp: now() - 10 }))).status).toBe(200)
    expect((await me(await mintToken({ sub: 'u-1', nbf: now() + 10 }))).status).toBe(200)
  })

  it('rejects tokens of another audience or issuer: another API of the same provider', async () => {
    expect(await me(mintToken({ sub: 'u-1', aud: 'https://billing.test' }))).toEqual(REJECTED)
    expect(await me(mintToken({ sub: 'u-1', iss: 'https://evil.test/' }))).toEqual(REJECTED)
    expect([ISSUER, AUDIENCE]).toEqual(['https://id.test/', 'https://api.test'])
  })

  it('rejects forged tokens: alg none, HS256 signed with the public key, another key, no subject', async () => {
    expect(await me(unsecuredToken('u-1', ['admin']))).toEqual(REJECTED)
    expect(await me(confusedToken('u-1', ['admin']))).toEqual(REJECTED)
    expect(await me(foreignToken('u-1', ['admin']))).toEqual(REJECTED)
    expect(await me(tokenWithoutSubject())).toEqual(REJECTED)
    expect(await me('not-a-jwt')).toEqual(REJECTED)
  })

  it('rejects a key id the key set does not hold', async () => {
    expect(await me(mintToken({ sub: 'u-1', kid: 'rotated-away' }))).toEqual(REJECTED)
  })

  it('treats a malformed authorization header as no credentials', async () => {
    const response = await app.inject({ url: '/me', headers: { authorization: 'Basic dXNlcjpwYXNz' } })

    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer realm="api", ApiKey header="x-api-key"')
  })

  it('fetches the key set once, then serves it from its cache', async () => {
    const idp = await testJwksServer()
    const jwksUrl = `${idp.jwksUrl}?cache-test`
    await using cached = await createTestApp({ env: { AUTH_JWKS_URL: jwksUrl } })

    for (const sub of ['u-1', 'u-2', 'u-3']) {
      const response = await cached.inject({ url: '/me', headers: bearer(await mintToken({ sub })) })
      expect(response.status).toBe(200)
    }
    expect(idp.hits('/jwks.json?cache-test')).toBe(1)
  })
})

describe('an unavailable identity provider', () => {
  /** 503 and `retry-after`, never 401: clients would drop valid tokens and send their users to log in again. */
  const UNAVAILABLE = { status: 503, retryAfter: '5', challenge: undefined, message: 'Token verification unavailable' }

  async function answerWith(jwksUrl: string) {
    await using app = await createTestApp({ env: { AUTH_JWKS_URL: jwksUrl } })
    const response = await app.inject({ url: '/me', headers: bearer(await mintToken({ sub: 'u-1' })) })
    return {
      status: response.status,
      retryAfter: response.headers['retry-after'],
      challenge: response.headers['www-authenticate'],
      message: response.json<{ message: string }>().message,
    }
  }

  it('answers 503 when the key set endpoint fails', async () => {
    expect(await answerWith((await testJwksServer()).brokenUrl)).toEqual(UNAVAILABLE)
  })

  it('answers 503 when the identity provider is unreachable', async () => {
    const { createServer } = await import('node:net')
    // a port that was free a moment ago: nothing listens there any more
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as { port: number }
    await new Promise<void>(resolve => closed.close(() => resolve()))

    expect(await answerWith(`http://127.0.0.1:${port}/jwks.json`)).toEqual(UNAVAILABLE)
  })
})
