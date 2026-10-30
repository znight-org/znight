import type { SchedulePluginInstance } from '@znight/schedule'

import { PGlite } from '@electric-sql/pglite'
import { SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'
import { overrideFactory } from '@znight/testing'

import { ProbeResultRepository } from '../src/monitors/probe-result.repository.js'
import { createTestApp, onlyJobs } from './support/app.js'
import { FakeProber } from './support/fake-prober.js'
import { admin, TARGET } from './support/fixtures.js'
import { afterEach, describe, expect, test as it } from 'bun:test'

/**
 * Graceful shutdown with jobs in flight. On `stop()` (SIGTERM), the scheduler aborts the signal of
 * every running run (`shutdown`) **at once**, then waits for them: cooperative jobs return early and
 * the drain completes in milliseconds instead of `drainTimeoutMs`.
 */
describe('shutdown', () => {
  let database: PGlite | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  it('a running purge receives the shutdown and returns between two batches', async () => {
    database = await PGlite.create()
    /** Opens after the first batch: the test stops the application while the purge is in flight. */
    const firstBatch = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    let batches = 0
    class PausingResults extends ProbeResultRepository {
      override async purgeBatch(before: Date, limit: number): Promise<number> {
        const deleted = await super.purgeBatch(before, limit)
        if (++batches === 1) {
          firstBatch.resolve()
          await proceed.promise
        }
        return deleted
      }
    }
    const app = await createTestApp({
      database,
      env: { PROBES_PURGE_BATCH_SIZE: '10', PROBES_RETENTION_DAYS: '30' },
      overrides: [
        overrideFactory(ProbeResultRepository, ([db]) => new PausingResults(db), {
          deps: ['src/db/database.ts#Database'],
        }),
      ],
    })
    // 25 results from last year: three batches of work
    await database.exec(`
      INSERT INTO monitors (name, url, expected_status, every_ms, timeout_ms) VALUES ('API', '${TARGET}', 200, 60000, 1000);
      INSERT INTO probe_results (monitor_id, scheduled_at, checked_at, up, latency_ms)
        SELECT 1, t, t, true, 10 FROM generate_series(now() - interval '400 days', now() - interval '376 days', interval '1 day') AS t;
    `)

    const run = app.get(SchedulerRegistry).trigger('probes.purge') // the pipeline of a scheduled run
    await firstBatch.promise
    const started = performance.now()
    const stopping = app.close()
    // the scheduler aborts the runs as soon as it stops (HTTP stops first: plugins stop in reverse order)
    const plugin = app.app.getPlugin<SchedulePluginInstance>('schedule')
    while (plugin?.state !== 'stopping') await Bun.sleep(1)
    proceed.resolve() // the first batch completes, the loop sees the signal

    expect(await run).toMatchObject({ outcome: 'completed', aborted: 'shutdown' })
    await stopping
    expect(performance.now() - started).toBeLessThan(1_000) // drained, not abandoned after 4 s
    expect(batches).toBe(1)
    // the rest waits for the next night
    const { rows } = await database.query<{ count: number }>('SELECT count(*)::int AS count FROM probe_results')
    expect(rows[0]?.count).toBe(15)
  })

  it('a probe in flight is aborted, records nothing, and the drain completes', async () => {
    const clock = createTestClock('2027-01-04T09:00:00Z', { settleTimeoutMs: 100 })
    const prober = new FakeProber().answer(TARGET, 'hang')
    database = await PGlite.create()
    const app = await createTestApp({ clock, prober, database, jobs: onlyJobs() })
    await app.inject({
      method: 'POST',
      url: '/monitors',
      headers: admin,
      body: { name: 'API', url: TARGET, every: '30s' },
    })
    await clock.advance('30s')
    const [request] = prober.requests
    expect(app.get(SchedulerRegistry).get('monitor.1')?.running).toBe(1)

    await app.close()

    expect(request?.signal.aborted).toBe(true) // fetch gets the abort: the connection is closed
    const { rows } = await database.query('SELECT * FROM probe_results')
    expect(rows).toEqual([]) // the target is not to blame for our shutdown
  })
})
