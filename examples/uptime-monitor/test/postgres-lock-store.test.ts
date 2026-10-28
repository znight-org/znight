import { PGlite } from '@electric-sql/pglite'
import { SchedulePlugin } from '@znight/schedule'
import { lockStoreScenarios } from '@znight/schedule/testing'

import { pgliteDatabase } from '../src/db/database.js'
import { migrate } from '../src/db/migrations.js'
import { PostgresLockStore } from '../src/schedule/postgres-lock-store.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/**
 * The Postgres lock store against the conformance scenarios of `@znight/schedule/testing`: claim and
 * refuse, occurrence fencing, expiry, extension, takeover, stale release, ten concurrent claims with
 * one winner. On PGlite here (in-process, the table created by the application's migrations); the
 * same SQL runs on a PostgreSQL server.
 */
describe('PostgresLockStore', () => {
  let client: PGlite
  let store: PostgresLockStore

  beforeAll(async () => {
    client = await PGlite.create()
    await migrate(client)
    store = new PostgresLockStore(pgliteDatabase(client))
  })

  afterAll(async () => {
    await client.close()
  })

  for (const scenario of lockStoreScenarios) {
    it(scenario.name, async () => {
      await expect(scenario.run(() => store)).resolves.toBeUndefined() // a scenario throws on failure
    }, 10_000)
  }

  it('keeps one row per job: the lease and the last claimed occurrence', async () => {
    const lease = await store.acquire('znight:schedule:digest.daily', {
      owner: 'host:1:a',
      occurrence: 1000,
      ttlMs: 30_000,
    })
    await lease?.release()

    const rows = await client.query<{ occurrence: string; owner: string; live: boolean }>(
      'SELECT occurrence::text, owner, expires_at > clock_timestamp() AS live FROM znight_schedule_locks WHERE key = $1',
      ['znight:schedule:digest.daily'],
    )
    // released: no longer live, but the occurrence stays claimed (fencing)
    expect(rows.rows).toEqual([{ occurrence: '1000', owner: 'host:1:a', live: false }])
  })

  it('is accepted by SchedulePlugin', () => {
    expect(() => SchedulePlugin.configure({ lock: { store, ttl: '30s' } })).not.toThrow()
    expect(store.name).toBe('postgres')
  })
})
