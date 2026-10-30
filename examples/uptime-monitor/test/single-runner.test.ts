import type { ScheduledRunEvent } from '@znight/core'
import type { TestApp } from '@znight/testing'
import type { MonitorView } from '../src/monitors/monitor.controller.js'

import { PGlite } from '@electric-sql/pglite'
import { SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'

import { createTestApp, onlyJobs } from './support/app.js'
import { FakeProber } from './support/fake-prober.js'
import { admin, TARGET } from './support/fixtures.js'
import { afterAll, describe, expect, test as it } from 'bun:test'

/**
 * Two instances of the application sharing one database (so one Postgres lock store) and one clock:
 * a deployment with two replicas, in one process. Every occurrence of a locked job runs on exactly
 * one of them, and a crashed or stuck instance blocks its job for one lease at most.
 */
describe('one runner across instances', () => {
  const apps: TestApp[] = []
  let database: PGlite

  afterAll(async () => {
    for (const app of apps) await app.close()
    await database?.close()
  })

  /** Outcomes of the occurrences of `job`, by occurrence, on every instance. */
  function recordOutcomes(job: string): Map<string, string[]> {
    const outcomes = new Map<string, string[]>()
    for (const app of apps) {
      app.app.hooks.on('schedule:run', (event: ScheduledRunEvent) => {
        if (event.job !== job) return
        const at = new Date(event.scheduledAt).toISOString()
        outcomes.set(at, [...(outcomes.get(at) ?? []), event.outcome ?? 'unknown'].sort())
      })
    }
    return outcomes
  }

  it('runs each occurrence once, then takes over a job whose instance stopped mid-run', async () => {
    database = await PGlite.create()
    // ticks of a stalled probe make no progress: do not wait long for them
    const clock = createTestClock('2027-01-04T09:00:00Z', { settleTimeoutMs: 200 })
    const prober = new FakeProber()
    const setup = {
      clock,
      prober,
      database,
      jobs: onlyJobs(), // the decorated jobs are not under test
      // a short lease (on the database clock), and a short drain so that a stuck run is abandoned fast
      env: { SCHEDULE_LOCK_TTL: '2s', SCHEDULE_DRAIN_TIMEOUT_MS: '100' },
    }
    const first = await createTestApp(setup)
    apps.push(first)
    const created = await first.inject({
      method: 'POST',
      url: '/monitors',
      headers: admin,
      body: { name: 'API', url: TARGET, every: '30s' },
    })
    const { job } = created.json<MonitorView>()
    const second = await createTestApp(setup)
    apps.push(second)
    // the second instance found the monitor in the database when it started
    expect(second.get(SchedulerRegistry).has('monitor.1')).toBe(true)
    const outcomes = recordOutcomes('monitor.1')

    await clock.advance('2m') // 09:00:30, 09:01:00, 09:01:30, 09:02:00

    expect(prober.requests).toHaveLength(4) // one probe per occurrence, not two
    expect([...outcomes]).toEqual(
      ['09:00:30', '09:01:00', '09:01:30', '09:02:00'].map(time => [
        `2027-01-04T${time}.000Z`,
        ['completed', 'not-acquired'], // one instance probed, the other was refused the lease
      ]),
    )
    expect(job?.name).toBe('monitor.1')

    // The next probe never ends, even when its signal is aborted (a client ignoring it).
    prober.answerOnce(TARGET, 'stall')
    await clock.advance('30s') // 09:02:30
    const running = (app: TestApp): number => app.get(SchedulerRegistry).get('monitor.1')?.running ?? 0
    // whichever instance claimed the occurrence holds the stalled run
    const [holder, other] = running(first) === 1 ? [first, second] : [second, first]
    expect([running(holder), running(other)]).toEqual([1, 0])

    // The holder stops: its run ignores the shutdown signal, so it is abandoned after the drain
    // timeout. Its lease is NOT released: the run may still be writing.
    await holder.close()
    await clock.advance('30s') // 09:03:00
    expect(other.get(SchedulerRegistry).get('monitor.1')?.lastRun).toMatchObject({
      outcome: 'not-acquired',
      scheduledAt: new Date('2027-01-04T09:03:00Z'),
    })

    // Once the lease expired (2 s on the database clock), the other instance takes the job over.
    await Bun.sleep(2_200)
    await clock.advance('30s') // 09:03:30
    expect(other.get(SchedulerRegistry).get('monitor.1')?.lastRun).toMatchObject({
      outcome: 'completed',
      scheduledAt: new Date('2027-01-04T09:03:30Z'),
    })
    expect(prober.requests).toHaveLength(6) // the stalled one and the takeover: 09:03:00 never ran
  }, 20_000)
})
