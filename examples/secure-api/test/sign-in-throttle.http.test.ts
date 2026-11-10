import type { TestApp } from '@znight/testing'

import { CLIENT_BUDGET } from '../src/security/sign-in-throttle.js'
import { DEVICE_COOKIE } from '../src/session/session-cookies.js'
import { createTestApp } from './support/app.js'
import { ADA, GRACE } from './support/fixtures.js'
import { afterEach, describe, expect, test as it, setSystemTime } from 'bun:test'

const MINUTE = 60_000

function signIn(app: TestApp, ip: string, username: string, password: string, cookies: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/session',
    headers: { 'x-forwarded-for': ip },
    cookies,
    body: { username, password },
  })
}

/**
 * `POST /session` against a brute force on one account: a budget per account and client (address or
 * known device), and the attempts on the account spaced out.
 */
describe('sign-in throttling', () => {
  afterEach(() => {
    setSystemTime()
  })

  it(`refuses an address after ${CLIENT_BUDGET} failures on an account; the real user signs in from another address`, async () => {
    await using app = await createTestApp()
    const start = Date.now()
    setSystemTime(start)

    for (let i = 0; i < CLIENT_BUDGET; i++)
      expect((await signIn(app, '203.0.113.1', ADA.username, 'guess')).status).toBe(401)
    setSystemTime(start + 2 * MINUTE) // past the per-address rate limit (5 a minute): the client budget remains

    const refused = await signIn(app, '203.0.113.1', ADA.username, ADA.password)
    expect(refused.status).toBe(429)
    expect(refused.json()).toMatchObject({ message: 'Too many failed sign-ins' })
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    // the account is not locked: the real user, elsewhere, signs in
    expect((await signIn(app, '198.51.100.7', ADA.username, ADA.password)).status).toBe(200)
    // the attacking address still tries other accounts, within the per-address rate limit
    expect((await signIn(app, '203.0.113.1', 'grace', 'guess')).status).toBe(401)
  })

  it('sets a device cookie on sign-in: a browser that signed in before is not refused by failures from its network', async () => {
    await using app = await createTestApp()
    const start = Date.now()
    setSystemTime(start)

    // the real user signed in from this browser before: it keeps a signed device cookie for ada
    const before = await signIn(app, '2001:db8:1:1::a', ADA.username, ADA.password)
    expect(before.status).toBe(200)
    expect(before.cookies[DEVICE_COOKIE]).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 180 * 86_400,
    })
    const device = { [DEVICE_COOKIE]: before.cookies[DEVICE_COOKIE]?.value ?? '' }
    const graceDevice = (await signIn(app, '198.51.100.20', GRACE.username, GRACE.password)).cookies[DEVICE_COOKIE]

    // an attacker on the same network (the same IPv6 /64, like a NAT address) spends the budget of the address
    setSystemTime(start + 2 * MINUTE)
    for (let i = 0; i < CLIENT_BUDGET; i++)
      expect((await signIn(app, '2001:db8:1:1::b', ADA.username, 'guess')).status).toBe(401)
    setSystemTime(start + 4 * MINUTE)

    // a browser without the cookie, or with a cookie for another name, is refused on that address
    expect((await signIn(app, '2001:db8:1:1::a', ADA.username, ADA.password)).status).toBe(429)
    const otherName = { [DEVICE_COOKIE]: graceDevice?.value ?? '' }
    expect((await signIn(app, '2001:db8:1:1::c', ADA.username, ADA.password, otherName)).status).toBe(429)
    // the real user's browser has a budget of its own
    const after = await signIn(app, '2001:db8:1:1::a', ADA.username, ADA.password, device)
    expect(after.status).toBe(200)
    // a forged cookie is no device
    const [, mac = ''] = device[DEVICE_COOKIE].split('.')
    const forged = `${Buffer.from(JSON.stringify({ name: 'ada', id: 'x', exp: 9e9 })).toString('base64url')}.${mac}`
    setSystemTime(start + 6 * MINUTE)
    const refused = await signIn(app, '2001:db8:1:1::d', ADA.username, ADA.password, { [DEVICE_COOKIE]: forged })
    expect(refused.status).toBe(429)
  })

  it('answers a name that matches no account exactly like a known one, refusals and spacing included', async () => {
    await using app = await createTestApp()
    const start = Date.now()

    const run = async (username: string, ip: string) => {
      setSystemTime(start)
      const answers: { status: number; message: unknown }[] = []
      const durations: number[] = []
      for (let i = 0; i < CLIENT_BUDGET; i++) {
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
    // past the free failures, both are spaced out the same way: the 5th attempt waits 250 ms after the 4th
    for (const { durations } of [known, unknown]) expect(durations[4]).toBeGreaterThanOrEqual(240)
  })
})
