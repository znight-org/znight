/**
 * `@znight/websocket` (RFC 0003, implementation in progress): WebSocket gateways served by the
 * `HttpPlugin` server. This entry holds the marker decorators, the gateway options, the exceptions
 * and the envelope of the wire protocol; the runtime plugin, the transports and the compiler
 * extension come with the next milestones.
 */

export type { BackpressureOptions, GatewayOptions, RateLimitOptions } from './options.ts'
export type {
  AcceptInit,
  SendStatus,
  SocketEvents,
  TransportSettings,
  TransportSocket,
  WebSocketTransport,
} from './transport.ts'

export {
  Conn,
  Ctx,
  Gateway,
  type GatewayClassMarker,
  type GatewayClassOrMethodMarker,
  type GatewayMethodMarker,
  type GatewayParameterMarker,
  OnConnect,
  OnDisconnect,
  OnMessage,
  Payload,
  UseHandshakeGuard,
  UseMessageGuard,
} from './decorators.ts'
export {
  decodeFrame,
  EVENT_NAME,
  encodeErrorEvent,
  encodeErrorReply,
  encodeEvent,
  encodeReply,
  type InboundFailure,
  type InboundMessage,
  isFailure,
  isMessageId,
  type MessageId,
  type WireError,
} from './envelope.ts'
export {
  codeOfStatus,
  WsCloseCode,
  WsErrorCode,
  WsException,
  type WsExceptionOptions,
  WsValidationException,
  type WsValidationIssue,
} from './exceptions.ts'
export { MemoryClient, type MemoryCloseInfo, memoryTransport } from './transports/memory.ts'
