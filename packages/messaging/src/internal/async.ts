/** Internal async helpers (not part of the public API). */

/** Rejection reason of operations interrupted by an `AbortSignal`. */
export class AbortedError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

/** Resolves after `ms` milliseconds, or rejects with {@link AbortedError} as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new AbortedError())
  if (ms <= 0 && signal === undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Counting semaphore. `acquire()` resolves when a permit is available, in FIFO order, or rejects with
 * {@link AbortedError} when `signal` aborts while waiting.
 */
export class Semaphore {
  #available: number
  readonly #waiters: { resolve: () => void; reject: (error: unknown) => void }[] = []

  constructor(permits: number) {
    this.#available = permits
  }

  /** Permits currently available. */
  get available(): number {
    return this.#available
  }

  /** Number of callers waiting for a permit. */
  get waiting(): number {
    return this.#waiters.length
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new AbortedError())
    if (this.#available > 0) {
      this.#available--
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        reject,
      }
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter)
        if (index !== -1) this.#waiters.splice(index, 1)
        reject(new AbortedError())
      }
      this.#waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  release(): void {
    const next = this.#waiters.shift()
    if (next === undefined) this.#available++
    else next.resolve()
  }
}

/** Message of any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return Object.prototype.toString.call(error)
  }
}

/** Truncates `text` to `max` characters (with an ellipsis). */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Whether `value` is a positive integer. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
