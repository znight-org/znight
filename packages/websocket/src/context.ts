/** The context of one inbound message and the message guards (RFC 0003 §8.4, §5.6). */
import type { Token } from '@znight/core'
import type { WsConnection } from './connection.ts'
import type { WsException } from './exceptions.ts'

/** What handlers (`@Ctx()`) and message guards see of one message. */
export interface WsMessageContext {
  readonly connection: WsConnection
  /** `undefined` on raw gateways. */
  readonly event: string | undefined
  readonly id: string | number | undefined
  /** The decoded `data` (events) or the frame (raw). */
  readonly data: unknown
  readonly binary: boolean
  readonly bytes: number
  /** `performance.now()` when the message was received. */
  readonly receivedAt: number
  /** Aborted on timeout or when the connection closes. */
  readonly signal: AbortSignal
  /** Per message: guards to handler. */
  readonly state: Map<string | symbol, unknown>
  readonly route: {
    readonly path: string
    readonly gateway: Token
    readonly handler: string | undefined
    readonly event: string | undefined
    readonly meta: Readonly<Record<string, unknown>>
  }
}

/** A guard run before each message handler: `false` answers `FORBIDDEN`. */
export interface WsGuard {
  canHandle(ctx: WsMessageContext): boolean | Promise<boolean>
}

/**
 * Maps an error thrown by a message handler or guard to the {@link WsException} answered to the
 * client (plugin option `exceptionMappers`, run in order before the built-in mapping). `undefined`:
 * not handled, the next mapper or the built-in mapping applies.
 */
export interface WsExceptionMapper {
  map(error: unknown, ctx: WsMessageContext): WsException | undefined | Promise<WsException | undefined>
}
