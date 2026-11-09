/** The transport contract (RFC 0003 §8.3): what completes a handshake and carries the frames. */
import type { BunUpgrade, HeaderValue, MemoryUpgrade, NodeUpgrade } from '@znight/http'

/** Server-wide settings given once at bootstrap. */
export interface TransportSettings {
  /** The largest inbound message any gateway accepts, in bytes. */
  readonly maxPayload: number
  /** The largest outbound buffer any gateway tolerates, in bytes. */
  readonly backpressureLimit: number
  /** Heartbeat interval in ms, `0` when disabled. */
  readonly heartbeatMs: number
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: the characters Node.js refuses in a header value
const INVALID_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/

/**
 * The headers of a `101` response a transport may write: names that are RFC 9110 tokens and values
 * without control characters (CR, LF, NUL...), the rule `res.setHeader()` applies on HTTP routes.
 * Other headers, or values of a list, are dropped: written raw, they would inject headers.
 */
export function safeHeaders(headers: Readonly<Record<string, HeaderValue>>): Record<string, HeaderValue> {
  const result: Record<string, HeaderValue> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) continue
    if (typeof value === 'string') {
      if (!INVALID_HEADER_VALUE.test(value)) result[name] = value
      continue
    }
    const items = value.filter(item => !INVALID_HEADER_VALUE.test(item))
    if (items.length > 0) result[name] = items
  }
  return result
}

/** What {@link WebSocketTransport.accept} receives besides the native upgrade. */
export interface AcceptInit {
  /** The selected subprotocol, `''` when none. */
  readonly protocol: string
  /** Extra headers of the `101` response (a transport writes only {@link safeHeaders}). */
  readonly headers: Readonly<Record<string, HeaderValue>>
  /** The largest inbound message of the gateway, in bytes. */
  readonly maxPayload: number
}

/** The socket events of one connection, given to the transport by the plugin. */
export interface SocketEvents {
  message(frame: string | Uint8Array, binary: boolean): void
  pong(): void
  /**
   * The outbound buffer may have shrunk (after a write, or Bun's `drain`): the connection compares it
   * with its own threshold, and polls the buffer while `conn.drained()` waits.
   */
  drain(): void
  close(code: number, reason: string): void
}

/** The result of {@link TransportSocket.send}. */
export type SendStatus = 'sent' | 'queued' | 'dropped'

/** One accepted connection, the only object holding native handles. */
export interface TransportSocket {
  send(frame: string | Uint8Array, binary: boolean): SendStatus
  readonly bufferedAmount: number
  ping(): void
  /** Stops reading; `false` when the transport cannot pause. */
  pause(): boolean
  resume(): void
  close(code: number, reason: string): void
  terminate(): void
  /** Negotiated extensions (`permessage-deflate`...), `''` when none. */
  readonly extensions: string
}

/** A transport: `ws` on `node:http` servers, Bun's built-in WebSocket on `Bun.serve()`, or memory. */
export interface WebSocketTransport {
  readonly name: string
  /** Which native upgrade it completes. */
  readonly accepts: 'node' | 'bun' | 'memory'
  configure(settings: TransportSettings): void
  accept(
    native: NodeUpgrade | BunUpgrade | MemoryUpgrade,
    init: AcceptInit,
    events: SocketEvents,
  ): TransportSocket | Promise<TransportSocket>
  /**
   * Loads what the transport needs before the server listens (the `ws` package), so that a missing
   * dependency fails the startup (ZNIGHT051) rather than the first handshake.
   */
  ready?(): Promise<void>
  /** `Bun.serve()` transports only: the settings of its `websocket` option. */
  bunWebSocket?(): Readonly<Record<string, unknown>>
  close(): Promise<void>
}
