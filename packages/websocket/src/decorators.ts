/**
 * Marker decorators of `@znight/websocket` (RFC 0003 §5.2). Like every Znight decorator they do
 * nothing at runtime: the compiler extension reads them from the source code, validates them and
 * generates `metadata.extensions.websocket`. Every argument is _static_ (literals, `const`
 * references, simple expressions), except the schemas and guards, which are values.
 */
import type { GatewayOptions } from './options.ts'

/** A class decorator marker. */
export type GatewayClassMarker = (target: abstract new (...args: never[]) => unknown) => void

/** A method decorator marker. */
export type GatewayMethodMarker = (
  target: object,
  propertyKey: string | symbol,
  descriptor?: PropertyDescriptor,
) => void

/** A parameter decorator marker. */
export type GatewayParameterMarker = (target: object, propertyKey: string | symbol | undefined, index: number) => void

/** A class or method decorator marker. */
export type GatewayClassOrMethodMarker = (target: object, propertyKey?: string | symbol, descriptor?: unknown) => void

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

/**
 * A provider whose methods handle the WebSocket connections of `path` (default `/`), joined to the
 * `HttpPlugin` prefix.
 *
 * ```ts
 * @Gateway({ path: '/chat', protocols: ['chat.v1'] })
 * export class ChatGateway {}
 * ```
 */
export function Gateway(_pathOrOptions?: string | GatewayOptions): GatewayClassMarker {
  return marker
}

/** Runs once the handshake succeeded, before any message. Throwing closes the connection. */
export function OnConnect(): GatewayMethodMarker {
  return marker
}

/**
 * Handles an event (`events` protocol). Without `event`: the default handler (unknown events, every
 * message of a `raw` gateway). Repeatable.
 */
export function OnMessage(_event?: string): GatewayMethodMarker {
  return marker
}

/** Runs once per connection whose `@OnConnect` completed, before rooms are left and the scope closes. */
export function OnDisconnect(): GatewayMethodMarker {
  return marker
}

/** The message `data` (`events`) or the raw frame (`raw`), validated by `schema` (a Standard Schema). */
export function Payload(_schema?: unknown): GatewayParameterMarker {
  return marker
}

/** The `WsConnection` of the message or of the lifecycle method. */
export function Conn(): GatewayParameterMarker {
  return marker
}

/** The `WsMessageContext` (`@OnMessage` handlers only). */
export function Ctx(): GatewayParameterMarker {
  return marker
}

/** Extra HTTP guards (`CanActivate`) of the handshake, after the `HttpPlugin` global guards. */
export function UseHandshakeGuard(..._guards: readonly unknown[]): GatewayClassMarker {
  return marker
}

/** Message guards (`WsGuard`) run before each handler: global, then class, then method. */
export function UseMessageGuard(..._guards: readonly unknown[]): GatewayClassOrMethodMarker {
  return marker
}
