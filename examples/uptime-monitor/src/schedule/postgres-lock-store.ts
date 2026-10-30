/**
 * A PostgreSQL lock store for `@znight/schedule`: one runner per occurrence across the instances
 * sharing the database. The recipe of the scheduling guide, tested by
 * `test/postgres-lock-store.test.ts` (the conformance scenarios of `@znight/schedule/testing`, on
 * PGlite) and used by `plugins.ts`.
 *
 * One row per job. A claim is one atomic upsert: it takes the row only when its lease expired **and**
 * the claimed occurrence is later than the last claimed one (occurrence fencing). Expiry uses the
 * database clock, so instance clocks do not matter. A random token identifies the lease for `extend`
 * and `release`, so a stale lease never touches the lease that took over.
 *
 * The table is created by a migration ({@link POSTGRES_LOCK_TABLE}, `db/migrations.ts`). The store
 * takes a tiny `query(sql, params)` port returning the rows, so it works with any client: the
 * application's `Database` here (`plugins.ts`), and elsewhere:
 *
 * ```ts
 * // Bun
 * import { SQL } from 'bun'
 * const sql = new SQL(process.env.DATABASE_URL)
 * const store = new PostgresLockStore({ query: (text, params) => sql.unsafe(text, [...params]) })
 *
 * // node-postgres
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * const store = new PostgresLockStore({ query: async (text, params) => (await pool.query(text, [...params])).rows })
 * ```
 */
import type { LockClaim, LockLease, ScheduleLockStore } from '@znight/schedule'

import { randomUUID } from 'node:crypto'

/** What the store needs from a Postgres client: a parameterized query returning its rows. */
export interface PostgresQuery {
  query(sql: string, params: readonly unknown[]): Promise<readonly unknown[]>
}

/** The table of the leases: one row per job (create it in a migration). */
export const POSTGRES_LOCK_TABLE = `CREATE TABLE IF NOT EXISTS znight_schedule_locks (
  key text PRIMARY KEY,
  occurrence bigint NOT NULL,
  owner text NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL
)`

/** $1 key, $2 occurrence, $3 owner, $4 token, $5 ttl ms: a row back when the claim is granted. */
const ACQUIRE = `INSERT INTO znight_schedule_locks AS lock (key, occurrence, owner, token, expires_at)
VALUES ($1, $2, $3, $4, clock_timestamp() + $5::double precision * interval '1 millisecond')
ON CONFLICT (key) DO UPDATE
  SET occurrence = excluded.occurrence, owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at
  WHERE lock.expires_at <= clock_timestamp() AND lock.occurrence < excluded.occurrence
RETURNING token`

/** $1 key, $2 token, $3 ttl ms: a row back while the lease is live. */
const EXTEND = `UPDATE znight_schedule_locks
SET expires_at = clock_timestamp() + $3::double precision * interval '1 millisecond'
WHERE key = $1 AND token = $2 AND expires_at > clock_timestamp()
RETURNING token`

/** $1 key, $2 token: ends a live lease (the occurrence stays claimed). */
const RELEASE = `UPDATE znight_schedule_locks SET expires_at = clock_timestamp()
WHERE key = $1 AND token = $2 AND expires_at > clock_timestamp()`

export class PostgresLockStore implements ScheduleLockStore {
  readonly name = 'postgres'

  constructor(private readonly db: PostgresQuery) {}

  async acquire(key: string, claim: LockClaim): Promise<LockLease | undefined> {
    const token = randomUUID()
    const rows = await this.db.query(ACQUIRE, [key, claim.occurrence, claim.owner, token, claim.ttlMs])
    if (rows.length !== 1) return undefined
    return {
      extend: async ttlMs => (await this.db.query(EXTEND, [key, token, ttlMs])).length === 1,
      release: async () => {
        await this.db.query(RELEASE, [key, token])
      },
    }
  }
}
