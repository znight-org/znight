import type { SseEvent } from '@znight/http'
import type { ProbeResult } from './monitor.js'
import type { ProbeResultRepository } from './probe-result.repository.js'

import { Injectable } from '@znight/core'
import { EventChannel } from '@znight/http'

/** The data of a `probe` event of `GET /status/events`. */
export interface ProbeEventData {
  readonly monitorId: number
  readonly up: boolean
  readonly status: number | null
  readonly latencyMs: number
  readonly error: string | null
  readonly checkedAt: string
  readonly scheduledAt: string
}

/** Events replayed to a client reconnecting with `Last-Event-ID`, at most. */
const REPLAY_LIMIT = 100

/** One event per probe result; its id (the result id) lets `EventSource` resume after a reconnection. */
function toEvent(result: ProbeResult): SseEvent<ProbeEventData> {
  return {
    event: 'probe',
    id: result.id,
    data: {
      monitorId: result.monitorId,
      up: result.up,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
      checkedAt: result.checkedAt.toISOString(),
      scheduledAt: result.scheduledAt.toISOString(),
    },
  }
}

/**
 * Fan-out of the probe results to the clients of `GET /status/events` (Server-Sent Events).
 *
 * Each client gets a bounded `EventChannel`: probes run in jobs and *push* their results, the
 * channel buffers them until the client pulls, and a client that falls too far behind is
 * disconnected (`overflow: 'close'`). `EventSource` then reconnects with `Last-Event-ID` and catches
 * up from the database, so a slow client never makes the server buffer without bound.
 *
 * In-process: a client sees the probes run by **this** instance. With several instances and a lock
 * store, each probe runs on one of them: fan out through the database (`LISTEN` / `NOTIFY`) or a
 * broker to show every probe on every instance.
 */
@Injectable()
export class ProbeEvents {
  readonly #channels = new Set<EventChannel<SseEvent<ProbeEventData>>>()

  constructor(private readonly results: ProbeResultRepository) {}

  /** Clients connected to this instance. */
  get subscribers(): number {
    return this.#channels.size
  }

  /** Sends a result to every connected client (called by the probe jobs). */
  publish(result: ProbeResult): void {
    const event = toEvent(result)
    for (const channel of this.#channels) channel.push(event)
  }

  /**
   * The events of one client: the results it missed (after `lastEventId`), then the live ones.
   * `signal` is the request's (`ctx.signal`): it closes the channel when the client leaves.
   */
  async subscribe(options: {
    readonly lastEventId?: string | undefined
    readonly signal: AbortSignal
  }): Promise<AsyncIterable<SseEvent<ProbeEventData>>> {
    const channel = new EventChannel<SseEvent<ProbeEventData>>({
      capacity: 256,
      overflow: 'close',
      signal: options.signal,
    })
    // subscribe before reading the database: a result recorded meanwhile is in the channel, and the
    // live events already replayed are skipped below (result ids increase)
    this.#channels.add(channel)
    channel.onClose(() => this.#channels.delete(channel))
    // Last-Event-ID is client input: only a positive integer is a position
    const after = Number(options.lastEventId)
    try {
      const missed = Number.isSafeInteger(after) && after > 0 ? await this.results.after(after, REPLAY_LIMIT) : []
      return replayThenLive(missed.map(toEvent), channel)
    } catch (error) {
      channel.close() // the stream never opens (500): unsubscribe now
      throw error
    }
  }
}

async function* replayThenLive<T>(
  missed: readonly SseEvent<T>[],
  live: AsyncIterable<SseEvent<T>>,
): AsyncGenerator<SseEvent<T>> {
  let last = 0
  for (const event of missed) {
    yield event
    last = Number(event.id)
  }
  for await (const event of live) if (Number(event.id) > last) yield event
}
