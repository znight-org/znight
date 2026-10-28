import type { HttpContext, SseEvent } from '@znight/http'
import type { ProbeEventData, ProbeEvents } from '../monitors/probe-events.js'
import type { StatusCache, StatusSnapshot } from './status.cache.js'

import { Controller, Ctx, Get, Headers, ServiceUnavailableException, Sse } from '@znight/http'

import { Public } from '../auth/auth.decorators.js'

/**
 * The public status page: no API key (`@Public()` on the controller).
 *
 * - `GET /status`: the snapshot of `StatusCache`, refreshed every minute by its job.
 * - `GET /status/events`: Server-Sent Events, one `probe` event per probe result, live. Open it in a
 *   browser with `new EventSource('/status/events')`, or `curl -N`.
 */
@Controller('/status')
@Public()
export class StatusController {
  constructor(
    private readonly cache: StatusCache,
    private readonly events: ProbeEvents,
  ) {}

  /** GET /status: 503 until the first refresh (a few milliseconds after the start). */
  @Get()
  status(): StatusSnapshot {
    const snapshot = this.cache.snapshot
    if (snapshot === undefined) throw new ServiceUnavailableException('The status is being computed, retry shortly')
    return snapshot
  }

  /**
   * GET /status/events: an event stream of the probe results.
   *
   * An `async` method (not an `async *` generator): it subscribes and reads the missed events
   * **before** the stream opens. `EventSource` reconnects by itself (after `retry` ms) with the id of
   * the last event it received in `Last-Event-ID`: the results recorded meanwhile are replayed from
   * the database, then the live ones follow. A heartbeat comment every 8 s (the default) keeps
   * proxies from closing a quiet stream, and `maxDuration` closes it gracefully every 30 minutes, so
   * long-lived clients spread over the instances of a rolling deployment.
   */
  @Sse('/events', { retry: 5_000, maxDuration: 30 * 60_000 })
  stream(
    @Headers('last-event-id') lastEventId: string | undefined,
    @Ctx() ctx: HttpContext,
  ): Promise<AsyncIterable<SseEvent<ProbeEventData>>> {
    return this.events.subscribe({ lastEventId, signal: ctx.signal })
  }
}
