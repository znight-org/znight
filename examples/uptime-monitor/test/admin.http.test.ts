import type { TestApp } from '@znight/testing'
import type { JobView } from '../src/schedule/jobs.controller.js'

import { SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'

import { createTestApp } from './support/app.js'
import { admin, type Json, reader } from './support/fixtures.js'
import { afterEach, describe, expect, test as it } from 'bun:test'

/**
 * The admin endpoints of the scheduler (`/admin/jobs`): plain routes on the injectable
 * `SchedulerRegistry`, behind the same guard as the rest of the API. The scheduler runs on a virtual
 * clock: `nextRun` values are exact, and time only moves when the test says so.
 */
describe('/admin/jobs', () => {
  let app: TestApp | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  /** Monday 4 January 2027, 09:00:00 UTC (10:00 in Paris). */
  async function start() {
    const clock = createTestClock('2027-01-04T09:00:00Z')
    app = await createTestApp({ clock })
    return { app, clock, registry: app.get(SchedulerRegistry) }
  }

  it('lists every job with its schedule, state and next run', async () => {
    const { app } = await start()

    const response = await app.inject({ url: '/admin/jobs', headers: admin })

    expect(response.status).toBe(200)
    const jobs = response.json<Json<JobView[]>>()
    expect(jobs.map(job => [job.name, job.schedule, job.locked])).toEqual([
      ['digest.daily', '0 8 * * MON-FRI (Europe/Paris)', true],
      ['monitors.sync', 'every 30s', false],
      ['probes.purge', '0 30 3 * * * (UTC)', true],
      ['status-cache.refresh', 'every 1m', false],
      ['status-cache.warm', 'once after 2s', false],
    ])
    expect(jobs.find(job => job.name === 'digest.daily')).toMatchObject({
      kind: 'cron',
      origin: 'decorator',
      state: 'scheduled',
      running: 0,
      // Tuesday 08:00 in Paris (CET, UTC+1): Monday's was at 07:00Z, before the start
      nextRun: '2027-01-05T07:00:00.000Z',
      lastRun: null,
    })
    // runOnStart: the status cache was refreshed when the scheduler started
    expect(jobs.find(job => job.name === 'status-cache.refresh')).toMatchObject({
      nextRun: '2027-01-04T09:01:00.000Z', // epoch-aligned: on the minute, whenever the instance started
      lastRun: { trigger: 'start', outcome: 'completed', scheduledAt: '2027-01-04T09:00:00.000Z' },
    })
  })

  it('shows a job with its next occurrences', async () => {
    const { app } = await start()

    const response = await app.inject({ url: '/admin/jobs/digest.daily', headers: admin })

    expect(response.json()).toMatchObject({
      name: 'digest.daily',
      // weekdays only, at 08:00 Paris time
      upcoming: [
        '2027-01-05T07:00:00.000Z',
        '2027-01-06T07:00:00.000Z',
        '2027-01-07T07:00:00.000Z',
        '2027-01-08T07:00:00.000Z',
        '2027-01-11T07:00:00.000Z',
      ],
    })
    expect((await app.inject({ url: '/admin/jobs/nope', headers: admin })).status).toBe(404)
  })

  it('runs a job on demand: 202 at once, the run goes through the whole pipeline', async () => {
    const { app, registry } = await start()

    const response = await app.inject({ method: 'POST', url: '/admin/jobs/digest.daily/run', headers: admin })

    expect(response.status).toBe(202)
    expect(response.json()).toEqual({ job: 'digest.daily', accepted: true })
    await registry.idle() // the run is in the background: wait for it
    const job = (await app.inject({ url: '/admin/jobs/digest.daily', headers: admin })).json<Json<JobView>>()
    expect(job.lastRun).toMatchObject({
      trigger: 'manual',
      outcome: 'completed',
      scheduledAt: '2027-01-04T09:00:00.000Z', // a manual run stands for the call time
      error: null,
    })
    // the digest went through the real mailer: it is in the outbox
    const outbox = (await app.inject({ url: '/admin/outbox', headers: admin })).json<{ key: string }[]>()
    expect(outbox.map(mail => mail.key)).toEqual(['digest.daily:2027-01-04T09:00:00.000Z'])
  })

  it('pauses and resumes a job', async () => {
    const { app, clock, registry } = await start()

    const paused = await app.inject({ method: 'POST', url: '/admin/jobs/status-cache.refresh/pause', headers: admin })

    expect(paused.json()).toMatchObject({ state: 'paused', nextRun: null })
    await clock.advance('5m')
    const refresh = registry.get('status-cache.refresh')
    expect(refresh?.lastRun?.scheduledAt.toISOString()).toBe('2027-01-04T09:00:00.000Z') // nothing ran

    const resumed = await app.inject({ method: 'POST', url: '/admin/jobs/status-cache.refresh/resume', headers: admin })

    // scheduled again from now: the missed occurrences do not run
    expect(resumed.json()).toMatchObject({ state: 'scheduled', nextRun: '2027-01-04T09:06:00.000Z' })
    await clock.advance('1m')
    expect(refresh?.lastRun?.scheduledAt.toISOString()).toBe('2027-01-04T09:06:00.000Z')
  })

  it('refuses to pause a job that is done', async () => {
    const { app, clock } = await start()
    await clock.advance('2s') // status-cache.warm runs once, 2 s after the start

    const response = await app.inject({ method: 'POST', url: '/admin/jobs/status-cache.warm/pause', headers: admin })

    expect(response.status).toBe(409)
    expect(response.json()).toMatchObject({
      message: 'Job "status-cache.warm" is done: only scheduled jobs can be paused or resumed',
    })
  })

  it('is for administrators only', async () => {
    const { app } = await start()

    expect((await app.inject({ url: '/admin/jobs' })).status).toBe(401)
    expect((await app.inject({ url: '/admin/jobs', headers: reader })).status).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/admin/jobs/digest.daily/run', headers: reader })).status).toBe(
      403,
    )
    expect((await app.inject({ url: '/admin/outbox', headers: reader })).status).toBe(403)
  })
})
