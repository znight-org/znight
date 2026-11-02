/**
 * A deferred abort signal for graphql-js (RFC 0005 §8.3, "Cancellation").
 *
 * `HttpContext.signal` is created on first read, and creating it costs an `AbortController` plus a
 * close listener on the connection; graphql-js then adds and removes an abort listener per
 * execution. A query whose resolvers are synchronous cannot be cancelled anyway, so the transport
 * passes this stand-in instead: it records the listener graphql-js registers and starts following
 * `ctx.signal` only when the execution turned asynchronous ({@link DeferredAbort.follow}).
 *
 * It implements the part of `AbortSignal` graphql-js 17 reads (`aborted`, `reason`,
 * `throwIfAborted()`, `addEventListener('abort')`, `removeEventListener('abort')`); the transport
 * tests check that a client leaving during an asynchronous query aborts it.
 */

type Listener = () => void

/** The stand-in passed as graphql-js `abortSignal` by the HTTP transport (one per request). */
export class DeferredAbort {
  aborted = false
  reason: unknown = undefined
  /** graphql-js registers one listener per execution; more are kept in {@link #others}. */
  #listener: Listener | undefined = undefined
  #others: Listener[] | undefined = undefined

  throwIfAborted(): void {
    if (this.aborted) throw this.reason
  }

  addEventListener(type: string, listener: Listener): void {
    if (type !== 'abort') return
    if (this.#listener === undefined) {
      this.#listener = listener
      return
    }
    this.#others ??= []
    this.#others.push(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type !== 'abort') return
    if (this.#listener === listener) {
      this.#listener = undefined
      return
    }
    const others = this.#others
    const index = others === undefined ? -1 : others.indexOf(listener)
    if (index !== -1) others?.splice(index, 1)
  }

  /**
   * The execution is asynchronous: from now on, `signal` aborting aborts the execution. Reads the
   * signal only when graphql-js still listens (a pending execution).
   */
  follow(read: () => AbortSignal): void {
    if (this.#listener === undefined && (this.#others === undefined || this.#others.length === 0)) return
    const signal = read()
    if (signal.aborted) {
      this.#abort(signal.reason)
      return
    }
    signal.addEventListener('abort', () => this.#abort(signal.reason), { once: true })
  }

  /** This stand-in, typed as the `AbortSignal` graphql-js expects. */
  asSignal(): AbortSignal {
    return this as unknown as AbortSignal
  }

  #abort(reason: unknown): void {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason
    const listener = this.#listener
    const others = this.#others
    this.#listener = undefined
    this.#others = undefined
    listener?.()
    if (others !== undefined) for (const other of others) other()
  }
}
