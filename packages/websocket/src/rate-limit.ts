/** The token bucket of `@Gateway({ rateLimit })` (RFC 0003 §8.6), one per connection. */
export class TokenBucket {
  readonly #capacity: number
  readonly #perMs: number
  #tokens: number
  #updatedAt: number

  /** `messages` per `intervalMs`, refilled continuously; full at first. */
  constructor(messages: number, intervalMs: number, now: number = performance.now()) {
    this.#capacity = messages
    this.#perMs = messages / intervalMs
    this.#tokens = messages
    this.#updatedAt = now
  }

  /** Takes one token: `false` when the bucket is empty. */
  take(now: number = performance.now()): boolean {
    const elapsed = now - this.#updatedAt
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#perMs)
      this.#updatedAt = now
    }
    if (this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }
}
