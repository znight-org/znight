/**
 * `@znight/websocket/compiler`: the compiler extension of `@znight/websocket` (RFC 0003 §6, §7).
 *
 * Loaded by `@znight/compiler` through the package manifest (`package.json#znight.compiler`). It
 * reads `@Gateway` classes, their `@OnConnect` / `@OnMessage` / `@OnDisconnect` methods, `@Payload`
 * / `@Conn` / `@Ctx` parameters, guards and route decorators, registers gateways as providers,
 * reports invalid gateways at build time and generates `metadata.extensions.websocket`.
 *
 * This entry only `import type`s from `@znight/compiler`, imports `@znight/http/compiler` and
 * `@znight/http/path` (both runtime-free) and never loads the WebSocket runtime.
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { WebSocketData } from './data.ts'

import { analyzeWebSocketClass } from './analyze.ts'
import { EXTENSION_NAME, WsDecorator } from './constants.ts'
import { generateWebSocket } from './generate.ts'
import { validateWebSocket } from './validate.ts'

export type {
  GatewayData,
  GatewayOptionsData,
  HandlerData,
  LifecycleData,
  MemberClassData,
  WebSocketData,
  WsParamData,
} from './data.ts'

/** Decorators owned by the extension (static / value arguments, spec §4.6). */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [WsDecorator.Gateway]: { targets: ['class'], params: ['static'] },
  [WsDecorator.OnConnect]: { targets: ['method'], params: [] },
  [WsDecorator.OnDisconnect]: { targets: ['method'], params: [] },
  [WsDecorator.OnMessage]: { targets: ['method'], params: ['static'] },
  [WsDecorator.Payload]: { targets: ['parameter'], params: ['value'] },
  [WsDecorator.Conn]: { targets: ['parameter'], params: [] },
  [WsDecorator.Ctx]: { targets: ['parameter'], params: [] },
  [WsDecorator.UseHandshakeGuard]: { targets: ['class'], params: [], rest: 'value' },
  [WsDecorator.UseMessageGuard]: { targets: ['class', 'method'], params: [], rest: 'value' },
} satisfies Record<string, DecoratorSpec>)

/** The `@znight/websocket` compiler extension. */
export const webSocketCompilerExtension: CompilerExtension<WebSocketData> = Object.freeze({
  apiVersion: 1,
  name: EXTENSION_NAME,
  decorators,
  analyzeClass: analyzeWebSocketClass,
  validate: validateWebSocket,
  generate: generateWebSocket,
})

export default webSocketCompilerExtension
