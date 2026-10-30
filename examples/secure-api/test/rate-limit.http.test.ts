import { bearer, createTestApp } from './support/app.js'
import { mintToken } from './support/tokens.js'
import { describe, expect, test as it } from 'bun:test'

/** `@RateLimit` and `RateLimitGuard`: per route, per caller (the principal, else the client address). */
describe('rate limiting', () => {
  it('answers 429 with retry-after past the budget of the route, per principal', async () => {
    await using app = await createTestApp()
    const alice = bearer(await mintToken({ sub: 'u-alice', roles: ['editor'] }))
    const bob = bearer(await mintToken({ sub: 'u-bob', roles: ['editor'] }))
    const create = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/notes', headers, body: { text: 'Again' } })

    for (let i = 0; i < 30; i++) expect((await create(alice)).status).toBe(201) // @RateLimit({ points: 30, duration: 60 })
    const limited = await create(alice)

    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60)
    expect(limited.json()).toMatchObject({ message: 'Too many requests' })
    // another principal has a budget of its own; routes without @RateLimit are not limited
    expect((await create(bob)).status).toBe(201)
    expect((await app.inject({ url: '/notes', headers: alice })).status).toBe(200)
  })

  // these sign-ins cost seven scrypt hashes (128 MiB each, on purpose: the decoy of unknown names, then
  // one per attempt that reaches the controller), more than the default 5 s on a busy CI runner
  it('keys anonymous callers by client address (x-forwarded-for behind the trusted proxy)', async () => {
    await using app = await createTestApp()
    const signIn = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/session',
        headers: { 'x-forwarded-for': ip },
        body: { username: 'nobody', password: 'wrong' },
      })

    for (let i = 0; i < 5; i++) expect((await signIn('198.51.100.1')).status).toBe(401) // 5 attempts per minute
    expect((await signIn('198.51.100.1')).status).toBe(429)
    expect((await signIn('198.51.100.2')).status).toBe(401)
  }, 30_000)

  it('does not count requests refused by AuthGuard: they never reach the limiter', async () => {
    await using app = await createTestApp()
    const reader = bearer(await mintToken({ sub: 'u-reader', roles: ['reader'] }))

    for (let i = 0; i < 35; i++) {
      const response = await app.inject({ method: 'POST', url: '/notes', headers: reader, body: { text: 'x' } })
      expect(response.status).toBe(403)
    }
  })
})
