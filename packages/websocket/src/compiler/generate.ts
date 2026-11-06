/**
 * `generate` of the websocket extension (RFC 0003 §7): `metadata.extensions.websocket`, gateways
 * sorted by token, handlers in declaration order (bases first), optional fields omitted.
 *
 * ```ts
 * {
 *   gateways: [{
 *     token: 'src/chat/chat.gateway.ts#ChatGateway',
 *     path: '/chat',
 *     protocol: 'events',
 *     meta: { authenticated: true },
 *     handshakeGuards: [],
 *     messageGuards: [],
 *     onConnect: { method: 'connected', invoke: (g: ChatGateway, c: WsConnection) => g.connected(c as never) },
 *     handlers: [{
 *       method: 'join', event: 'room.join', meta: {}, guards: [], params: [...],
 *       invoke: async (g: ChatGateway, m: WsMessageContext) => g.join(m.connection as never, await validatePayload(JoinRoom, m.data)),
 *     }],
 *   }],
 * }
 * ```
 */
import type { ClassRef, GenerateContext, GenInput, GenNode } from '@znight/compiler'
import type { MetaEntry } from '@znight/http/compiler'
import type { GatewayData, HandlerData, LifecycleData, WebSocketData, WsParamData } from './data.ts'

import { compareStrings, RUNTIME_MODULE } from './constants.ts'

type Context = GenerateContext<WebSocketData>

/** Imports of the runtime helpers, created on first use (no unused import in the module). */
interface Helpers {
  connection(): GenNode
  messageContext(): GenNode
  validatePayload(): GenNode
}

/** Builds the websocket section; `undefined` (no section) without gateways. */
export function generateWebSocket(ctx: Context): GenNode | undefined {
  const gateways = ctx.stored
    .filter((data): data is GatewayData => data.kind === 'gateway')
    .sort((a, b) => compareStrings(a.token, b.token))
  if (gateways.length === 0) return undefined
  const helpers = lazyHelpers(ctx)
  const entries: [string, GenInput][] = [
    ['gateways', ctx.arr(gateways.map(gateway => gatewayNode(ctx, gateway, helpers)))],
  ]
  const groups = groupsNode(ctx, gateways)
  if (groups !== undefined) entries.push(['groups', groups])
  return ctx.obj(entries)
}

function gatewayNode(ctx: Context, gateway: GatewayData, helpers: Helpers): GenNode {
  let classType: GenNode | undefined
  const gatewayType = (): GenNode => {
    classType ??= ctx.importType(gateway.identity)
    return classType
  }
  const options = gateway.options
  const entries: [string, GenInput][] = [
    ['token', gateway.token],
    ['path', gateway.path ?? '/'],
    ['protocol', options.protocol],
  ]
  if (options.protocols !== undefined) entries.push(['protocols', ctx.lit([...options.protocols])])
  if (options.maxPayload !== undefined) entries.push(['maxPayload', options.maxPayload])
  if (options.concurrency !== undefined) entries.push(['concurrency', options.concurrency])
  if (options.rateLimit !== undefined) entries.push(['rateLimit', ctx.lit({ ...options.rateLimit })])
  if (options.backpressure !== undefined) entries.push(['backpressure', ctx.lit({ ...options.backpressure })])
  entries.push(
    ['meta', metaNode(ctx, gateway.meta)],
    ['handshakeGuards', tokens(ctx, gateway.handshakeGuards)],
    ['messageGuards', tokens(ctx, gateway.messageGuards)],
  )
  if (gateway.onConnect !== undefined) {
    entries.push(['onConnect', lifecycleNode(ctx, gateway.onConnect, gatewayType, helpers)])
  }
  if (gateway.onDisconnect !== undefined) {
    entries.push(['onDisconnect', lifecycleNode(ctx, gateway.onDisconnect, gatewayType, helpers)])
  }
  entries.push(['handlers', ctx.arr(gateway.handlers.map(handler => handlerNode(ctx, handler, gatewayType, helpers)))])
  return ctx.obj(entries)
}

function metaNode(ctx: Context, meta: readonly MetaEntry[]): GenNode {
  return ctx.obj(meta.map(entry => [entry.key, ctx.lit(entry.value)] as const))
}

function tokens(ctx: Context, refs: readonly ClassRef[]): GenNode {
  return ctx.arr(refs.map(ref => ctx.tokenOf(ref) ?? ref.token))
}

/** Trailing parameters left `undefined` are not passed. */
function trimmed(params: readonly WsParamData[]): WsParamData[] {
  const list = [...params]
  while (list.length > 0 && list[list.length - 1]?.kind === 'undefined') list.pop()
  return list
}

/** `{ method, invoke: (g: Gateway, c: WsConnection) => g.method(c as never) }`. */
function lifecycleNode(ctx: Context, lifecycle: LifecycleData, gatewayType: () => GenNode, helpers: Helpers): GenNode {
  const params = trimmed(lifecycle.params)
  const invoke =
    params.length === 0
      ? ctx.arrow([['g', gatewayType()]], g => ctx.call(ctx.member(g, lifecycle.method)))
      : ctx.arrow(
          [
            ['g', gatewayType()],
            ['c', helpers.connection()],
          ],
          (g, c) =>
            ctx.call(
              ctx.member(g, lifecycle.method),
              params.map(param =>
                param.kind === 'connection' ? ctx.code`${c as GenNode} as never` : ctx.lit(undefined),
              ),
            ),
        )
  return ctx.obj([
    ['method', lifecycle.method],
    ['invoke', invoke],
  ])
}

function handlerNode(ctx: Context, handler: HandlerData, gatewayType: () => GenNode, helpers: Helpers): GenNode {
  const entries: [string, GenInput][] = [['method', handler.method]]
  if (handler.event !== undefined) entries.push(['event', handler.event])
  entries.push(
    ['meta', metaNode(ctx, handler.meta)],
    ['guards', tokens(ctx, handler.guards)],
    ['params', ctx.arr(handler.params.flatMap((param, index) => paramNode(ctx, param, index)))],
    ['invoke', invokeNode(ctx, handler, gatewayType, helpers)],
  )
  return ctx.obj(entries)
}

/** The informational `params` entry of a parameter (none for a parameter left `undefined`). */
function paramNode(ctx: Context, param: WsParamData, index: number): GenNode[] {
  switch (param.kind) {
    case 'payload':
      return [
        ctx.obj([
          ['index', index],
          ['source', 'payload'],
        ]),
      ]
    case 'validated':
      return [
        ctx.obj([
          ['index', index],
          ['source', 'payload'],
          ['schema', true],
        ]),
      ]
    case 'connection':
      return [
        ctx.obj([
          ['index', index],
          ['source', 'connection'],
        ]),
      ]
    case 'context':
      return [
        ctx.obj([
          ['index', index],
          ['source', 'context'],
        ]),
      ]
    case 'undefined':
      return []
  }
}

/** `(g: Gateway, m: WsMessageContext) => g.method(...args)`, `async` when a payload is validated. */
function invokeNode(ctx: Context, handler: HandlerData, gatewayType: () => GenNode, helpers: Helpers): GenNode {
  const params = trimmed(handler.params)
  if (params.length === 0) {
    return ctx.arrow([['g', gatewayType()]], g => ctx.call(ctx.member(g, handler.method)))
  }
  return ctx.arrow(
    [
      ['g', gatewayType()],
      ['m', helpers.messageContext()],
    ],
    (g, m) =>
      ctx.call(
        ctx.member(g, handler.method),
        params.map(param => argumentNode(ctx, param, m as GenNode, helpers)),
      ),
    { async: params.some(param => param.kind === 'validated') },
  )
}

function argumentNode(ctx: Context, param: WsParamData, m: GenNode, helpers: Helpers): GenNode {
  switch (param.kind) {
    case 'payload':
      return ctx.code`${ctx.member(m, 'data')} as never`
    case 'validated':
      return ctx.code`await ${ctx.call(helpers.validatePayload(), [ctx.importValue(param.schema), ctx.member(m, 'data')])}`
    case 'connection':
      return ctx.code`${ctx.member(m, 'connection')} as never`
    case 'context':
      return m
    case 'undefined':
      return ctx.lit(undefined)
  }
}

/**
 * `groups`: the route decorator groups the runtime needs (required, holding several keys, or named
 * differently from their key), sorted; `undefined` when there is none (as `extensions.http`).
 */
function groupsNode(ctx: Context, gateways: readonly GatewayData[]): GenNode | undefined {
  const groups = new Map<string, { readonly keys: Set<string>; required: boolean }>()
  const visit = (entries: readonly MetaEntry[]): void => {
    for (const entry of entries) {
      const group = groups.get(entry.group)
      if (group === undefined) groups.set(entry.group, { keys: new Set([entry.key]), required: entry.required })
      else {
        group.keys.add(entry.key)
        group.required ||= entry.required
      }
    }
  }
  for (const gateway of gateways) {
    visit(gateway.meta)
    for (const handler of gateway.handlers) visit(handler.meta)
  }
  const needed = [...groups]
    .filter(([name, group]) => group.required || group.keys.size > 1 || !group.keys.has(name))
    .sort(([a], [b]) => compareStrings(a, b))
  if (needed.length === 0) return undefined
  return ctx.obj(
    needed.map(
      ([name, group]) =>
        [
          name,
          ctx.obj([
            ['keys', ctx.lit([...group.keys].sort(compareStrings))],
            ['required', group.required],
          ]),
        ] as const,
    ),
  )
}

function lazyHelpers(ctx: Context): Helpers {
  const cache = new Map<string, GenNode>()
  const get = (name: string, type: boolean): GenNode => {
    let node = cache.get(name)
    if (node === undefined) {
      node = ctx.importFrom(RUNTIME_MODULE, name, type ? { type: true } : {})
      cache.set(name, node)
    }
    return node
  }
  return {
    connection: () => get('WsConnection', true),
    messageContext: () => get('WsMessageContext', true),
    validatePayload: () => get('validatePayload', false),
  }
}
