import { setTimeout as sleep } from 'node:timers/promises'
import { Injectable } from '@znight/core'
import { TooManyRequestsException } from '@znight/http'

import { addressKey } from './rate-limit.js'

export const WINDOW_MS = 15 * 60_000 // failures are forgotten 15 minutes after the last one
export const PAIR_BUDGET = 5 // failed attempts per account and address, then that address is refused
export const FREE_FAILURES = 3 // failures on an account before its attempts are slowed down
export const BASE_DELAY_MS = 250 // then 250 ms, 500 ms, 1 s, 2 s...
export const MAX_DELAY_MS = 4000 // ...up to 4 s per attempt: slowed down, never refused
export const MAX_ENTRIES = 10_000 // pairs and accounts kept in memory, each (least recently failed out first)

/**
 * Counters that expire `windowMs` after their last increment, at most `capacity` of them: beyond,
 * the least recently incremented key is dropped. A Map keeps insertion order, and an increment moves
 * its key to the end: the first keys are the oldest, so expired keys are swept from the start.
 */
export class AttemptCounters {
  readonly #entries = new Map<string, { count: number; expiresAt: number }>()

  constructor(
    readonly windowMs: number,
    readonly capacity: number,
  ) {}

  get size(): number {
    return this.#entries.size
  }

  count(key: string): number {
    const entry = this.#entries.get(key)
    return entry !== undefined && entry.expiresAt > Date.now() ? entry.count : 0
  }

  msBeforeReset(key: string): number {
    const entry = this.#entries.get(key)
    return entry === undefined ? 0 : Math.max(0, entry.expiresAt - Date.now())
  }

  increment(key: string): number {
    const now = Date.now()
    const count = this.count(key) + 1
    this.#entries.delete(key)
    for (const [oldest, entry] of this.#entries) {
      if (entry.expiresAt > now && this.#entries.size < this.capacity) break
      this.#entries.delete(oldest) // expired, or the least recently incremented one past the capacity
    }
    this.#entries.set(key, { count, expiresAt: now + this.windowMs })
    return count
  }

  /** Gives back an increment, without extending the expiry. */
  decrement(key: string): void {
    const entry = this.#entries.get(key)
    if (entry !== undefined) entry.count = Math.max(0, entry.count - 1)
  }

  delete(key: string): void {
    this.#entries.delete(key)
  }
}

/**
 * Protects password sign-in against guessing on one account (OWASP Authentication and Credential
 * Stuffing cheat sheets), on top of the per-address `@RateLimit` of the route:
 *
 * - **per account and address**: after 5 failures, that address is refused on that account (429)
 *   until 15 minutes after the last one. Other addresses, the real user's included, are not.
 * - **per account**: past 3 failures from any address, each attempt waits before the password is
 *   checked, twice as long each time, up to 4 seconds. A botnet spreading its guesses is slowed
 *   down, and the account is never locked: a username is all it takes to lock someone out.
 *
 * Both are keyed by the submitted name, whether an account has it or not: the answers and their
 * timing do not tell which names exist. A successful sign-in resets the budget of its address; the
 * account's failures stay, or an attacker would start afresh each time the user signs in.
 */
@Injectable()
export class SignInThrottle {
  readonly #pairs = new AttemptCounters(WINDOW_MS, MAX_ENTRIES)
  readonly #accounts = new AttemptCounters(WINDOW_MS, MAX_ENTRIES)

  /**
   * Runs `verify` (the password check, resolving to `undefined` for wrong credentials) unless the
   * address spent its budget on this account, after the delay of the account. `signal`: the client
   * left (`ctx.signal`), stop waiting.
   */
  async attempt<T>(
    username: string,
    ip: string | undefined,
    verify: () => Promise<T | undefined>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const pair = `${addressKey(ip)}\n${username}`
    // counted when it starts, before any await: a burst of parallel attempts cannot overspend
    if (this.#pairs.count(pair) >= PAIR_BUDGET) {
      throw new TooManyRequestsException('Too many failed sign-ins', undefined, {
        headers: { 'retry-after': String(Math.ceil(this.#pairs.msBeforeReset(pair) / 1000)) },
      })
    }
    this.#pairs.increment(pair)
    let result: T | undefined
    try {
      await this.pause(this.delayFor(username), signal)
      result = await verify()
    } catch (error) {
      this.#pairs.decrement(pair) // not a failed guess (hasher busy, client gone): no charge
      throw error
    }
    if (result === undefined) this.#accounts.increment(username)
    else this.#pairs.delete(pair)
    return result
  }

  /** The wait before the next attempt on this account, in milliseconds. */
  delayFor(username: string): number {
    const failures = this.#accounts.count(username)
    return failures < FREE_FAILURES ? 0 : Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_FAILURES), MAX_DELAY_MS)
  }

  /** Pairs and accounts with recent failures (bounded by `MAX_ENTRIES` each). */
  get stats(): { readonly pairs: number; readonly accounts: number } {
    return { pairs: this.#pairs.size, accounts: this.#accounts.size }
  }

  protected pause(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return ms > 0 ? sleep(ms, undefined, signal === undefined ? undefined : { signal }) : Promise.resolve()
  }
}
