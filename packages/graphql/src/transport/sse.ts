/**
 * GraphQL over SSE, distinct connections mode (RFC 0005 §5.6, §8.3, §8.11): the results of an
 * operation as `next` events, then a `complete` event. Everything else (headers, heartbeats,
 * backpressure, client abort, graceful close) is RFC 0006's `HttpResponse.sse()`.
 */
import type { SseEvent } from '@znight/http'
import type { GraphQLResultStream } from '../execution.ts'

/** The last event of a stream that ended normally. */
const COMPLETE: SseEvent<string> = Object.freeze({ event: 'complete', data: '' })
const DONE: IteratorResult<SseEvent> = Object.freeze({ done: true, value: undefined })

/**
 * The event source of an operation: one `next` event per result, then `complete` when the
 * operation ended by itself. A stream ended by `ctx.signal` (client gone, shutdown, `maxDuration`)
 * gets no `complete`: GraphQL-over-SSE clients then treat it as a lost connection and retry.
 */
export class ResultEvents implements AsyncIterableIterator<SseEvent> {
  readonly #results: GraphQLResultStream
  readonly #signal: AbortSignal
  #done = false

  constructor(results: GraphQLResultStream, signal: AbortSignal) {
    this.#results = results
    this.#signal = signal
  }

  async next(): Promise<IteratorResult<SseEvent>> {
    if (this.#done) return DONE
    const step = await this.#results.next()
    if (step.done !== true) return { done: false, value: { event: 'next', data: step.value } }
    this.#done = true
    return this.#signal.aborted ? DONE : { done: false, value: COMPLETE }
  }

  async return(): Promise<IteratorResult<SseEvent>> {
    this.#done = true
    await this.#results.return()
    return DONE
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SseEvent> {
    return this
  }
}
