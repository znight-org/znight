import type { Logger } from '@znight/observability'
import type { JobContext } from '@znight/schedule'
import type { Monitor } from './monitor.js'
import type { ProbeEvents } from './probe-events.js'
import type { ProbeResultRepository } from './probe-result.repository.js'
import type { Prober } from './prober.js'

import { Injectable } from '@znight/core'
import { JobAbortedError } from '@znight/schedule'

/**
 * One probe of a monitor: the body of its job (`monitor.<id>`, registered by `MonitorScheduler`).
 *
 * - **`ctx.signal` goes to `fetch`.** The job's `maxDuration` is the monitor's timeout: the scheduler
 *   aborts the signal when it is exceeded, `fetch` rejects, and the probe is recorded as down. The
 *   same signal is aborted on shutdown, when the monitor is deleted (`remove(name, { abort: true })`)
 *   or when the lock lease is lost: the probe is then interrupted, not failed, and records nothing.
 * - **`ctx.scheduledAt` is the occurrence**, not the current time: the result is keyed by it (one
 *   result per occurrence, whatever the instance that ran it) and `ctx.startedAt` is the check time.
 *   Both come from the scheduler clock, so tests with a virtual clock are deterministic.
 */
@Injectable()
export class ProbeService {
  constructor(
    private readonly prober: Prober,
    private readonly results: ProbeResultRepository,
    private readonly events: ProbeEvents,
    private readonly logger: Logger,
  ) {}

  async run(monitor: Monitor, ctx: JobContext): Promise<void> {
    const started = performance.now()
    let status: number | null = null
    let error: string | null = null
    try {
      ;({ status } = await this.prober.probe({ url: monitor.url, signal: ctx.signal }))
    } catch (cause) {
      const aborted = abortReason(ctx.signal)
      if (aborted !== undefined && aborted !== 'timeout') {
        // shutdown, deleted monitor, lost lease: the target is not to blame, nothing is recorded
        this.logger.debug('Probe interrupted', { monitorId: monitor.id, reason: aborted })
        return
      }
      error = aborted === 'timeout' ? `No answer within ${monitor.timeoutMs} ms` : describeError(cause)
    }
    const up = status === monitor.expectedStatus
    if (status !== null && !up) error = `Expected status ${monitor.expectedStatus}, got ${status}`

    const result = await this.results.record({
      monitorId: monitor.id,
      scheduledAt: ctx.scheduledAt,
      checkedAt: ctx.startedAt,
      up,
      status,
      latencyMs: Math.round(performance.now() - started),
      error,
    })
    // already recorded for this occurrence, or the monitor was deleted meanwhile
    if (result === undefined) return
    this.events.publish(result)
    if (!up) this.logger.warn('Monitor down', { monitorId: monitor.id, url: monitor.url, status, error })
  }
}

/** Why the run's signal was aborted (`JobAbortedError.reason`), `undefined` while it is not. */
function abortReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) return undefined
  return signal.reason instanceof JobAbortedError ? signal.reason.reason : 'aborted'
}

/** `fetch` failures carry the useful part in their cause (`ECONNREFUSED`...). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
  return `${error.message}${cause}`
}
