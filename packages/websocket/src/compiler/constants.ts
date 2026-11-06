/**
 * Constants shared by the compiler extension modules. This module stays free of runtime imports: the
 * extension entry is loaded by the compiler, which must never load the WebSocket runtime (spec §2).
 */
import type { ErrorCode } from '@znight/core'

/** Name of the extension, also the key of `metadata.extensions.websocket`. */
export const EXTENSION_NAME = 'websocket'

/** Module the generated code imports its helpers and types from. */
export const RUNTIME_MODULE = '@znight/websocket'

/** Canonical identities of the decorators owned by the extension. */
export const WsDecorator: {
  readonly Gateway: '@znight/websocket#Gateway'
  readonly OnConnect: '@znight/websocket#OnConnect'
  readonly OnMessage: '@znight/websocket#OnMessage'
  readonly OnDisconnect: '@znight/websocket#OnDisconnect'
  readonly Payload: '@znight/websocket#Payload'
  readonly Conn: '@znight/websocket#Conn'
  readonly Ctx: '@znight/websocket#Ctx'
  readonly UseHandshakeGuard: '@znight/websocket#UseHandshakeGuard'
  readonly UseMessageGuard: '@znight/websocket#UseMessageGuard'
} = Object.freeze({
  Gateway: '@znight/websocket#Gateway',
  OnConnect: '@znight/websocket#OnConnect',
  OnMessage: '@znight/websocket#OnMessage',
  OnDisconnect: '@znight/websocket#OnDisconnect',
  Payload: '@znight/websocket#Payload',
  Conn: '@znight/websocket#Conn',
  Ctx: '@znight/websocket#Ctx',
  UseHandshakeGuard: '@znight/websocket#UseHandshakeGuard',
  UseMessageGuard: '@znight/websocket#UseMessageGuard',
})

/** Decorators giving a method a role. */
export const ROLE_DECORATORS: ReadonlySet<string> = new Set([
  WsDecorator.OnConnect,
  WsDecorator.OnMessage,
  WsDecorator.OnDisconnect,
])

/** Decorators applied to methods (roles and message guards). */
export const METHOD_DECORATORS: ReadonlySet<string> = new Set([...ROLE_DECORATORS, WsDecorator.UseMessageGuard])

/** Decorators applied to handler parameters. */
export const PARAMETER_DECORATORS: ReadonlySet<string> = new Set([
  WsDecorator.Payload,
  WsDecorator.Conn,
  WsDecorator.Ctx,
])

/** ZNIGHT005: invalid decorator usage. */
export const INVALID_DECORATOR: ErrorCode = 'ZNIGHT005'
/** ZNIGHT007: invalid or conflicting gateway path. */
export const INVALID_ROUTE: ErrorCode = 'ZNIGHT007'
/** ZNIGHT017: non-primitive `@Payload()` without schema. */
export const UNVALIDATED_INPUT: ErrorCode = 'ZNIGHT017'
/** ZNIGHT023: a gateway without a decision of a required route decorator group (RFC 0001). */
export const MISSING_ROUTE_DECISION: ErrorCode = 'ZNIGHT023'
/** ZNIGHT050: invalid gateway. */
export const INVALID_GATEWAY: ErrorCode = 'ZNIGHT050'

/** Event names of the `events` protocol (the runtime `EVENT_NAME`, checked by the tests). */
export const EVENT_NAME: RegExp = /^[A-Za-z][\w.:/-]{0,127}$/

/** RFC 7230 token: subprotocol names. */
export const SUBPROTOCOL: RegExp = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Deterministic string comparison (never `localeCompare`). */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
}

const SIZE = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/i

/** A positive byte size (`'64kb'`, `65536`), the grammar of `ByteSize`; `undefined` otherwise. */
export function parseSize(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined
  if (typeof value !== 'string') return undefined
  const match = SIZE.exec(value.trim())
  if (match === null) return undefined
  const unit = (match[2] as string).toLowerCase()
  const multiplier = unit === '' ? 1 : UNITS[unit]
  if (multiplier === undefined) return undefined
  const bytes = Math.floor(Number(match[1]) * multiplier)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined
}
