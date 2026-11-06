import type { TypedToken } from '@znight/core'
import type { WsConnection } from './connection.ts'
import type { WebSocketPlugin } from './plugin.ts'
import type { WsServer } from './server.ts'

/**
 * Tokens of the values `@znight/websocket` supplies to the container. `WsConnection` is a
 * request-scoped external: the request scope of a WebSocket handshake lasts as long as its
 * connection. Inject it in request-scoped providers (`@Gateway({ scope: 'request' })`) or through
 * `Lazy<WsConnection>`.
 */
export const WsTokens: {
  /** The {@link WsServer} of the application (singleton). */
  readonly Server: TypedToken<WsServer>
  /** The {@link WebSocketPlugin} instance (singleton). */
  readonly Plugin: TypedToken<WebSocketPlugin>
  /** The {@link WsConnection} of the current connection (request scope). */
  readonly Connection: TypedToken<WsConnection>
} = Object.freeze({
  Server: '@znight/websocket#WsServer',
  Plugin: '@znight/websocket#WebSocketPlugin',
  Connection: '@znight/websocket#WsConnection',
})
