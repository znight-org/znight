/**
 * A deferred abort signal for graphql-js (RFC 0005 §8.3, "Cancellation").
 *
 * `HttpContext.signal` is created on first read, and creating it costs an `AbortController` plus a
 * close listener on the connection; graphql-js then adds and removes an abort listener per
 * execution. A query whose resolvers are synchronous cannot be cancelled anyway, so the transport
 * passes this stand-in instead: it records the listener graphql-js registers and starts following
 * `ctx.signal` only when the execution turned asynchronous ({@link DeferredAbort.follow}). It follows
 * the signal only while graphql-js listens: a listener registered after `follow()` (an asynchronous
 * `graphql:operation` wrapper delays the execution) wires it up, and graphql-js removing its
 * listener when the execution settles detaches it, so a long-lived signal (the plugin's, outside a
 * request) does not collect one listener per execution.
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
  /** Set by {@link follow}: reads the signal to follow. */
  #read: (() => AbortSignal) | undefined = undefined
  /** The followed signal, while a listener of it is registered. */
  #source: AbortSignal | undefined = undefined
  readonly #onAbort = (): void => {
    this.#abort(this.#source?.reason)
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason
  }

  addEventListener(type: string, listener: Listener): void {
    if (type !== 'abort') return
    if (this.#listener === undefined) this.#listener = listener
    else {
      this.#others ??= []
      this.#others.push(listener)
    }
    if (this.#read !== undefined && this.#source === undefined) this.#wire()
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type !== 'abort') return
    if (this.#listener === listener) this.#listener = undefined
    else {
      const others = this.#others
      const index = others === undefined ? -1 : others.indexOf(listener)
      if (index !== -1) others?.splice(index, 1)
    }
    if (this.#source !== undefined && !this.#listening()) this.#detach()
  }

  /**
   * The execution is asynchronous: from now on, `signal` aborting aborts the execution. Reads the
   * signal only while graphql-js listens: now for a pending execution, else when it registers its
   * listener (an execution an asynchronous wrapper delayed).
   */
  follow(read: () => AbortSignal): void {
    this.#read = read
    if (this.#source === undefined && this.#listening()) this.#wire()
  }

  /** This stand-in, typed as the `AbortSignal` graphql-js expects. */
  asSignal(): AbortSignal {
    return this as unknown as AbortSignal
  }

  #listening(): boolean {
    return this.#listener !== undefined || (this.#others !== undefined && this.#others.length > 0)
  }

  #wire(): void {
    if (this.aborted) return
    const signal = (this.#read as () => AbortSignal)()
    if (signal.aborted) {
      this.#abort(signal.reason)
      return
    }
    this.#source = signal
    signal.addEventListener('abort', this.#onAbort, { once: true })
  }

  #detach(): void {
    this.#source?.removeEventListener('abort', this.#onAbort)
    this.#source = undefined
  }

  #abort(reason: unknown): void {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason
    this.#detach()
    const listener = this.#listener
    const others = this.#others
    this.#listener = undefined
    this.#others = undefined
    listener?.()
    if (others !== undefined) for (const other of others) other()
  }
}
