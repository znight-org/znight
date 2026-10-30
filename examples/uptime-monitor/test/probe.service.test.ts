import type { Monitor } from '../src/monitors/monitor.js'
import type { Prober } from '../src/monitors/prober.js'

import { Logger } from '@znight/observability'
import { createJobContext } from '@znight/schedule/testing'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { ProbeService } from '../src/monitors/probe.service.js'
import { ProbeEvents } from '../src/monitors/probe-events.js'
import { ProbeResultRepository } from '../src/monitors/probe-result.repository.js'
import { aResult, TARGET } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

const monitor: Monitor = {
  id: 7,
  name: 'API',
  url: TARGET,
  expectedStatus: 200,
  schedule: { every: 30_000 },
  timeoutMs: 5_000,
  createdAt: new Date('2027-01-01T00:00:00Z'),
}

const scheduledAt = new Date('2027-01-04T09:00:30Z')

/**
 * Unit tests of the body of a monitor job. The job context is built by the test: its occurrence,
 * and its signal, aborted at will with the reason the scheduler would give.
 */
describe('ProbeService', () => {
  async function setup() {
    const { instance, mocks } = await TestBed.create(ProbeService, { metadata })
    const results = mocks.get(ProbeResultRepository)
    results.record.mockImplementation(async result => aResult({ ...result, id: 1 }))
    return {
      probes: instance,
      prober: mocks.get<Prober>('Prober'),
      results,
      events: mocks.get(ProbeEvents),
      logger: mocks.get(Logger),
    }
  }

  it('records the occurrence, not the current time, and publishes the result', async () => {
    const { probes, prober, results, events } = await setup()
    prober.probe.mockResolvedValue({ status: 200 })
    const ctx = createJobContext({ job: 'monitor.7', scheduledAt, startedAt: new Date('2027-01-04T09:00:30.004Z') })

    await probes.run(monitor, ctx)

    expect(prober.probe).toHaveBeenCalledWith({ url: TARGET, signal: ctx.signal }) // the run's signal goes to fetch
    expect(results.record).toHaveBeenCalledWith({
      monitorId: 7,
      scheduledAt, // the key of the result: one per occurrence, whichever instance probed it
      checkedAt: new Date('2027-01-04T09:00:30.004Z'),
      up: true,
      status: 200,
      latencyMs: expect.any(Number),
      error: null,
    })
    expect(events.publish).toHaveBeenCalledTimes(1)
  })

  it('records an unexpected status as down', async () => {
    const { probes, prober, results, logger } = await setup()
    prober.probe.mockResolvedValue({ status: 502 })

    await probes.run(monitor, createJobContext({ scheduledAt }))

    expect(results.record).toHaveBeenCalledWith(
      expect.objectContaining({ up: false, status: 502, error: 'Expected status 200, got 502' }),
    )
    expect(logger.warn).toHaveBeenCalledWith('Monitor down', expect.objectContaining({ monitorId: 7, status: 502 }))
  })

  it('records a timeout (maxDuration) as down', async () => {
    const { probes, prober, results } = await setup()
    const ctx = createJobContext({ scheduledAt })
    prober.probe.mockImplementation(({ signal }) => {
      ctx.abort('timeout') // what the scheduler does after maxDuration
      signal.throwIfAborted() // what fetch does
      return Promise.resolve({ status: 200 })
    })

    await probes.run(monitor, ctx)

    expect(results.record).toHaveBeenCalledWith(
      expect.objectContaining({ up: false, status: null, error: 'No answer within 5000 ms' }),
    )
  })

  it.each(['shutdown', 'removed', 'lock-lost'] as const)('records nothing when aborted by %s', async reason => {
    const { probes, prober, results, events } = await setup()
    const ctx = createJobContext({ scheduledAt })
    prober.probe.mockImplementation(({ signal }) => {
      ctx.abort(reason)
      signal.throwIfAborted()
      return Promise.resolve({ status: 200 })
    })

    await probes.run(monitor, ctx)

    expect(results.record).not.toHaveBeenCalled() // the target is not to blame
    expect(events.publish).not.toHaveBeenCalled()
  })

  it('publishes nothing when the occurrence was already recorded', async () => {
    const { probes, prober, results, events } = await setup()
    prober.probe.mockResolvedValue({ status: 200 })
    results.record.mockResolvedValue(undefined)

    await probes.run(monitor, createJobContext({ scheduledAt }))

    expect(events.publish).not.toHaveBeenCalled()
  })
})
