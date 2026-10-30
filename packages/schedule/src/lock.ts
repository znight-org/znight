/**
 * One runner across instances (RFC 0004 §4.7, §7.6): leases fenced by the occurrence time. A store
 * accepts a claim only when no lease is live for the key **and** the occurrence is greater than every
 * occurrence claimed before for the key, so two instances never run the same occurrence, whatever
 * their clock skew.
 */
import type { ScheduleClock } from './clock.ts'
import type { Duration } from './duration.ts'

import { systemClock } from './clock.ts'

/**
 * A lock store: Postgres, Redis... (recipes in `test/integration` of this package, see the README), or
 * {@link memoryLockStore}. The scheduler bounds `acquire()` and `release()` by the lease ttl.
 */
export interface ScheduleLockStore {
  /** Store name in logs. */
  readonly name: string
  /**
   * Atomically claims `claim.occurrence` of `key`. Succeeds only when (1) no live lease exists for
   * `key`, and (2) no occurrence greater than or equal to `claim.occurrence` was claimed for `key`
   * before. Resolves `undefined` when refused; rejects when the store fails (the run does not start).
   */
  acquire(key: string, claim: LockClaim): Promise<LockLease | undefined>
}

/** What a run claims. */
export interface LockClaim {
  /** This process in the store (`<hostname>:<pid>:<random>` by default). */
  readonly owner: string
  /** Epoch ms of the occurrence: strictly increasing per job, on every instance. */
  readonly occurrence: number
  /** Lease duration, in milliseconds. */
  readonly ttlMs: number
}

/** A granted claim. */
export interface LockLease {
  /** Extends the lease to `ttlMs` from now; `false` when it was lost (expired, then taken). */
  extend(ttlMs: number): Promise<boolean>
  /** Ends the lease. The occurrence stays claimed. */
  release(): Promise<void>
}

/** The lock store with its settings (`SchedulePlugin.configure({ lock })`). */
export interface ScheduleLockOptions {
  readonly store: ScheduleLockStore
  /** Prefix of the lock keys (`<keyPrefix><job name>`). Default `'znight:schedule:'`. */
  readonly keyPrefix?: string
  /** Lease duration, renewed every third of it while the run lasts. At least 1 s. Default `'30s'`. */
  readonly ttl?: Duration
  /** This process in the store. Default `<hostname>:<pid>:<8 random hex>`. */
  readonly owner?: string
}

/** Options of {@link memoryLockStore}. */
export interface MemoryLockStoreOptions {
  /** Expiry clock. Default: the system clock; pass the test clock to expire leases in virtual time. */
  readonly clock?: ScheduleClock
}

interface MemoryRecord {
  /** Last claimed occurrence. */
  occurrence: number
  /** Identity of the live lease. */
  lease: object
  expiresAt: number
}

/**
 * Process-local store: tests, and several applications in one process. Shares nothing with other
 * processes.
 */
export function memoryLockStore(options: MemoryLockStoreOptions = {}): ScheduleLockStore {
  const clock = options.clock ?? systemClock
  const records = new Map<string, MemoryRecord>()
  return Object.freeze({
    name: 'memory',
    acquire(key: string, claim: LockClaim): Promise<LockLease | undefined> {
      try {
        assertClaim(key, claim)
      } catch (error) {
        return Promise.reject(error)
      }
      const now = clock.now()
      const record = records.get(key)
      if (record !== undefined && (record.expiresAt > now || record.occurrence >= claim.occurrence)) {
        return Promise.resolve(undefined)
      }
      const lease = {}
      records.set(key, { occurrence: claim.occurrence, lease, expiresAt: now + claim.ttlMs })
      const current = (): MemoryRecord | undefined => {
        const found = records.get(key)
        return found?.lease === lease ? found : undefined
      }
      return Promise.resolve<LockLease>({
        extend(ttlMs: number): Promise<boolean> {
          const found = current()
          const at = clock.now()
          if (found === undefined || found.expiresAt <= at) return Promise.resolve(false)
          found.expiresAt = at + ttlMs
          return Promise.resolve(true)
        },
        release(): Promise<void> {
          const found = current()
          if (found !== undefined) found.expiresAt = Math.min(found.expiresAt, clock.now())
          return Promise.resolve()
        },
      })
    },
  })
}

function assertClaim(key: string, claim: LockClaim): void {
  if (typeof key !== 'string' || key === '')
    throw new TypeError('[znight] memoryLockStore: the key must be a non-empty string')
  if (claim === null || typeof claim !== 'object') throw new TypeError('[znight] memoryLockStore: invalid claim')
  if (typeof claim.owner !== 'string' || !Number.isFinite(claim.occurrence) || !(claim.ttlMs > 0)) {
    throw new TypeError('[znight] memoryLockStore: a claim needs an owner, a finite occurrence and a positive ttlMs')
  }
}
