import type { TestApp } from '@znight/testing'
import type { MonitorView } from '../src/monitors/monitor.controller.js'
import type { ProbeResult } from '../src/monitors/monitor.js'
import type { ProbeEventData } from '../src/monitors/probe-events.js'

import { JobAbortedError, SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'

import { createTestApp, onlyJobs } from './support/app.js'
import { FakeProber } from './support/fake-prober.js'
import { admin, type Json, reader, TARGET } from './support/fixtures.js'
import { afterEach, describe, expect, test as it } from 'bun:test'

/** `GET /monitors/:id`, as received. */
type MonitorDetails = Json<MonitorView & { readonly results: ProbeResult[] }>

/**
 * Monitors over HTTP, their dynamic jobs and the live results: the real application on a virtual
 * clock, with a fake network. Creating a monitor adds `monitor.<id>` to the registry; advancing the
 * clock runs it through the real pipeline (lock, scope, hooks) and stores the result.
 */
describe('monitors', () => {
  let app: TestApp | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  /** Monday 4 January 2027, 09:00:00 UTC; only the monitors' jobs run. */
  async function start(prober = new FakeProber()) {
    // probes that hang on purpose make no progress until their signal aborts: do not wait long for them
    const clock = createTestClock('2027-01-04T09:00:00Z', { settleTimeoutMs: 200 })
    app = await createTestApp({ clock, prober, jobs: onlyJobs() })
    return { app, clock, prober, registry: app.get(SchedulerRegistry) }
  }

  async function createMonitor(app: TestApp, body: Record<string, unknown>): Promise<MonitorView> {
    const response = await app.inject({ method: 'POST', url: '/monitors', headers: admin, body })
    expect(response.status).toBe(201)
    return response.json<MonitorView>()
  }

  async function details(app: TestApp, id: number): Promise<MonitorDetails> {
    return (await app.inject({ url: `/monitors/${id}`, headers: reader })).json<MonitorDetails>()
  }

  it('creating a monitor schedules its job at once', async () => {
    const { app, registry } = await start()

    const response = await app.inject({
      method: 'POST',
      url: '/monitors',
      headers: admin,
      body: { name: 'API', url: TARGET, every: '30s' },
    })

    expect(response.status).toBe(201)
    expect(response.headers.location).toBe('/monitors/1')
    expect(response.json()).toMatchObject({
      id: 1,
      schedule: 'every 30s',
      expectedStatus: 200,
      timeoutMs: 10_000,
      // intervals are aligned on the Unix epoch: 09:00:30, whenever the monitor was created
      job: { name: 'monitor.1', state: 'scheduled', nextRun: '2027-01-04T09:00:30.000Z', lastRun: null },
    })
    expect(registry.get('monitor.1')).toMatchObject({ origin: 'dynamic', locked: true, maxDuration: 10_000 })
  })

  it('probes on schedule and records one result per occurrence', async () => {
    const { app, clock, prober } = await start()
    const { id } = await createMonitor(app, { name: 'API', url: TARGET, every: '30s' })

    await clock.advance('1m') // 09:00:30 and 09:01:00

    expect(prober.requestsTo(TARGET)).toHaveLength(2)
    const monitor = await details(app, id)
    expect(monitor.results.map(result => [result.scheduledAt, result.up, result.status])).toEqual([
      ['2027-01-04T09:01:00.000Z', true, 200], // newest first
      ['2027-01-04T09:00:30.000Z', true, 200],
    ])
    expect(monitor.job?.lastRun).toMatchObject({ outcome: 'completed', scheduledAt: '2027-01-04T09:01:00.000Z' })
  })

  it('records a target that answers the wrong status, or nothing, as down', async () => {
    const prober = new FakeProber().answer(TARGET, { status: 503 })
    const { app, clock } = await start(prober)
    const { id } = await createMonitor(app, { name: 'API', url: TARGET, every: '30s' })

    await clock.advance('30s')
    prober.answer(TARGET, 'refused')
    await clock.advance('30s')

    const [refused, unavailable] = (await details(app, id)).results
    expect(unavailable).toMatchObject({ up: false, status: 503, error: 'Expected status 200, got 503' })
    expect(refused).toMatchObject({ up: false, status: null })
    expect(refused?.error).toContain('ECONNREFUSED')
  })

  it("bounds a probe with the monitor's timeout: maxDuration aborts ctx.signal, which aborts fetch", async () => {
    const prober = new FakeProber().answer(TARGET, 'hang')
    const { app, clock } = await start(prober)
    const { id } = await createMonitor(app, { name: 'Slow', url: TARGET, every: '1m', timeout: '5s' })

    await clock.advance('1m') // the probe starts at 09:01:00 and hangs
    const [request] = prober.requests
    expect(request?.signal.aborted).toBe(false)
    await clock.advance('5s') // maxDuration

    expect(request?.signal.reason).toBeInstanceOf(JobAbortedError)
    expect(request?.signal.reason).toMatchObject({ reason: 'timeout' })
    expect((await details(app, id)).results).toMatchObject([
      { up: false, status: null, error: 'No answer within 5000 ms', scheduledAt: '2027-01-04T09:01:00.000Z' },
    ])
  })

  it('cron monitors follow the wall clock of their time zone', async () => {
    const { app, registry } = await start()

    const monitor = await createMonitor(app, {
      name: 'Office hours',
      url: TARGET,
      cron: '*/15 9-18 * * MON-FRI',
      timeZone: 'Europe/Paris',
    })

    expect(monitor.schedule).toBe('*/15 9-18 * * MON-FRI (Europe/Paris)')
    expect(registry.get(`monitor.${monitor.id}`)?.nextRuns(2)).toEqual([
      new Date('2027-01-04T09:15:00Z'), // 10:15 in Paris
      new Date('2027-01-04T09:30:00Z'),
    ])
  })

  it("validates schedules with the scheduler's own engine", async () => {
    const { app } = await start()
    const invalid = async (body: Record<string, unknown>) => {
      const response = await app.inject({ method: 'POST', url: '/monitors', headers: admin, body })
      expect(response.status).toBe(400)
      return response.json<{ details: { path: string; message: string }[] }>().details
    }

    // the message of the build-time diagnostic, for a schedule that comes from a user
    expect(await invalid({ name: 'x', url: TARGET, cron: '0 25 * * *' })).toEqual([
      { path: 'cron', message: expect.stringContaining('hour 25 is out of range (0-23)') },
    ])
    expect(await invalid({ name: 'x', url: TARGET, cron: '0 9 * * *', timeZone: 'Mars/Olympus' })).toEqual([
      { path: 'timeZone', message: expect.stringContaining('Mars/Olympus') },
    ])
    expect(await invalid({ name: 'x', url: TARGET, every: '30 seconds' })).toEqual([
      { path: 'every', message: expect.any(String) },
    ])
    expect(await invalid({ name: 'x', url: TARGET, every: '10ms' })).toEqual([
      { path: 'every', message: 'Probe at most every second' },
    ])
    expect(await invalid({ name: 'x', url: TARGET })).toEqual([
      { path: 'every', message: 'Give either "every" (a duration) or "cron"' },
    ])
    expect(await invalid({ name: 'x', url: TARGET, every: '1m', timeZone: 'Europe/Paris' })).toEqual([
      { path: 'timeZone', message: 'Intervals are durations: use "cron" for wall-clock schedules' },
    ])
  })

  it('deleting a monitor removes its job and aborts a probe in flight', async () => {
    const prober = new FakeProber().answer(TARGET, 'hang')
    const { app, clock, registry } = await start(prober)
    const { id } = await createMonitor(app, { name: 'API', url: TARGET, every: '30s' })
    await clock.advance('30s') // a probe hangs
    const [request] = prober.requests

    const response = await app.inject({ method: 'DELETE', url: `/monitors/${id}`, headers: admin })

    expect(response.status).toBe(204)
    expect(registry.has('monitor.1')).toBe(false)
    expect(request?.signal.reason).toMatchObject({ name: 'JobAbortedError', reason: 'removed' })
    await registry.idle()
    await clock.advance('5m')
    expect(prober.requests).toHaveLength(1) // no more probes
    expect((await app.inject({ url: `/monitors/${id}`, headers: admin })).status).toBe(404)
  })

  it('lets readers list and administrators change', async () => {
    const { app } = await start()
    await createMonitor(app, { name: 'API', url: TARGET, every: '1m' })

    expect((await app.inject({ url: '/monitors' })).status).toBe(401)
    expect((await app.inject({ url: '/monitors', headers: reader })).json()).toMatchObject([{ id: 1, name: 'API' }])
    const body = { name: 'Other', url: TARGET, every: '1m' }
    expect((await app.inject({ method: 'POST', url: '/monitors', headers: reader, body })).status).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/monitors/1', headers: reader })).status).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/monitors/42', headers: admin })).status).toBe(404)
  })

  describe('GET /status/events (Server-Sent Events)', () => {
    it('pushes every probe result as it is recorded', async () => {
      const { app, clock } = await start()
      const { id } = await createMonitor(app, { name: 'API', url: TARGET, every: '30s' })

      await using stream = await app.injectSse({ url: '/status/events' }) // public: no API key
      expect(stream.status).toBe(200)
      expect(stream.retry).toBe(5000)
      await clock.advance('30s')

      const event = await stream.next()
      expect(event.event).toBe('probe')
      expect(event.json<ProbeEventData>()).toEqual({
        monitorId: id,
        up: true,
        status: 200,
        latencyMs: expect.any(Number),
        error: null,
        checkedAt: '2027-01-04T09:00:30.000Z',
        scheduledAt: '2027-01-04T09:00:30.000Z',
      })
    })

    it('replays the results missed while disconnected (Last-Event-ID)', async () => {
      const { app, clock } = await start()
      await createMonitor(app, { name: 'API', url: TARGET, every: '30s' })
      const first = await app.injectSse({ url: '/status/events' })
      await clock.advance('30s')
      const seen = await first.next()
      await first.close()

      await clock.advance('1m') // two results while nobody listens
      await using resumed = await first.reconnect() // sends last-event-id, like EventSource

      const missed = await resumed.take(2)
      expect(missed.map(event => event.json<ProbeEventData>().scheduledAt)).toEqual([
        '2027-01-04T09:01:00.000Z',
        '2027-01-04T09:01:30.000Z',
      ])
      expect(Number(missed[0]?.id)).toBeGreaterThan(Number(seen.id))
      // then the live ones
      await clock.advance('30s')
      expect((await resumed.next()).json<ProbeEventData>().scheduledAt).toBe('2027-01-04T09:02:00.000Z')
    })
  })
})
