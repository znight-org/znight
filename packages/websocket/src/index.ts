/**
 * `@znight/websocket` (RFC 0003): WebSocket gateways served by the
 * `HttpPlugin` server. This entry holds the marker decorators, `WebSocketPlugin`, `WsServer`, the
 * exceptions, the envelope of the wire protocol and the helpers of the generated code.
 */

export type { WsConnectOptions, WsWaitOptions } from './client.ts'
export type { WsExceptionMapper, WsGuard, WsMessageContext } from './context.ts'
export type {
  GatewayDefinition,
  WebSocketMetadata,
  WsHandlerDefinition,
  WsLifecycleDefinition,
  WsParamDefinition,
} from './metadata.ts'
export type {
  BackpressureOptions,
  GatewayOptions,
  RateLimitOptions,
  WebSocketPluginOptions,
  WsOrigins,
  WsProviderRef,
} from './options.ts'
export type {
  AcceptInit,
  SendStatus,
  SocketEvents,
  TransportSettings,
  TransportSocket,
  WebSocketTransport,
} from './transport.ts'

export { WsClient, WsHandshakeError, WsRequestError } from './client.ts'
export {
  WsClosedError,
  type WsCloseInfo,
  type WsCloseInitiator,
  type WsConnection,
  type WsSendResult,
  type WsStats,
} from './connection.ts'
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
  jsonCodec,
  type MessageId,
  type OutboundMessage,
  type WireError,
  type WsCodec,
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
export { WebSocketPlugin, type WsGatewaySummary } from './plugin.ts'
export { TokenBucket } from './rate-limit.ts'
export { type Broadcast, type ChannelMember, type MemberRef, RoomRegistry } from './rooms.ts'
export { type GatewayChannel, type GatewayRef, type ServedGateway, WsServer } from './server.ts'
export { WsTokens } from './tokens.ts'
export { MemoryClient, type MemoryCloseInfo, memoryTransport } from './transports/memory.ts'
export { validatePayload } from './validate.ts'
