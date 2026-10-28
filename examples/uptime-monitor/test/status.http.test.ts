import type { TestApp } from '@znight/testing'
import type { Health } from '../src/health/health.controller.js'
import type { StatusSnapshot } from '../src/status/status.cache.js'

import { createTestClock } from '@znight/schedule/testing'
import { overrideFactory } from '@znight/testing'

import { ProbeResultRepository } from '../src/monitors/probe-result.repository.js'
import { createTestApp, onlyJobs } from './support/app.js'
import { FakeProber } from './support/fake-prober.js'
import { admin, type Json, TARGET } from './support/fixtures.js'
import { afterEach, describe, expect, test as it } from 'bun:test'

/** The public endpoints: the status page (a per-instance cache) and the health check. */
describe('status and health', () => {
  let app: TestApp | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function createMonitor(app: TestApp, name: string, url: string): Promise<void> {
    const body = { name, url, every: '30s' }
    expect((await app.inject({ method: 'POST', url: '/monitors', headers: admin, body })).status).toBe(201)
  }

  describe('GET /status', () => {
    it('is served from the cache that its jobs refresh', async () => {
      const prober = new FakeProber().answer(`${TARGET}/down`, { status: 500 })
      const clock = createTestClock('2027-01-04T09:00:00Z')
      app = await createTestApp({ clock, prober })
      await createMonitor(app, 'API', TARGET)
      await createMonitor(app, 'Billing', `${TARGET}/down`)

      // refreshed when the scheduler started (runOnStart): the monitors did not exist yet
      const before = await app.inject({ url: '/status' }) // public: no API key
      expect(before.json<Json<StatusSnapshot>>()).toEqual({
        refreshedAt: '2027-01-04T09:00:00.000Z',
        up: 0,
        down: 0,
        monitors: [],
      })

      await clock.advance('1m') // two probes each, then the refresh of 09:01:00

      const snapshot = (await app.inject({ url: '/status' })).json<Json<StatusSnapshot>>()
      expect(snapshot).toMatchObject({ refreshedAt: '2027-01-04T09:01:00.000Z', up: 1, down: 1 })
      expect(snapshot.monitors.map(monitor => [monitor.name, monitor.state, monitor.uptime24h])).toEqual([
        ['API', 'up', 100],
        ['Billing', 'down', 0],
      ])
    })

    it('answers 503 until the first refresh', async () => {
      app = await createTestApp() // no clock: the scheduler is disabled, nothing refreshes the cache

      const response = await app.inject({ url: '/status' })

      expect(response.status).toBe(503)
    })
  })

  describe('GET /health', () => {
    it('reports the scheduler', async () => {
      const clock = createTestClock('2027-01-04T09:00:00Z')
      app = await createTestApp({ clock })

      const response = await app.inject({ url: '/health' })

      expect(response.status).toBe(200)
      expect(response.json<Json<Health>>()).toMatchObject({
        status: 'ok',
        scheduler: { state: 'running', jobs: 5, armed: 5, running: 0 },
        overdue: [],
      })
    })

    it('flags the jobs that missed two occurrences in a row', async () => {
      /** Probes run, but their results cannot be stored: every run of a monitor job fails. */
      class BrokenResults extends ProbeResultRepository {
        override record(): never {
          throw new Error('disk full')
        }
      }
      const clock = createTestClock('2027-01-04T09:00:00Z')
      app = await createTestApp({
        clock,
        jobs: onlyJobs('status-cache.refresh'),
        overrides: [
          overrideFactory(ProbeResultRepository, ([db]) => new BrokenResults(db), {
            deps: ['src/db/database.ts#Database'],
          }),
        ],
      })
      await createMonitor(app, 'API', TARGET)

      await clock.advance('30s') // the first failure: not overdue yet
      expect((await app.inject({ url: '/health' })).json<Json<Health>>().status).toBe('ok')
      await clock.advance('1m') // two more

      const health = (await app.inject({ url: '/health' })).json<Json<Health>>()
      expect(health.status).toBe('degraded')
      expect(health.overdue).toEqual([
        { job: 'monitor.1', schedule: 'every 30s', lastSuccess: null, lastOutcome: 'failed' },
      ])
    })
  })
})
