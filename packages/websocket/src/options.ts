/** Options of `@Gateway` and of `WebSocketPlugin` (RFC 0003 §5.2, §5.9). */
import type { ByteSize, HttpContext } from '@znight/http'
import type { WsExceptionMapper, WsGuard } from './context.ts'
import type { WsCodec } from './envelope.ts'
import type { WebSocketTransport } from './transport.ts'

import { ErrorCode, ZnightError } from '@znight/core'
import { parseByteSize } from '@znight/http'

import { jsonCodec } from './envelope.ts'

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

// -------------------------------------------------------------------------------------------------
// WebSocketPlugin options (RFC 0003 §5.9)
// -------------------------------------------------------------------------------------------------

/** `'same-origin'`, `'*'`, exact origins and anchored `RegExp`s, or a function (RFC 0003 §5.6). */
export type WsOrigins =
  | 'same-origin'
  | '*'
  | string
  | RegExp
  | readonly (string | RegExp)[]
  | ((origin: string, ctx: HttpContext) => boolean | Promise<boolean>)

/** A message guard or an exception mapper: a provider class or an instance. */
export type WsProviderRef<T> = (abstract new (...args: never[]) => T) | T

/** Options of `WebSocketPlugin.configure()`. */
export interface WebSocketPluginOptions {
  /** `'auto'` (default): Bun's native transport with `honoAdapter()` on Bun, `ws` otherwise. */
  readonly transport?: 'auto' | WebSocketTransport
  /** Allowed `Origin`s of handshakes. Default: `'same-origin'` (and requests without `Origin`). */
  readonly origins?: WsOrigins
  /** Largest inbound message (`'1mb'` or bytes). Default: `'1mb'`. Gateways may lower it. */
  readonly maxPayload?: ByteSize
  /** Open connections per process; above, handshakes get `503`. Default: `Infinity`. */
  readonly maxConnections?: number
  /** Inbound queue per connection before reading pauses. Default: `32`. */
  readonly maxPendingMessages?: number
  /** Outbound buffer per connection. Default: `{ limit: '1mb', onLimit: 'close' }`. */
  readonly backpressure?: BackpressureOptions
  /** Ping interval; `false` disables heartbeats. Default: `{ intervalMs: 30_000 }`. */
  readonly heartbeat?: { readonly intervalMs: number } | false
  /** Handshakes whose guards have not answered by then get `408`. Default: `10_000`. */
  readonly handshakeTimeoutMs?: number
  /** Per message and per `@OnConnect`: `TIMEOUT`. `Infinity` disables. Default: `30_000`. */
  readonly handlerTimeoutMs?: number
  /** Wait for the client's close frame before terminating. Default: `2_000`. */
  readonly closeTimeoutMs?: number
  /** The codec of `events` gateways. Default: `jsonCodec` (JSON text frames). */
  readonly codec?: WsCodec
  /** Global message guards, run before the gateway's and the handler's. */
  readonly messageGuards?: readonly WsProviderRef<WsGuard>[]
  /** Exception mappers of message handlers and guards, in order. */
  readonly exceptionMappers?: readonly WsProviderRef<WsExceptionMapper>[]
  /** Send the message of unexpected errors (`INTERNAL`). Default: `false`. */
  readonly exposeErrors?: boolean
  /** Graceful shutdown. Default: `{ code: 1001, reason: 'Server shutting down', timeoutMs: 3_000 }`. */
  readonly shutdown?: { readonly code?: number; readonly reason?: string; readonly timeoutMs?: number }
}

/** Validated plugin options (internal). */
export interface ResolvedWebSocketOptions {
  readonly transport: 'auto' | WebSocketTransport
  readonly origins: OriginPolicy
  readonly maxPayload: number
  readonly maxConnections: number
  readonly maxPendingMessages: number
  readonly backpressure: { readonly limit: number; readonly onLimit: 'close' | 'drop' }
  readonly heartbeatMs: number
  readonly handshakeTimeoutMs: number
  readonly handlerTimeoutMs: number
  readonly closeTimeoutMs: number
  readonly codec: WsCodec
  readonly messageGuards: readonly unknown[]
  readonly exceptionMappers: readonly unknown[]
  readonly exposeErrors: boolean
  readonly shutdown: { readonly code: number; readonly reason: string; readonly timeoutMs: number }
}

/** How origins are checked (internal). */
export interface OriginPolicy {
  /** `'same-origin'`: the request's own origin only. */
  readonly sameOrigin: boolean
  allows(origin: string, ctx: HttpContext): boolean | Promise<boolean>
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'transport',
  'origins',
  'maxPayload',
  'maxConnections',
  'maxPendingMessages',
  'backpressure',
  'heartbeat',
  'handshakeTimeoutMs',
  'handlerTimeoutMs',
  'closeTimeoutMs',
  'codec',
  'messageGuards',
  'exceptionMappers',
  'exposeErrors',
  'shutdown',
])

/** `ZNIGHT050: WebSocketPlugin: option "<name>" must be <expected> (received <value>)`. */
export function invalidOption(name: string, expected: string, value: unknown, hints?: readonly string[]): ZnightError {
  return new ZnightError(
    ErrorCode.InvalidGateway,
    `WebSocketPlugin: option "${name}" must be ${expected} (received ${describe(value)})`,
    hints === undefined ? {} : { hints },
  )
}

function describe(value: unknown): string {
  if (typeof value === 'function') return 'a function'
  if (value instanceof RegExp) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return typeof value
  }
}

function positiveInteger(name: string, value: unknown, fallback: number, infinite = false): number {
  if (value === undefined) return fallback
  if (infinite && value === Number.POSITIVE_INFINITY) return value
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidOption(name, `a positive integer${infinite ? ' or Infinity' : ''}`, value)
  }
  return value
}

function byteSize(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  const bytes = parseByteSize(value)
  if (bytes === undefined || bytes === 0 || bytes === Number.POSITIVE_INFINITY) {
    throw invalidOption(name, "a positive byte size ('64kb', 65536)", value)
  }
  return bytes
}

/** Validates the options of `WebSocketPlugin.configure()` (ZNIGHT050). */
export function resolveWebSocketOptions(options: unknown): ResolvedWebSocketOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidOption('options', 'an object', options)
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new ZnightError(ErrorCode.InvalidGateway, `WebSocketPlugin: unknown option "${key}"`, {
        hints: [`Known options: ${[...OPTION_KEYS].join(', ')}`],
      })
    }
  }
  const o = options as WebSocketPluginOptions
  const transport = o.transport ?? 'auto'
  if (
    transport !== 'auto' &&
    (transport === null || typeof transport !== 'object' || typeof transport.accept !== 'function')
  ) {
    throw invalidOption('transport', "'auto', wsTransport() or bunTransport()", transport)
  }
  const backpressure = o.backpressure ?? {}
  if (backpressure === null || typeof backpressure !== 'object') {
    throw invalidOption('backpressure', "{ limit?, onLimit?: 'close' | 'drop' }", backpressure)
  }
  const onLimit = backpressure.onLimit ?? 'close'
  if (onLimit !== 'close' && onLimit !== 'drop')
    throw invalidOption('backpressure.onLimit', "'close' or 'drop'", onLimit)
  const heartbeat = o.heartbeat ?? { intervalMs: 30_000 }
  let heartbeatMs = 0
  if (heartbeat !== false) {
    if (heartbeat === null || typeof heartbeat !== 'object') {
      throw invalidOption('heartbeat', '{ intervalMs } or false', heartbeat)
    }
    heartbeatMs = positiveInteger('heartbeat.intervalMs', heartbeat.intervalMs, 30_000)
  }
  const shutdown = o.shutdown ?? {}
  if (shutdown === null || typeof shutdown !== 'object') {
    throw invalidOption('shutdown', '{ code?, reason?, timeoutMs? }', shutdown)
  }
  const code = shutdown.code ?? 1001
  if (!isCloseCode(code)) throw invalidOption('shutdown.code', 'a close code (1000, 1001, 1012, 3000-4999)', code)
  const reason = shutdown.reason ?? 'Server shutting down'
  if (typeof reason !== 'string' || Buffer.byteLength(reason) > 123) {
    throw invalidOption('shutdown.reason', 'a string of at most 123 bytes', reason)
  }
  const codec = o.codec ?? jsonCodec
  if (
    codec === null ||
    typeof codec !== 'object' ||
    typeof codec.decode !== 'function' ||
    typeof codec.encode !== 'function'
  ) {
    throw invalidOption('codec', '{ decode(frame, binary), encode(message) }', codec)
  }
  if (o.exposeErrors !== undefined && typeof o.exposeErrors !== 'boolean') {
    throw invalidOption('exposeErrors', 'a boolean', o.exposeErrors)
  }
  return Object.freeze({
    transport,
    origins: resolveOrigins(o.origins ?? 'same-origin'),
    maxPayload: byteSize('maxPayload', o.maxPayload, 1024 * 1024),
    maxConnections: positiveInteger('maxConnections', o.maxConnections, Number.POSITIVE_INFINITY, true),
    maxPendingMessages: positiveInteger('maxPendingMessages', o.maxPendingMessages, 32),
    backpressure: Object.freeze({ limit: byteSize('backpressure.limit', backpressure.limit, 1024 * 1024), onLimit }),
    heartbeatMs,
    handshakeTimeoutMs: positiveInteger('handshakeTimeoutMs', o.handshakeTimeoutMs, 10_000, true),
    handlerTimeoutMs: positiveInteger('handlerTimeoutMs', o.handlerTimeoutMs, 30_000, true),
    closeTimeoutMs: positiveInteger('closeTimeoutMs', o.closeTimeoutMs, 2_000),
    codec,
    messageGuards: refs('messageGuards', o.messageGuards, 'canHandle'),
    exceptionMappers: refs('exceptionMappers', o.exceptionMappers, 'map'),
    exposeErrors: o.exposeErrors ?? false,
    shutdown: Object.freeze({
      code,
      reason,
      timeoutMs: positiveInteger('shutdown.timeoutMs', shutdown.timeoutMs, 3_000),
    }),
  })
}

/** Whether a close code may be sent by a server (RFC 6455 §7.4). */
export function isCloseCode(code: unknown): code is number {
  if (typeof code !== 'number' || !Number.isInteger(code)) return false
  if (code >= 3000 && code <= 4999) return true
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006
}

function refs(name: string, value: unknown, method: string): readonly unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidOption(name, `an array of classes or instances with ${method}()`, value)
  for (const ref of value as unknown[]) {
    const ok =
      typeof ref === 'function'
        ? typeof (ref.prototype as Record<string, unknown> | undefined)?.[method] === 'function'
        : ref !== null && typeof ref === 'object' && typeof (ref as Record<string, unknown>)[method] === 'function'
    if (!ok) throw invalidOption(name, `an array of classes or instances with ${method}()`, ref)
  }
  return Object.freeze([...(value as unknown[])])
}

/** Validates the `origins` option (RFC 0003 §5.6), with the rules of the `cors.origin` option of `HttpPlugin`. */
export function resolveOrigins(value: unknown): OriginPolicy {
  if (value === 'same-origin') {
    return { sameOrigin: true, allows: (origin, ctx) => origin === ownOrigin(ctx) }
  }
  if (typeof value === 'function') {
    return { sameOrigin: false, allows: value as OriginPolicy['allows'] }
  }
  const items: readonly unknown[] = Array.isArray(value) ? value : [value]
  const exact = new Set<string>()
  const patterns: RegExp[] = []
  for (const item of items) {
    if (item === '*') return { sameOrigin: false, allows: () => true }
    if (typeof item === 'string') exact.add(checkOrigin(item))
    else if (item instanceof RegExp) patterns.push(checkPattern(item))
    else throw invalidOption('origins', ORIGINS, value)
  }
  return {
    sameOrigin: false,
    allows: origin => exact.has(origin) || patterns.some(pattern => pattern.test(origin)),
  }
}

const ORIGINS = "'same-origin', '*', an origin, an anchored RegExp, a list of them or a function"

/** The origin of the request itself (`trustProxy` applies to `ctx.protocol`). */
function ownOrigin(ctx: HttpContext): string {
  return `${ctx.protocol}://${ctx.header('host') ?? ''}`
}

function checkOrigin(value: string): string {
  if (value === 'null') {
    throw invalidOption('origins', 'a real origin', value, [
      'The "null" origin is shared by sandboxed iframes, local files and redirects: never trust it',
    ])
  }
  let url: URL | undefined
  try {
    url = new URL(value)
  } catch {
    url = undefined
  }
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw invalidOption('origins', 'an http(s) origin such as "https://app.example.com"', value)
  }
  if (url.origin !== value) {
    throw invalidOption('origins', `an origin without path, trailing slash or default port ("${url.origin}")`, value)
  }
  return value
}

function checkPattern(pattern: RegExp): RegExp {
  const source = pattern.source
  const trailingBackslashes = /\\*\$$/.exec(source)?.[0].length ?? 0
  const anchoredEnd = source.endsWith('$') && (trailingBackslashes - 1) % 2 === 0
  if (!source.startsWith('^') || !anchoredEnd || /(^|[^\\])\|/.test(source.replace(/\([^)]*\)|\[[^\]]*\]/g, ''))) {
    throw invalidOption('origins', 'a RegExp anchored with ^ and $ (around every alternative)', pattern, [
      'Without anchors, /example\\.com/ also allows https://example.com.evil.net',
    ])
  }
  if (pattern.global || pattern.sticky) {
    throw invalidOption('origins', 'a RegExp without the g or y flag (test() would be stateful)', pattern)
  }
  return pattern
}
