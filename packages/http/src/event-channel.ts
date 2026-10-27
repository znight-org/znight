/**
 * `EventChannel`: a bounded bridge from push-based producers (an event bus, an `EventEmitter`, a
 * database listener) to a pull-based `AsyncIterable` (an SSE source, a GraphQL subscription), with
 * no dependency.
 */

/** Options of {@link EventChannel}. */
export interface EventChannelOptions {
  /** Buffered items before `overflow` applies. Default: 1 000. */
  readonly capacity?: number
  /**
   * What happens when an item is pushed into a full buffer:
   * - `'drop-oldest'` (default): the oldest buffered item is discarded;
   * - `'drop-newest'`: the item is discarded (`push()` returns false);
   * - `'close'`: the item is discarded and the channel closes after the buffered items (an SSE
   *   client then reconnects and resumes with `Last-Event-ID`).
   */
  readonly overflow?: 'drop-oldest' | 'drop-newest' | 'close'
  /** Closes the channel when aborted (pass `ctx.signal`). */
  readonly signal?: AbortSignal
}

const DEFAULT_CAPACITY = 1_000

/** A pending `next()`. */
interface Waiter<T> {
  resolve(result: IteratorResult<T>): void
  reject(error: unknown): void
}

/**
 * A bounded, single-consumer queue that is an `AsyncIterable`: producers `push()`, the consumer
 * iterates. A pending `next()` resolves with `{ done: true }` as soon as the channel closes for any
 * reason, so an SSE handler built on a channel always stops when its client leaves.
 *
 * ```ts
 * const channel = new EventChannel<SseEvent<Order>>({ capacity: 256, overflow: 'close', signal: ctx.signal })
 * const unsubscribe = bus.on('order', order => channel.push({ event: 'order', data: order }))
 * channel.onClose(unsubscribe)
 * return channel // from an @Sse handler
 * ```
 */
export class EventChannel<T> implements AsyncIterable<T> {
  readonly #capacity: number
  readonly #overflow: 'drop-oldest' | 'drop-newest' | 'close'
  readonly #buffer: T[] = []
  readonly #waiters: Waiter<T>[] = []
  readonly #listeners: (() => void)[] = []
  readonly #signal: AbortSignal | undefined
  #closed = false
  #failure: { readonly error: unknown } | undefined
  #iterating = false
  #onAbort: (() => void) | undefined

  constructor(options: EventChannelOptions = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('EventChannel: options must be an object { capacity?, overflow?, signal? }')
    }
    const capacity = options.capacity ?? DEFAULT_CAPACITY
    if (!(Number.isSafeInteger(capacity) && capacity >= 1) && capacity !== Number.POSITIVE_INFINITY) {
      throw new TypeError(`EventChannel: capacity must be a positive integer (received ${String(capacity)})`)
    }
    const overflow = options.overflow ?? 'drop-oldest'
    if (overflow !== 'drop-oldest' && overflow !== 'drop-newest' && overflow !== 'close') {
      throw new TypeError(
        `EventChannel: overflow must be 'drop-oldest', 'drop-newest' or 'close' (received ${String(overflow)})`,
      )
    }
    this.#capacity = capacity
    this.#overflow = overflow
    const signal = options.signal
    this.#signal = signal
    if (signal !== undefined) {
      if (signal.aborted) {
        this.#closed = true
      } else {
        this.#onAbort = (): void => this.close()
        signal.addEventListener('abort', this.#onAbort, { once: true })
      }
    }
  }

  /** Buffered items. */
  get size(): number {
    return this.#buffer.length
  }

  /** Whether the channel no longer accepts items (closed, failed, overflowed, aborted, returned). */
  get closed(): boolean {
    return this.#closed
  }

  /** Buffers an item (or hands it to a waiting consumer). Returns false when it was dropped or the channel is closed. */
  push(item: T): boolean {
    if (this.#closed) return false
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: item })
      return true
    }
    if (this.#buffer.length < this.#capacity) {
      this.#buffer.push(item)
      return true
    }
    switch (this.#overflow) {
      case 'drop-oldest':
        this.#buffer.shift()
        this.#buffer.push(item)
        return true
      case 'drop-newest':
        return false
      default:
        this.close()
        return false
    }
  }

  /** Ends the iteration after the buffered items. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#settle()
  }

  /** Makes the iteration throw `error` after the buffered items (ignored once closed). */
  fail(error: unknown): void {
    if (this.#closed) return
    this.#failure = { error }
    this.#closed = true
    this.#settle()
  }

  /**
   * Calls `listener` once when the channel closes (close, fail, overflow, signal, consumer
   * `return()`); immediately when it is already closed.
   */
  onClose(listener: () => void): void {
    if (typeof listener !== 'function') throw new TypeError('EventChannel.onClose() expects a function')
    if (this.#closed) listener()
    else this.#listeners.push(listener)
  }

  /**
   * The iterator of the single consumer (a second call throws). Its `return()` closes the channel
   * and resolves at once, even while a `next()` waits.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterating) throw new TypeError('EventChannel: a channel has a single consumer (already iterated)')
    this.#iterating = true
    return {
      next: (): Promise<IteratorResult<T>> => this.#next(),
      return: (): Promise<IteratorResult<T>> => {
        this.#buffer.length = 0
        this.close()
        return Promise.resolve({ done: true, value: undefined })
      },
    }
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#buffer.length > 0) return Promise.resolve({ done: false, value: this.#buffer.shift() as T })
    if (this.#closed) {
      const failure = this.#failure
      if (failure !== undefined) {
        this.#failure = undefined
        return Promise.reject(failure.error)
      }
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }

  /** The channel just closed: release waiting consumers, the signal listener and notify `onClose` listeners. */
  #settle(): void {
    if (this.#onAbort !== undefined) {
      this.#signal?.removeEventListener('abort', this.#onAbort)
      this.#onAbort = undefined
    }
    // waiters only exist while the buffer is empty
    for (const waiter of this.#waiters.splice(0)) {
      const failure = this.#failure
      if (failure === undefined) {
        waiter.resolve({ done: true, value: undefined })
      } else {
        this.#failure = undefined
        waiter.reject(failure.error)
      }
    }
    for (const listener of this.#listeners.splice(0)) {
      try {
        listener()
      } catch {
        // a failing listener must not break the producer that closed the channel
      }
    }
  }
}
