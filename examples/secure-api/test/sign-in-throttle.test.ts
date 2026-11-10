import {
  AttemptCounters,
  FREE_FAILURES,
  MAX_DELAY_MS,
  MAX_ENTRIES,
  PAIR_BUDGET,
  SignInThrottle,
  WINDOW_MS,
} from '../src/security/sign-in-throttle.js'
import { afterEach, describe, expect, test as it, setSystemTime } from 'bun:test'

/** The throttle without the waits: records the delays it would apply. */
class InstantThrottle extends SignInThrottle {
  readonly delays: number[] = []

  protected override pause(ms: number): Promise<void> {
    this.delays.push(ms)
    return Promise.resolve()
  }
}

const WRONG = (): Promise<undefined> => Promise.resolve(undefined)
const RIGHT = (): Promise<string> => Promise.resolve('principal')

/** A password check that records whether it ran. */
function spy(): { readonly verify: () => Promise<string>; readonly ran: () => boolean } {
  let ran = false
  return {
    verify: () => {
      ran = true
      return RIGHT()
    },
    ran: () => ran,
  }
}

/** The status of an attempt: the result, or the status of the exception it threw. */
async function outcome(attempt: Promise<unknown>): Promise<unknown> {
  try {
    return await attempt
  } catch (error) {
    return (error as { status?: number }).status ?? error
  }
}

describe('SignInThrottle', () => {
  afterEach(() => {
    setSystemTime()
  })

  it(`refuses an address after ${PAIR_BUDGET} failures on one account, without checking the password`, async () => {
    const throttle = new InstantThrottle()
    for (let i = 0; i < PAIR_BUDGET; i++) expect(await throttle.attempt('ada', '198.51.100.1', WRONG)).toBeUndefined()

    const check = spy()
    const refused = throttle.attempt('ada', '198.51.100.1', check.verify)

    const error = (await refused.catch((rejection: unknown) => rejection)) as { headers: Record<string, string> }
    expect(error).toMatchObject({ status: 429, message: 'Too many failed sign-ins' })
    const retryAfter = Number(error.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000)
    expect(check.ran()).toBe(false) // no hash for a refused attempt
  })

  it('keeps the budget per (account, address): another address and another account are not refused', async () => {
    const throttle = new InstantThrottle()
    for (let i = 0; i < PAIR_BUDGET; i++) await throttle.attempt('ada', '198.51.100.1', WRONG)

    expect(await outcome(throttle.attempt('ada', '198.51.100.1', RIGHT))).toBe(429)
    expect(await throttle.attempt('ada', '198.51.100.2', RIGHT)).toBe('principal') // the real user, elsewhere
    expect(await throttle.attempt('grace', '198.51.100.1', RIGHT)).toBe('principal')
    // the IPv6 addresses of one /64 share a budget, as for the per-address rate limit
    for (let i = 1; i <= PAIR_BUDGET; i++) await throttle.attempt('grace', `2001:db8:1:2::${i}`, WRONG)
    expect(await outcome(throttle.attempt('grace', '2001:db8:1:2::ffff', RIGHT))).toBe(429)
  })

  it('forgets the failures of a pair 15 minutes after the last one', async () => {
    const start = Date.now()
    setSystemTime(start)
    const throttle = new InstantThrottle()
    for (let i = 0; i < PAIR_BUDGET; i++) await throttle.attempt('ada', '198.51.100.1', WRONG)

    setSystemTime(start + WINDOW_MS - 1000)
    expect(await outcome(throttle.attempt('ada', '198.51.100.1', RIGHT))).toBe(429)
    setSystemTime(start + WINDOW_MS + 1)
    expect(await throttle.attempt('ada', '198.51.100.1', RIGHT)).toBe('principal')
  })

  it('resets the budget of the pair on a successful sign-in', async () => {
    const throttle = new InstantThrottle()
    for (let i = 0; i < PAIR_BUDGET - 1; i++) await throttle.attempt('ada', '198.51.100.1', WRONG)
    expect(await throttle.attempt('ada', '198.51.100.1', RIGHT)).toBe('principal')

    for (let i = 0; i < PAIR_BUDGET; i++) expect(await throttle.attempt('ada', '198.51.100.1', WRONG)).toBeUndefined()
    expect(await outcome(throttle.attempt('ada', '198.51.100.1', RIGHT))).toBe(429)
  })

  it('counts concurrent attempts of a pair when they start: a burst cannot overspend the budget', async () => {
    const throttle = new InstantThrottle()
    const burst = Array.from({ length: PAIR_BUDGET + 3 }, () => outcome(throttle.attempt('ada', '198.51.100.1', WRONG)))

    const outcomes = await Promise.all(burst)
    expect(outcomes.filter(result => result === undefined)).toHaveLength(PAIR_BUDGET)
    expect(outcomes.filter(result => result === 429)).toHaveLength(3)
  })

  it('does not count an attempt that failed for another reason (503, client gone)', async () => {
    const throttle = new InstantThrottle()
    const busy = (): Promise<undefined> =>
      Promise.reject(Object.assign(new Error('Too many sign-ins in progress'), { status: 503 }))
    for (let i = 0; i < PAIR_BUDGET * 2; i++)
      expect(await outcome(throttle.attempt('ada', '198.51.100.1', busy))).toBe(503)

    expect(await throttle.attempt('ada', '198.51.100.1', RIGHT)).toBe('principal')
    expect(throttle.delays.every(delay => delay === 0)).toBe(true)
  })

  it('slows every address down on an account under attack: the delay grows, then caps, and never refuses', async () => {
    const throttle = new InstantThrottle()

    // a botnet: one attempt per address, the pair budget never runs out
    for (let i = 1; i <= 12; i++) expect(await throttle.attempt('ada', `203.0.113.${i}`, WRONG)).toBeUndefined()
    // the real user, from an address of their own, is slowed down, not refused
    expect(await throttle.attempt('ada', '198.51.100.7', RIGHT)).toBe('principal')

    expect(throttle.delays).toEqual([
      ...Array<number>(FREE_FAILURES).fill(0),
      250,
      500,
      1000,
      2000,
      MAX_DELAY_MS,
      MAX_DELAY_MS,
      MAX_DELAY_MS,
      MAX_DELAY_MS,
      MAX_DELAY_MS,
      MAX_DELAY_MS, // the real user's attempt
    ])
    expect(MAX_DELAY_MS).toBeLessThanOrEqual(5000)
    // other accounts are not slowed down
    await throttle.attempt('grace', '203.0.113.1', WRONG)
    expect(throttle.delays.at(-1)).toBe(0)
  })

  it('forgets the failures of an account 15 minutes after the last one', async () => {
    const start = Date.now()
    setSystemTime(start)
    const throttle = new InstantThrottle()
    for (let i = 1; i <= FREE_FAILURES + 2; i++) await throttle.attempt('ada', `203.0.113.${i}`, WRONG)
    expect(throttle.delayFor('ada')).toBeGreaterThan(0)

    setSystemTime(start + WINDOW_MS + 1)
    expect(throttle.delayFor('ada')).toBe(0)
  })

  it('waits for real, and stops waiting when the client leaves', async () => {
    const throttle = new SignInThrottle()
    for (let i = 1; i <= FREE_FAILURES; i++) await throttle.attempt('ada', `203.0.113.${i}`, WRONG)

    const started = performance.now()
    expect(await throttle.attempt('ada', '203.0.113.99', WRONG)).toBeUndefined()
    expect(performance.now() - started).toBeGreaterThanOrEqual(240) // the first delay: 250 ms

    const client = new AbortController()
    const check = spy()
    const abandoned = throttle.attempt('ada', '198.51.100.7', check.verify, client.signal)
    client.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    expect(check.ran()).toBe(false)
  })

  it('treats a name that matches no account like any other: the throttle never looks the account up', async () => {
    const known = new InstantThrottle()
    const unknown = new InstantThrottle()
    const run = async (throttle: InstantThrottle, username: string): Promise<unknown[]> => {
      const outcomes: unknown[] = []
      for (let i = 0; i < PAIR_BUDGET + 1; i++)
        outcomes.push(await outcome(throttle.attempt(username, '198.51.100.1', WRONG)))
      return outcomes
    }

    expect(await run(unknown, 'mallory')).toEqual(await run(known, 'ada'))
    expect(unknown.delays).toEqual(known.delays)
  })

  it(`keeps at most ${MAX_ENTRIES} pairs and accounts in memory`, async () => {
    const throttle = new InstantThrottle()

    for (let i = 0; i < MAX_ENTRIES + 500; i++)
      await throttle.attempt(`user-${i}`, `198.51.${i >> 8}.${i & 255}`, WRONG)

    expect(throttle.stats).toEqual({ pairs: MAX_ENTRIES, accounts: MAX_ENTRIES })
  })
})

describe('AttemptCounters', () => {
  afterEach(() => {
    setSystemTime()
  })

  it('counts per key, and evicts the least recently counted key beyond its capacity', () => {
    const counters = new AttemptCounters(60_000, 3)
    counters.increment('a')
    counters.increment('b')
    counters.increment('c')
    counters.increment('a') // a is the most recent now
    counters.increment('d') // evicts b

    expect(counters.size).toBe(3)
    expect([counters.count('a'), counters.count('b'), counters.count('c'), counters.count('d')]).toEqual([2, 0, 1, 1])
  })

  it('drops expired keys as new ones come in', () => {
    const start = Date.now()
    setSystemTime(start)
    const counters = new AttemptCounters(60_000, 100)
    for (let i = 0; i < 50; i++) counters.increment(`old-${i}`)

    setSystemTime(start + 60_001)
    counters.increment('new')

    expect(counters.size).toBe(1)
    expect(counters.count('old-0')).toBe(0)
  })

  it('tells how long before a key is forgotten', () => {
    const start = Date.now()
    setSystemTime(start)
    const counters = new AttemptCounters(60_000, 100)
    counters.increment('a')

    setSystemTime(start + 20_000)
    expect(counters.msBeforeReset('a')).toBe(40_000)
    expect(counters.msBeforeReset('b')).toBe(0)
  })
})
