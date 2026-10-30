import type { ProbesConfig } from '../config/probes.config.js'

import { Injectable } from '@znight/core'

/** What a probe asks the network. */
export interface ProbeRequest {
  readonly url: string
  /** The run's signal: aborted by `maxDuration` (the monitor's timeout), a removal or the shutdown. */
  readonly signal: AbortSignal
}

/**
 * The network side of a probe: a port, so that tests replace it with a fake (no sockets, no
 * timing) while the job, its schedule, its lock and its result go through the real code.
 */
export interface Prober {
  /** Resolves with the status of the answer; rejects when there is none (or when `signal` aborts). */
  probe(request: ProbeRequest): Promise<{ readonly status: number }>
}

/** {@link Prober} over `fetch`, the same on Node.js and Bun. */
@Injectable()
export class FetchProber implements Prober {
  constructor(private readonly config: ProbesConfig) {}

  async probe({ url, signal }: ProbeRequest): Promise<{ readonly status: number }> {
    // `signal` bounds the whole exchange: connection, headers and body. A redirect is an answer
    // (3xx): following it would probe another service.
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { 'user-agent': this.config.userAgent },
    })
    await response.body?.cancel() // the status is enough: do not download the page
    return { status: response.status }
  }
}
