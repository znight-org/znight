/** `metadata.extensions.websocket` (RFC 0003 §7.1): what the compiler generates for the gateways. */
import type { Token } from '@znight/core'
import type { WsConnection } from './connection.ts'
import type { WsMessageContext } from './context.ts'

/** The gateways of the application, sorted by token. */
export interface WebSocketMetadata {
  readonly gateways: readonly GatewayDefinition[]
  /**
   * Route decorator groups the runtime needs (required, holding several keys, or named differently
   * from their key), as `metadata.extensions.http.groups`. Absent when no group needs it.
   */
  readonly groups?: Readonly<Record<string, { readonly keys: readonly string[]; readonly required: boolean }>>
}

/** One `@Gateway` class. Optional fields are omitted when absent. */
export interface GatewayDefinition {
  readonly token: Token
  /** The normalized `@Gateway` path, without the `HttpPlugin` prefix. */
  readonly path: string
  readonly protocol: 'events' | 'raw'
  readonly protocols?: readonly string[]
  /** Bytes. */
  readonly maxPayload?: number
  readonly concurrency?: number
  readonly rateLimit?: { readonly messages: number; readonly intervalMs: number; readonly onLimit: 'reject' | 'close' }
  /** `limit` in bytes. */
  readonly backpressure?: { readonly limit?: number; readonly onLimit?: 'close' | 'drop' }
  /** Route decorators of the class: handshake and messages. */
  readonly meta: Readonly<Record<string, unknown>>
  /** `@UseHandshakeGuard`, in order. */
  readonly handshakeGuards: readonly Token[]
  /** `@UseMessageGuard` on the class, in order. */
  readonly messageGuards: readonly Token[]
  readonly onConnect?: WsLifecycleDefinition
  readonly onDisconnect?: WsLifecycleDefinition
  /** Declaration order, bases first. */
  readonly handlers: readonly WsHandlerDefinition[]
}

/** `@OnConnect` or `@OnDisconnect`. */
export interface WsLifecycleDefinition {
  readonly method: string
  // biome-ignore lint/suspicious/noExplicitAny: generated invokers receive the gateway instance of their own class
  readonly invoke: (gateway: any, connection: WsConnection) => unknown
}

/** A parameter of a handler (informational). */
export interface WsParamDefinition {
  readonly index: number
  readonly source: 'payload' | 'connection' | 'context'
  readonly schema?: boolean
  readonly optional?: boolean
}

/** One `@OnMessage` handler. */
export interface WsHandlerDefinition {
  readonly method: string
  /** Absent: the default handler. */
  readonly event?: string
  /** Route decorators of the method, merged over the gateway's at boot (nearest wins). */
  readonly meta: Readonly<Record<string, unknown>>
  /** `@UseMessageGuard` on the method. */
  readonly guards: readonly Token[]
  readonly params: readonly WsParamDefinition[]
  // biome-ignore lint/suspicious/noExplicitAny: generated invokers receive the gateway instance of their own class
  readonly invoke: (gateway: any, ctx: WsMessageContext) => unknown
}

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly websocket?: WebSocketMetadata
  }
}
