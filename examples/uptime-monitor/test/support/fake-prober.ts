import type { ProbeRequest, Prober } from '../../src/monitors/prober.js'

/** How a target answers. */
export type TargetBehaviour =
  /** Answers this status at once. */
  | { readonly status: number }
  /** Connection refused: `fetch` rejects at once. */
  | 'refused'
  /** Never answers: the probe waits until its signal is aborted (`maxDuration`, removal, shutdown). */
  | 'hang'
  /** Never answers and ignores its signal: a misbehaving client library (the run cannot be stopped). */
  | 'stall'

/**
 * The network of the tests: no socket, no timing. Each URL answers as told (200 by default), and
 * every probe is recorded with its signal, so tests see what the scheduler aborted.
 */
export class FakeProber implements Prober {
  /** Every probe, in order. */
  readonly requests: ProbeRequest[] = []
  readonly #targets = new Map<string, TargetBehaviour>()
  /** One-shot behaviours, consumed by the next probe of their URL. */
  readonly #once = new Map<string, TargetBehaviour>()

  /** Sets how `url` answers from now on. */
  answer(url: string, behaviour: TargetBehaviour): this {
    this.#targets.set(url, behaviour)
    return this
  }

  /** Sets how `url` answers to its next probe only. */
  answerOnce(url: string, behaviour: TargetBehaviour): this {
    this.#once.set(url, behaviour)
    return this
  }

  /** The probes of `url`. */
  requestsTo(url: string): ProbeRequest[] {
    return this.requests.filter(request => request.url === url)
  }

  probe(request: ProbeRequest): Promise<{ readonly status: number }> {
    this.requests.push(request)
    const behaviour = this.#once.get(request.url) ?? this.#targets.get(request.url) ?? { status: 200 }
    this.#once.delete(request.url)
    switch (behaviour) {
      case 'refused':
        return Promise.reject(
          new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${request.url}`) }),
        )
      case 'hang':
        return new Promise((_, reject) => {
          request.signal.throwIfAborted()
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      case 'stall':
        return new Promise(() => {})
      default:
        return Promise.resolve({ status: behaviour.status })
    }
  }
}
