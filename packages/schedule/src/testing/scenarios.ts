import type { LockLease, ScheduleLockStore } from '../lock.ts'

import { randomUUID } from 'node:crypto'

/** A conformance scenario of {@link ScheduleLockStore}: `run` throws on failure (runner-agnostic). */
export interface LockStoreScenario {
  readonly name: string
  /**
   * Runs the scenario against a store built by `create` (called once per scenario). Keys are random,
   * so one store may serve every scenario. Takes up to about one second (real-time lease expiry).
   */
  run(create: () => ScheduleLockStore | Promise<ScheduleLockStore>): Promise<void>
}

/** Lease duration of the expiry scenarios. */
const SHORT_TTL = 300
/** Long enough for a short lease to expire, whatever the store's clock resolution. */
const EXPIRY_WAIT = 500

/**
 * The semantics every lock store must implement (RFC 0004 §7.6): claim and refuse, monotonic
 * occurrences, expiry, extension, extension after a takeover, stale release, keys independence and
 * one winner among concurrent claims.
 *
 * ```ts
 * for (const scenario of lockStoreScenarios) {
 *   test(`PostgresLockStore: ${scenario.name}`, () => scenario.run(() => new PostgresLockStore(db)))
 * }
 * ```
 */
export const lockStoreScenarios: readonly LockStoreScenario[] = Object.freeze([
  scenario('claims a free key and refuses a claim while the lease is live', async store => {
    const key = randomKey()
    const lease = expectLease(await store.acquire(key, claim('a', 1000)), 'the first claim of a free key')
    expectRefused(await store.acquire(key, claim('b', 2000)), 'a later occurrence while the lease is live')
    await lease.release()
  }),
  scenario('refuses an occurrence not greater than the last claimed one', async store => {
    const key = randomKey()
    await expectLease(await store.acquire(key, claim('a', 1000)), 'occurrence 1000').release()
    expectRefused(await store.acquire(key, claim('b', 1000)), 'the same occurrence after its release')
    expectRefused(await store.acquire(key, claim('b', 999)), 'an earlier occurrence')
    await expectLease(await store.acquire(key, claim('b', 1001)), 'a later occurrence after the release').release()
  }),
  scenario('release frees the key for a later occurrence', async store => {
    const key = randomKey()
    const lease = expectLease(await store.acquire(key, claim('a', 1000, 60_000)), 'occurrence 1000')
    await lease.release()
    await expectLease(await store.acquire(key, claim('b', 2000)), 'occurrence 2000 after the release').release()
  }),
  scenario('a lease expires after its ttl', async store => {
    const key = randomKey()
    expectLease(await store.acquire(key, claim('a', 1000, SHORT_TTL)), 'occurrence 1000')
    expectRefused(await store.acquire(key, claim('b', 2000)), 'a claim before the expiry')
    await sleep(EXPIRY_WAIT)
    await expectLease(await store.acquire(key, claim('b', 2000)), 'a claim after the expiry').release()
  }),
  scenario('extend keeps a lease alive', async store => {
    const key = randomKey()
    const lease = expectLease(await store.acquire(key, claim('a', 1000, SHORT_TTL)), 'occurrence 1000')
    await sleep(SHORT_TTL / 2)
    expectEqual(await lease.extend(SHORT_TTL * 2), true, 'extend() of a live lease')
    await sleep(SHORT_TTL)
    expectRefused(await store.acquire(key, claim('b', 2000)), 'a claim while the extended lease is live')
    await lease.release()
  }),
  scenario('extend after expiry and takeover returns false; a stale release keeps the new lease', async store => {
    const key = randomKey()
    const first = expectLease(await store.acquire(key, claim('a', 1000, SHORT_TTL)), 'occurrence 1000')
    await sleep(EXPIRY_WAIT)
    const second = expectLease(await store.acquire(key, claim('b', 2000, 60_000)), 'the takeover of an expired lease')
    expectEqual(await first.extend(SHORT_TTL), false, 'extend() of a lease taken over')
    expectEqual(await second.extend(60_000), true, 'extend() of the new lease')
    await first.release()
    expectRefused(await store.acquire(key, claim('c', 3000)), 'a claim after a stale release (the new lease is live)')
    await second.release()
  }),
  scenario('keys are independent', async store => {
    const first = randomKey()
    const second = randomKey()
    const a = expectLease(await store.acquire(first, claim('a', 1000)), 'the first key')
    const b = expectLease(await store.acquire(second, claim('a', 1000)), 'the second key, same occurrence')
    await a.release()
    await b.release()
  }),
  scenario('ten concurrent claims of one occurrence have exactly one winner', async store => {
    const key = randomKey()
    const leases = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.acquire(key, claim(`owner-${index}`, 5000))),
    )
    const winners = leases.filter((lease): lease is LockLease => lease !== undefined)
    expectEqual(winners.length, 1, 'winners among ten concurrent claims')
    await winners[0]?.release()
  }),
])

function scenario(name: string, body: (store: ScheduleLockStore) => Promise<void>): LockStoreScenario {
  return Object.freeze({
    name,
    async run(create: () => ScheduleLockStore | Promise<ScheduleLockStore>): Promise<void> {
      const store = await create()
      try {
        await body(store)
      } catch (error) {
        if (error instanceof Error) error.message = `[lock store '${store.name}'] ${name}: ${error.message}`
        throw error
      }
    },
  })
}

function claim(
  owner: string,
  occurrence: number,
  ttlMs = 10_000,
): { owner: string; occurrence: number; ttlMs: number } {
  return { owner: `scenario-${owner}`, occurrence, ttlMs }
}

function randomKey(): string {
  return `znight:schedule:scenario:${randomUUID()}`
}

function expectLease(lease: LockLease | undefined, what: string): LockLease {
  if (
    lease === undefined ||
    lease === null ||
    typeof lease.extend !== 'function' ||
    typeof lease.release !== 'function'
  ) {
    throw new Error(`expected a lease for ${what}, got ${String(lease)}`)
  }
  return lease
}

function expectRefused(lease: LockLease | undefined, what: string): void {
  if (lease !== undefined) throw new Error(`expected ${what} to be refused, got a lease`)
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
