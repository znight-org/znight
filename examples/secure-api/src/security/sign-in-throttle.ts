import { setTimeout as sleep } from 'node:timers/promises'
import { Injectable } from '@znight/core'
import { TooManyRequestsException } from '@znight/http'

import { addressKey } from './rate-limit.js'

export const WINDOW_MS = 15 * 60_000 // failures are forgotten 15 minutes after the last one
export const CLIENT_BUDGET = 5 // failed attempts per account and client (address or known device), then refused
export const FREE_FAILURES = 3 // failures on an account before its attempts are spaced out
export const BASE_INTERVAL_MS = 250 // then one attempt every 250 ms, 500 ms, 1 s, 2 s...
export const MAX_INTERVAL_MS = 4000 // ...up to one every 4 s, from all unknown clients together
export const MAX_WAIT_MS = 4000 // a longer queue on the account: 429 for that attempt, retry in a few seconds
export const MAX_ENTRIES = 10_000 // budgets and accounts kept in memory, each (least recently failed out first)

/**
 * Counters that expire `windowMs` after their last increment, at most `capacity` of them: beyond,
 * the least recently incremented key is dropped. A Map keeps insertion order, and an increment moves
 * its key to the end: the first keys are the oldest, so expired keys are swept from the start.
 * Each counter also holds the next free slot of its key (see {@link reserve}).
 */
export class AttemptCounters {
  readonly #entries = new Map<string, { count: number; expiresAt: number; nextSlot: number }>()

  constructor(
    readonly windowMs: number,
    readonly capacity: number,
  ) {}

  get size(): number {
    return this.#entries.size
  }

  count(key: string): number {
    return this.#live(key)?.count ?? 0
  }

  msBeforeReset(key: string): number {
    const entry = this.#entries.get(key)
    return entry === undefined ? 0 : Math.max(0, entry.expiresAt - Date.now())
  }

  increment(key: string): number {
    const now = Date.now()
    const live = this.#live(key)
    this.#entries.delete(key)
    for (const [oldest, entry] of this.#entries) {
      if (entry.expiresAt > now && this.#entries.size < this.capacity) break
      this.#entries.delete(oldest) // expired, or the least recently incremented one past the capacity
    }
    const count = (live?.count ?? 0) + 1
    this.#entries.set(key, { count, expiresAt: now + this.windowMs, nextSlot: live?.nextSlot ?? 0 })
    return count
  }

  /** Gives back an increment, without extending the expiry. */
  decrement(key: string): void {
    const entry = this.#entries.get(key)
    if (entry !== undefined) entry.count = Math.max(0, entry.count - 1)
  }

  /** How long an attempt starting now would wait for the next free slot of `key`, in milliseconds. */
  waitFor(key: string): number {
    const entry = this.#live(key)
    return entry === undefined ? 0 : Math.max(0, entry.nextSlot - Date.now())
  }

  /**
   * Takes the next free slot of `key` (now, or later when earlier attempts hold the slots before it)
   * and keeps the following one `intervalMs` after it. Returns the wait until the slot taken. A key
   * without failures has no slots: no wait.
   */
  reserve(key: string, intervalMs: number): number {
    const entry = this.#live(key)
    if (entry === undefined) return 0
    const now = Date.now()
    const slot = Math.max(now, entry.nextSlot)
    entry.nextSlot = slot + intervalMs
    return slot - now
  }

  delete(key: string): void {
    this.#entries.delete(key)
  }

  #live(key: string): { count: number; expiresAt: number; nextSlot: number } | undefined {
    const entry = this.#entries.get(key)
    return entry !== undefined && entry.expiresAt > Date.now() ? entry : undefined
  }
}

/** Who is signing in: the client address, and the device id of a valid device cookie for that name. */
export interface SignInClient {
  readonly ip: string | undefined
  /** Set only when the request carries a device cookie signed for the submitted name. */
  readonly device?: string | undefined
}

/**
 * Protects password sign-in against guessing on one account (OWASP Authentication and Credential
 * Stuffing cheat sheets, device cookies), on top of the per-address `@RateLimit` of the route:
 *
 * - **per account and client**: after 5 failures, that client is refused on that account (429)
 *   until 15 minutes after the last one. The client is the address (IPv6: its /64), or the device
 *   when the request carries a device cookie that a successful sign-in to this account set: failures
 *   from a shared address (NAT, office or café network) never refuse a device the user signed in from.
 * - **per account**: past 3 failures from any client, the attempts of clients without a device
 *   cookie take turns: one every 250 ms, then 500 ms, 1 s, 2 s, up to one every 4 seconds, all
 *   addresses together. A botnet gets at most one guess per interval on the account, however many
 *   addresses it holds. An attempt that would wait more than 4 s is refused (429, `retry-after` of a
 *   few seconds), never the account: known devices skip the queue, so the attacker cannot lock their
 *   user out; a user on a new device may have to retry while the account is under attack.
 *
 * Both are keyed by the submitted name, whether an account has it or not: the answers and their
 * timing do not tell which names exist. A successful sign-in resets the budget of its client; the
 * account's failures stay, or an attacker would start afresh each time the user signs in.
 */
@Injectable()
export class SignInThrottle {
  readonly #clients = new AttemptCounters(WINDOW_MS, MAX_ENTRIES)
  readonly #accounts = new AttemptCounters(WINDOW_MS, MAX_ENTRIES)

  /**
   * Runs `verify` (the password check, resolving to `undefined` for wrong credentials) unless the
   * client spent its budget on this account, in the next free slot of the account. `signal`: the
   * client left (`ctx.signal`), stop waiting.
   */
  async attempt<T>(
    username: string,
    client: SignInClient,
    verify: () => Promise<T | undefined>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const known = client.device !== undefined
    const key = `${known ? `device:${client.device}` : addressKey(client.ip)}\n${username}`
    // decided and counted when it starts, before any await: a burst of parallel attempts cannot overspend
    if (this.#clients.count(key) >= CLIENT_BUDGET) {
      throw tooMany('Too many failed sign-ins', this.#clients.msBeforeReset(key))
    }
    let wait = 0
    if (!known) {
      const queued = this.#accounts.waitFor(username)
      if (queued > MAX_WAIT_MS) throw tooMany('Too many sign-in attempts on this account', queued)
      wait = this.#accounts.reserve(username, this.intervalFor(username))
    }
    this.#clients.increment(key)
    let result: T | undefined
    try {
      await this.pause(wait, signal)
      result = await verify()
    } catch (error) {
      this.#clients.decrement(key) // not a failed guess (hasher busy, client gone): no charge
      throw error
    }
    if (result === undefined) this.#accounts.increment(username)
    else this.#clients.delete(key)
    return result
  }

  /** The minimum interval between two attempts on this account (unknown clients), in milliseconds. */
  intervalFor(username: string): number {
    const failures = this.#accounts.count(username)
    return failures < FREE_FAILURES ? 0 : Math.min(BASE_INTERVAL_MS * 2 ** (failures - FREE_FAILURES), MAX_INTERVAL_MS)
  }

  /** Client budgets and accounts with recent failures (bounded by `MAX_ENTRIES` each). */
  get stats(): { readonly clients: number; readonly accounts: number } {
    return { clients: this.#clients.size, accounts: this.#accounts.size }
  }

  protected pause(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return ms > 0 ? sleep(ms, undefined, signal === undefined ? undefined : { signal }) : Promise.resolve()
  }
}

function tooMany(message: string, ms: number): TooManyRequestsException {
  return new TooManyRequestsException(message, undefined, {
    headers: { 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) },
  })
}
