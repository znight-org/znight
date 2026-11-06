/** Options of `@Gateway` (RFC 0003 §5.2), all static: the compiler reads them. */
export interface GatewayOptions {
  /** HTTP path grammar (`/chat`, `/docs/:docId`, `/feeds/*`). Default: `'/'`. */
  readonly path?: string
  /** `'request'`: one gateway instance per connection. Default: `'singleton'`. */
  readonly scope?: 'singleton' | 'request'
  /** `'events'` (envelope, routing by event) or `'raw'` (one default handler). Default: `'events'`. */
  readonly protocol?: 'events' | 'raw'
  /** Accepted subprotocols, in preference order: a client offering none of them is refused (400). */
  readonly protocols?: readonly string[]
  /** Largest inbound message (`'64kb'` or bytes). Default: the plugin `maxPayload`. */
  readonly maxPayload?: string | number
  /** Messages of one connection handled in parallel. Default: `1` (keeps the order). */
  readonly concurrency?: number
  /** A token bucket per connection. */
  readonly rateLimit?: RateLimitOptions
  /** Outbound buffer limit and what to do above it. Default: the plugin `backpressure`. */
  readonly backpressure?: BackpressureOptions
}

/** `@Gateway({ rateLimit })`. */
export interface RateLimitOptions {
  readonly messages: number
  readonly intervalMs: number
  /** `'reject'` answers `RATE_LIMITED` (default), `'close'` closes with `4429`. */
  readonly onLimit?: 'reject' | 'close'
}

/** `@Gateway({ backpressure })` and the plugin option. */
export interface BackpressureOptions {
  /** Buffered outbound bytes above which `onLimit` applies (`'1mb'` or bytes). */
  readonly limit?: string | number
  /** `'close'` closes with `1013` (default), `'drop'` drops the message. */
  readonly onLimit?: 'close' | 'drop'
}
