/**
 * `generate` of the messaging extension: `metadata.extensions.messaging` (README "Compiler contract",
 * spec §9.2). Consumers are sorted by token; handlers keep their declaration order.
 *
 * ```ts
 * {
 *   consumers: [{
 *     token: 'src/orders/order.consumer.ts#OrderConsumer',
 *     queue: 'orders',
 *     handlers: [{
 *       method: 'placed',
 *       type: 'order.placed',
 *       retry: { attempts: 5, backoff: 'exponential', delay: 500, maxDelay: 30000 },
 *       invoke: async (c: OrderConsumer, m: InboundMessage) => c.placed(await validateMessage(OrderPlaced, m.payload)),
 *     }],
 *     errorHandler: 'onError',
 *   }],
 * }
 * ```
 */
import type { GenerateContext, GenInput, GenNode } from '@znight/compiler'
import type { ConsumerData, HandlerData, HandlerParamData, MessagingData } from './data.ts'

import { compareStrings, RUNTIME_MODULE } from './constants.ts'

type Context = GenerateContext<MessagingData>

/**
 * Imports of the runtime helpers, created on first use only: an import the module does not use would
 * break `noUnusedLocals`.
 */
interface Helpers {
  inboundMessage(): GenNode
  validateMessage(): GenNode
  messageHeader(): GenNode
}

/** Builds the messaging section; `undefined` (no section) when the application has no consumer. */
export function generateMessaging(ctx: Context): GenNode | undefined {
  const consumers = ctx.stored
    .filter((data): data is ConsumerData => data.kind === 'consumer')
    .sort((a, b) => compareStrings(a.token, b.token))
  if (consumers.length === 0) return undefined
  const helpers = lazyHelpers(ctx)
  return ctx.obj([['consumers', ctx.arr(consumers.map(consumer => consumerNode(ctx, consumer, helpers)))]])
}

function consumerNode(ctx: Context, consumer: ConsumerData, helpers: Helpers): GenNode {
  let classType: GenNode | undefined
  const consumerType = (): GenNode => {
    classType ??= ctx.importType(consumer.identity)
    return classType
  }
  const entries: [string, GenInput][] = [
    ['token', consumer.token],
    ['queue', consumer.queue],
  ]
  if (consumer.options !== undefined) entries.push(['options', ctx.lit(consumer.options)])
  entries.push([
    'handlers',
    ctx.arr(consumer.handlers.map(handler => handlerNode(ctx, handler, consumerType, helpers))),
  ])
  if (consumer.errorHandler !== undefined) entries.push(['errorHandler', consumer.errorHandler])
  return ctx.obj(entries)
}

function handlerNode(ctx: Context, handler: HandlerData, consumerType: () => GenNode, helpers: Helpers): GenNode {
  const entries: [string, GenInput][] = [['method', handler.method]]
  if (handler.type !== undefined) entries.push(['type', handler.type])
  if (handler.retry !== undefined) entries.push(['retry', ctx.lit({ ...handler.retry })])
  entries.push(['invoke', invokeNode(ctx, handler, consumerType, helpers)])
  return ctx.obj(entries)
}

/**
 * `(c: Consumer, m: InboundMessage) => c.method(...args)`, `async` only when it awaits a schema
 * validation. `m` is omitted when no argument uses it (`noUnusedParameters`).
 */
function invokeNode(ctx: Context, handler: HandlerData, consumerType: () => GenNode, helpers: Helpers): GenNode {
  const params = [...handler.params]
  while (params.length > 0 && params[params.length - 1]?.kind === 'undefined') params.pop()
  if (params.length === 0) {
    return ctx.arrow([['c', consumerType()]], c => ctx.call(ctx.member(c, handler.method)))
  }
  return ctx.arrow(
    [
      ['c', consumerType()],
      ['m', helpers.inboundMessage()],
    ],
    (c, m) =>
      ctx.call(
        ctx.member(c, handler.method),
        params.map(param => argumentNode(ctx, param, m as GenNode, helpers)),
      ),
    { async: params.some(param => param.kind === 'validated') },
  )
}

function argumentNode(ctx: Context, param: HandlerParamData, m: GenNode, helpers: Helpers): GenNode {
  switch (param.kind) {
    case 'payload':
      return ctx.code`${ctx.member(m, 'payload')} as never`
    case 'validated':
      return ctx.code`await ${ctx.call(helpers.validateMessage(), [ctx.importValue(param.schema), ctx.member(m, 'payload')])}`
    case 'headers':
      return ctx.member(m, 'headers')
    case 'header':
      return ctx.call(helpers.messageHeader(), [m, param.name])
    case 'message':
      return param.narrow ? ctx.code`${m} as ${helpers.inboundMessage()}<never>` : m
    case 'undefined':
      return ctx.lit(undefined)
  }
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
    inboundMessage: () => get('InboundMessage', true),
    validateMessage: () => get('validateMessage', false),
    messageHeader: () => get('messageHeader', false),
  }
}
