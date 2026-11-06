/** What `analyzeClass` stores for `validate` and `generate` (plain, serialisable data). */
import type { ClassRef, Location, ValueRef } from '@znight/compiler'
import type { Token } from '@znight/core'
import type { MetaEntry } from '@znight/http/compiler'

/** A parameter of a handler, as the generated `invoke` passes it. */
export type WsParamData =
  | { readonly kind: 'payload' }
  | { readonly kind: 'validated'; readonly schema: ValueRef }
  | { readonly kind: 'connection' }
  | { readonly kind: 'context' }
  /** An optional parameter without decorator, or a parameter in error (reported). */
  | { readonly kind: 'undefined'; readonly optional: boolean }

/** `@OnConnect` or `@OnDisconnect`. */
export interface LifecycleData {
  readonly method: string
  readonly params: readonly WsParamData[]
  readonly declaredBy: string
  readonly location: Location
}

/** One `@OnMessage` handler (a method decorated several times gives one entry per event). */
export interface HandlerData {
  readonly method: string
  /** `undefined`: the default handler. */
  readonly event: string | undefined
  /** Route decorators of the method. */
  readonly meta: readonly MetaEntry[]
  /** `@UseMessageGuard` of the method. */
  readonly guards: readonly ClassRef[]
  readonly params: readonly WsParamData[]
  readonly declaredBy: string
  readonly location: Location
}

/** Static options of `@Gateway`. */
export interface GatewayOptionsData {
  readonly protocol: 'events' | 'raw'
  readonly protocols?: readonly string[]
  readonly maxPayload?: number
  readonly concurrency?: number
  readonly rateLimit?: { readonly messages: number; readonly intervalMs: number; readonly onLimit: 'reject' | 'close' }
  readonly backpressure?: { readonly limit?: number; readonly onLimit?: 'close' | 'drop' }
}

/** A `@Gateway` class. */
export interface GatewayData {
  readonly kind: 'gateway'
  readonly token: Token
  readonly identity: string
  readonly displayName: string
  /** Normalised path; `undefined` when invalid (reported). */
  readonly path: string | undefined
  readonly options: GatewayOptionsData
  /** Route decorators of the class. */
  readonly meta: readonly MetaEntry[]
  readonly handshakeGuards: readonly ClassRef[]
  readonly messageGuards: readonly ClassRef[]
  readonly onConnect: LifecycleData | undefined
  readonly onDisconnect: LifecycleData | undefined
  readonly handlers: readonly HandlerData[]
  /** Identities of the class and its analysable bases (nearest first). */
  readonly chain: readonly string[]
  readonly location: Location
}

/** A class carrying websocket decorators without `@Gateway` (a base class, or a mistake). */
export interface MemberClassData {
  readonly kind: 'members'
  readonly identity: string
  readonly displayName: string
  readonly abstract: boolean
  readonly decorators: readonly { readonly name: string; readonly location: Location }[]
}

/** Everything the extension stores. */
export type WebSocketData = GatewayData | MemberClassData
