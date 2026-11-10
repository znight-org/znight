import type { TestApp } from '@znight/testing'

import { PAIR_BUDGET } from '../src/security/sign-in-throttle.js'
import { createTestApp } from './support/app.js'
import { ADA } from './support/fixtures.js'
import { afterEach, describe, expect, test as it, setSystemTime } from 'bun:test'

const MINUTE = 60_000

function signIn(app: TestApp, ip: string, username: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/session',
    headers: { 'x-forwarded-for': ip },
    body: { username, password },
  })
}

/** `POST /session` against a brute force on one account: per (account, address) budget, per account slow-down. */
describe('sign-in throttling', () => {
  afterEach(() => {
    setSystemTime()
  })

  it(`refuses an address after ${PAIR_BUDGET} failures on an account; the real user signs in from another address`, async () => {
    await using app = await createTestApp()
    const start = Date.now()
    setSystemTime(start)

    for (let i = 0; i < PAIR_BUDGET; i++)
      expect((await signIn(app, '203.0.113.1', ADA.username, 'guess')).status).toBe(401)
    setSystemTime(start + 2 * MINUTE) // past the per-address rate limit (5 a minute): the pair budget remains

    const refused = await signIn(app, '203.0.113.1', ADA.username, ADA.password)
    expect(refused.status).toBe(429)
    expect(refused.json()).toMatchObject({ message: 'Too many failed sign-ins' })
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    // the account is not locked: the real user, elsewhere, signs in (slowed down, not refused)
    expect((await signIn(app, '198.51.100.7', ADA.username, ADA.password)).status).toBe(200)
    // the attacking address still tries other accounts, within the per-address rate limit
    expect((await signIn(app, '203.0.113.1', 'grace', 'guess')).status).toBe(401)
  })

  it('answers a name that matches no account exactly like a known one, refusals and delays included', async () => {
    await using app = await createTestApp()
    const start = Date.now()

    const run = async (username: string, ip: string) => {
      setSystemTime(start)
      const answers: { status: number; message: unknown }[] = []
      const durations: number[] = []
      for (let i = 0; i < PAIR_BUDGET; i++) {
        const started = performance.now()
        const response = await signIn(app, ip, username, 'guess')
        durations.push(performance.now() - started)
        answers.push({ status: response.status, message: response.json<{ message: unknown }>().message })
      }
      setSystemTime(start + 2 * MINUTE)
      const refused = await signIn(app, ip, username, 'guess')
      answers.push({ status: refused.status, message: refused.json<{ message: unknown }>().message })
      return { answers, durations }
    }

    const known = await run(ADA.username, '203.0.113.1')
    const unknown = await run('mallory', '203.0.113.2')

    expect(unknown.answers).toEqual(known.answers)
    expect(known.answers.at(-1)).toEqual({ status: 429, message: 'Too many failed sign-ins' })
    // past the free failures, both are slowed down the same way (250 ms, then 500 ms)
    for (const { durations } of [known, unknown]) {
      expect(durations[3]).toBeGreaterThanOrEqual(240)
      expect(durations[4]).toBeGreaterThanOrEqual(490)
    }
  })
})
