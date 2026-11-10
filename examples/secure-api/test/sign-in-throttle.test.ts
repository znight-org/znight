import {
  AttemptCounters,
  CLIENT_BUDGET,
  FREE_FAILURES,
  MAX_ENTRIES,
  MAX_INTERVAL_MS,
  MAX_WAIT_MS,
  SignInThrottle,
  WINDOW_MS,
} from '../src/security/sign-in-throttle.js'
import { afterEach, describe, expect, test as it, setSystemTime } from 'bun:test'

/**
 * The throttle without the waits: records the delays it would apply. `clock`: each wait moves the
 * system clock forward instead (a client that waited), for sequential attempts only.
 */
class InstantThrottle extends SignInThrottle {
  readonly delays: number[] = []

  constructor(readonly clock = false) {
    super()
  }

  protected override pause(ms: number): Promise<void> {
    this.delays.push(ms)
    if (this.clock && ms > 0) setSystemTime(new Date(Date.now() + ms))
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

  it(`refuses an address after ${CLIENT_BUDGET} failures on one account, without checking the password`, async () => {
    const throttle = new InstantThrottle()
    for (let i = 0; i < CLIENT_BUDGET; i++)
      expect(await throttle.attempt('ada', { ip: '198.51.100.1' }, WRONG)).toBeUndefined()

    const check = spy()
    const refused = throttle.attempt('ada', { ip: '198.51.100.1' }, check.verify)

    const error = (await refused.catch((rejection: unknown) => rejection)) as { headers: Record<string, string> }
    expect(error).toMatchObject({ status: 429, message: 'Too many failed sign-ins' })
    const retryAfter = Number(error.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000)
    expect(check.ran()).toBe(false) // no hash for a refused attempt
  })

  it('keeps the budget per (account, address): another address and another account are not refused', async () => {
    const throttle = new InstantThrottle()
    for (let i = 0; i < CLIENT_BUDGET; i++) await throttle.attempt('ada', { ip: '198.51.100.1' }, WRONG)

    expect(await outcome(throttle.attempt('ada', { ip: '198.51.100.1' }, RIGHT))).toBe(429)
    expect(await throttle.attempt('ada', { ip: '198.51.100.2' }, RIGHT)).toBe('principal') // the real user, elsewhere
    expect(await throttle.attempt('grace', { ip: '198.51.100.1' }, RIGHT)).toBe('principal')
    // the IPv6 addresses of one /64 share a budget, as for the per-address rate limit
    for (let i = 1; i <= CLIENT_BUDGET; i++) await throttle.attempt('grace', { ip: `2001:db8:1:2::${i}` }, WRONG)
    expect(await outcome(throttle.attempt('grace', { ip: '2001:db8:1:2::ffff' }, RIGHT))).toBe(429)
  })

  it('forgets the failures of a client 15 minutes after the last one', async () => {
    const start = Date.now()
    setSystemTime(start)
    const throttle = new InstantThrottle()
    for (let i = 0; i < CLIENT_BUDGET; i++) await throttle.attempt('ada', { ip: '198.51.100.1' }, WRONG)

    setSystemTime(start + WINDOW_MS - 1000)
    expect(await outcome(throttle.attempt('ada', { ip: '198.51.100.1' }, RIGHT))).toBe(429)
    setSystemTime(start + WINDOW_MS + 1)
    expect(await throttle.attempt('ada', { ip: '198.51.100.1' }, RIGHT)).toBe('principal')
  })

  it('resets the budget of the client on a successful sign-in', async () => {
    setSystemTime(Date.now())
    const throttle = new InstantThrottle(true) // sequential attempts, which wait their turn
    for (let i = 0; i < CLIENT_BUDGET - 1; i++) await throttle.attempt('ada', { ip: '198.51.100.1' }, WRONG)
    expect(await throttle.attempt('ada', { ip: '198.51.100.1' }, RIGHT)).toBe('principal')

    for (let i = 0; i < CLIENT_BUDGET; i++)
      expect(await throttle.attempt('ada', { ip: '198.51.100.1' }, WRONG)).toBeUndefined()
    expect(await outcome(throttle.attempt('ada', { ip: '198.51.100.1' }, RIGHT))).toBe(429)
  })

  it('counts concurrent attempts of a client when they start: a burst cannot overspend the budget', async () => {
    const throttle = new InstantThrottle()
    const burst = Array.from({ length: CLIENT_BUDGET + 3 }, () =>
      outcome(throttle.attempt('ada', { ip: '198.51.100.1' }, WRONG)),
    )

    const outcomes = await Promise.all(burst)
    expect(outcomes.filter(result => result === undefined)).toHaveLength(CLIENT_BUDGET)
    expect(outcomes.filter(result => result === 429)).toHaveLength(3)
  })

  it('does not count an attempt that failed for another reason (503, client gone)', async () => {
    const throttle = new InstantThrottle()
    const busy = (): Promise<undefined> =>
      Promise.reject(Object.assign(new Error('Too many sign-ins in progress'), { status: 503 }))
    for (let i = 0; i < CLIENT_BUDGET * 2; i++)
      expect(await outcome(throttle.attempt('ada', { ip: '198.51.100.1' }, busy))).toBe(503)

    expect(await throttle.attempt('ada', { ip: '198.51.100.1' }, RIGHT)).toBe('principal')
    expect(throttle.delays.every(delay => delay === 0)).toBe(true)
  })

  it('spaces the attempts on an account under attack: the interval grows, then caps', async () => {
    setSystemTime(Date.now())
    const throttle = new InstantThrottle(true)

    // a botnet: one attempt per address, the client budget never runs out
    for (let i = 1; i <= 12; i++) expect(await throttle.attempt('ada', { ip: `203.0.113.${i}` }, WRONG)).toBeUndefined()
    // the real user, from an address of their own, waits for the next slot, and is not refused
    expect(await throttle.attempt('ada', { ip: '198.51.100.7' }, RIGHT)).toBe('principal')

    expect(throttle.delays).toEqual([
      ...Array<number>(FREE_FAILURES + 1).fill(0), // the 4th attempt starts the spacing
      250,
      500,
      1000,
      2000,
      MAX_INTERVAL_MS,
      MAX_INTERVAL_MS,
      MAX_INTERVAL_MS,
      MAX_INTERVAL_MS,
      MAX_INTERVAL_MS, // the real user's attempt
    ])
    expect(MAX_INTERVAL_MS).toBeLessThanOrEqual(5000)
    // other accounts are not slowed down
    await throttle.attempt('grace', { ip: '203.0.113.1' }, WRONG)
    expect(throttle.delays.at(-1)).toBe(0)
  })

  it('spaces parallel attempts from many addresses: one guess per interval, and 429 past a full queue', async () => {
    setSystemTime(Date.now())
    const throttle = new InstantThrottle()
    for (let i = 1; i <= FREE_FAILURES; i++) await throttle.attempt('ada', { ip: `203.0.113.${i}` }, WRONG)

    // a botnet fires 20 guesses at once, each from an address of its own
    const burst = Array.from({ length: 20 }, (_, i) =>
      throttle.attempt('ada', { ip: `192.0.2.${i + 1}` }, WRONG).catch((rejection: unknown) => rejection),
    )
    const outcomes = await Promise.all(burst)

    const queued = MAX_WAIT_MS / 250 + 1 // slots at 0, 250 ms... up to the longest wait allowed
    // each guess waits for a slot of its own, 250 ms after the previous one: not all at once
    expect(throttle.delays.slice(FREE_FAILURES)).toEqual(Array.from({ length: queued }, (_, i) => i * 250))
    expect(outcomes.slice(0, queued).every(result => result === undefined)).toBe(true)
    for (const refused of outcomes.slice(queued)) {
      expect(refused).toMatchObject({ status: 429, message: 'Too many sign-in attempts on this account' })
      const retryAfter = Number((refused as { headers: Record<string, string> }).headers['retry-after'])
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(MAX_WAIT_MS / 1000 + 1) // a few seconds: the account is not locked
    }
  })

  it('gives a known device a budget of its own: a shared address or a full queue does not refuse it', async () => {
    setSystemTime(Date.now())
    const throttle = new InstantThrottle()

    // an attacker on the same network as the user: the same IPv6 /64 (or the same NAT address)
    for (let i = 0; i < CLIENT_BUDGET; i++) await throttle.attempt('ada', { ip: '2001:db8:1:1::b' }, WRONG)
    expect(await outcome(throttle.attempt('ada', { ip: '2001:db8:1:1::a' }, RIGHT))).toBe(429)
    // and the account's queue is full
    const burst = Array.from({ length: 30 }, (_, i) =>
      outcome(throttle.attempt('ada', { ip: `192.0.2.${i + 1}` }, WRONG)),
    )
    expect(await outcome(throttle.attempt('ada', { ip: '198.51.100.9' }, RIGHT))).toBe(429)

    // the real user's browser signed in to ada before: no queue, its own budget
    const delays = throttle.delays.length
    expect(await throttle.attempt('ada', { ip: '2001:db8:1:1::a', device: 'device-of-ada' }, RIGHT)).toBe('principal')
    expect(throttle.delays.slice(delays)).toEqual([0])
    await Promise.all(burst)

    // a device spends its own budget, not its address's
    for (let i = 0; i < CLIENT_BUDGET; i++)
      await throttle.attempt('grace', { ip: '198.51.100.10', device: 'device-of-grace' }, WRONG)
    expect(await outcome(throttle.attempt('grace', { ip: '198.51.100.10', device: 'device-of-grace' }, RIGHT))).toBe(
      429,
    )
    expect(await throttle.attempt('grace', { ip: '198.51.100.11', device: 'other-device' }, RIGHT)).toBe('principal')
  })

  it('forgets the failures of an account 15 minutes after the last one', async () => {
    const start = Date.now()
    setSystemTime(start)
    const throttle = new InstantThrottle()
    for (let i = 1; i <= FREE_FAILURES + 2; i++) await throttle.attempt('ada', { ip: `203.0.113.${i}` }, WRONG)
    expect(throttle.intervalFor('ada')).toBeGreaterThan(0)

    setSystemTime(start + WINDOW_MS + 1)
    expect(throttle.intervalFor('ada')).toBe(0)
  })

  it('waits for real, and stops waiting when the client leaves', async () => {
    const throttle = new SignInThrottle()
    for (let i = 1; i <= FREE_FAILURES; i++) await throttle.attempt('ada', { ip: `203.0.113.${i}` }, WRONG)

    const started = performance.now()
    expect(await throttle.attempt('ada', { ip: '203.0.113.98' }, WRONG)).toBeUndefined() // takes the first slot
    expect(await throttle.attempt('ada', { ip: '203.0.113.99' }, WRONG)).toBeUndefined() // 250 ms later
    expect(performance.now() - started).toBeGreaterThanOrEqual(245)

    const client = new AbortController()
    const check = spy()
    const abandoned = throttle.attempt('ada', { ip: '198.51.100.7' }, check.verify, client.signal)
    client.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    expect(check.ran()).toBe(false)
  })

  it('treats a name that matches no account like any other: the throttle never looks the account up', async () => {
    setSystemTime(Date.now()) // the delays are slot - now: a frozen clock makes the two runs comparable
    const known = new InstantThrottle()
    const unknown = new InstantThrottle()
    const run = async (throttle: InstantThrottle, username: string): Promise<unknown[]> => {
      const outcomes: unknown[] = []
      for (let i = 0; i < CLIENT_BUDGET + 1; i++)
        outcomes.push(await outcome(throttle.attempt(username, { ip: '198.51.100.1' }, WRONG)))
      return outcomes
    }

    expect(await run(unknown, 'mallory')).toEqual(await run(known, 'ada'))
    expect(unknown.delays).toEqual(known.delays)
  })

  it(`keeps at most ${MAX_ENTRIES} client budgets and accounts in memory`, async () => {
    const throttle = new InstantThrottle()

    for (let i = 0; i < MAX_ENTRIES + 500; i++)
      await throttle.attempt(`user-${i}`, { ip: `198.51.${i >> 8}.${i & 255}` }, WRONG)

    expect(throttle.stats).toEqual({ clients: MAX_ENTRIES, accounts: MAX_ENTRIES })
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

  it('hands out the slots of a key one interval apart, and keeps them across increments', () => {
    const start = Date.now()
    setSystemTime(start)
    const counters = new AttemptCounters(60_000, 100)
    expect(counters.reserve('a', 1000)).toBe(0) // no failure, no slot

    counters.increment('a')
    expect([counters.reserve('a', 1000), counters.reserve('a', 1000), counters.reserve('a', 500)]).toEqual([
      0, 1000, 2000,
    ])
    counters.increment('a')
    expect(counters.waitFor('a')).toBe(2500)
    setSystemTime(start + 3000)
    expect(counters.waitFor('a')).toBe(0)
    expect(counters.reserve('a', 1000)).toBe(0)
    setSystemTime(start + 61_000) // expired: its slots too
    expect(counters.waitFor('a')).toBe(0)
  })
})
