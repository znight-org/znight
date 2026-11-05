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
import type { ClassRef, GenerateContext, GenInput, GenNode, StaticValue, ValueRef } from '@znight/compiler'
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
  paramFunctionOf(): GenNode
}

/** The class resolver instances of the handler being generated (`x`), with the position of each token. */
interface Resolvers {
  readonly x: GenNode | undefined
  readonly index: ReadonlyMap<string, number>
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
  const resolvers = paramResolvers(handler)
  if (resolvers.length > 0) {
    entries.push(['paramResolvers', ctx.lit(resolvers.map(ref => ctx.tokenOf(ref) ?? ref.token))])
  }
  entries.push(['invoke', invokeNode(ctx, handler, consumerType, helpers, resolvers)])
  return ctx.obj(entries)
}

/** The provider classes resolving custom parameters, in order of first use (`x[i]`). */
function paramResolvers(handler: HandlerData): ClassRef[] {
  const found = new Map<string, ClassRef>()
  for (const param of handler.params) {
    const resolver = param.kind === 'custom' ? param.resolver : undefined
    if (resolver !== undefined && !found.has(resolver.token)) found.set(resolver.token, resolver)
  }
  return [...found.values()]
}

/**
 * `(c: Consumer, m: InboundMessage) => c.method(...args)`, `async` only when it awaits a schema
 * validation or a custom parameter. `m` is omitted when no argument uses it (`noUnusedParameters`);
 * `x` (the class resolver instances) is declared only when the handler has class resolvers.
 */
function invokeNode(
  ctx: Context,
  handler: HandlerData,
  consumerType: () => GenNode,
  helpers: Helpers,
  resolvers: readonly ClassRef[],
): GenNode {
  const params = [...handler.params]
  while (params.length > 0 && params[params.length - 1]?.kind === 'undefined') params.pop()
  if (params.length === 0) {
    return ctx.arrow([['c', consumerType()]], c => ctx.call(ctx.member(c, handler.method)))
  }
  // `_m` when only class resolvers whose `resolve()` takes no parameter need arguments (`noUnusedParameters`)
  const readsMessage = params.some(
    param =>
      param.kind !== 'undefined' && (param.kind !== 'custom' || param.resolver === undefined || param.arity !== 0),
  )
  const arrowParams: [string, GenNode][] = [
    ['c', consumerType()],
    [readsMessage ? 'm' : '_m', helpers.inboundMessage()],
  ]
  if (resolvers.length > 0) {
    const types = resolvers.map(ref => ctx.importType(ref))
    const joined = types.slice(1).reduce((all, node) => ctx.code`${all}, ${node}`, types[0] as GenNode)
    arrowParams.push(['x', ctx.code`readonly [${joined}]`])
  }
  const index = new Map(resolvers.map((ref, position) => [ref.token, position]))
  return ctx.arrow(
    arrowParams,
    (c, m, x) =>
      ctx.call(
        ctx.member(c, handler.method),
        params.map(param => argumentNode(ctx, param, m as GenNode, helpers, { x, index })),
      ),
    { async: params.some(param => param.kind === 'validated' || param.kind === 'custom') },
  )
}

function argumentNode(
  ctx: Context,
  param: HandlerParamData,
  m: GenNode,
  helpers: Helpers,
  resolvers: Resolvers,
): GenNode {
  switch (param.kind) {
    case 'custom':
      return customArgument(ctx, param, m, helpers, resolvers)
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

/**
 * A custom parameter (RFC 0010), awaited (the invoke is `async`):
 * `await (D.resolvers.messaging as ParamFunctionOf<typeof D, 'messaging'>)(m, data)` or
 * `await x[i].resolve(m, data)`, cast with `as never` when the value type could not be checked.
 */
function customArgument(
  ctx: Context,
  param: Extract<HandlerParamData, { kind: 'custom' }>,
  m: GenNode,
  helpers: Helpers,
  resolvers: Resolvers,
): GenNode {
  const data = param.data === undefined ? ctx.lit(undefined) : dataNode(ctx, param.data.value)
  let node: GenNode
  if (param.resolver === undefined) {
    const decorator = ctx.importValue(param.identity)
    const type = ctx.code`${helpers.paramFunctionOf()}<typeof ${decorator}, 'messaging'>`
    node = ctx.call(ctx.code`${ctx.member(decorator, 'resolvers', 'messaging')} as ${type}`, [m, data])
  } else {
    const position = resolvers.index.get(param.resolver.token) as number
    if (param.arity === undefined) {
      // a `resolve` the compiler cannot read (inherited from a mixin...): the instance is cast to a
      // method taking both arguments (method parameters are bivariant), the value with `as never`
      const instance = ctx.code`${resolvers.x as GenNode}[${position}] as { resolve(message: unknown, data: unknown): unknown }`
      return ctx.code`(await (${instance}).resolve(${m}, ${data})) as never`
    }
    // a `resolve(message)` that ignores the data gets no data argument (TypeScript checks the arity)
    const arity = Math.min(param.arity, 2)
    let args = ctx.code``
    if (arity === 1) args = m
    else if (arity === 2) args = ctx.code`${m}, ${data}`
    node = ctx.code`${resolvers.x as GenNode}[${position}].resolve(${args})`
  }
  return param.cast ? ctx.code`(await ${node}) as never` : ctx.code`await ${node}`
}

/** The data argument of a custom parameter: a literal (references imported) or a reference. */
function dataNode(ctx: Context, value: StaticValue): GenNode {
  return isValueRef(value) ? ctx.ref(value as ValueRef) : ctx.lit(value as never)
}

/** `true` for a {@link ValueRef} (the only non-plain object a static value can hold). */
function isValueRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype !== Object.prototype && prototype !== null && (value as { kind?: unknown }).kind === 'ref'
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
    paramFunctionOf: () => {
      let node = cache.get('@znight/core#ParamFunctionOf')
      if (node === undefined) {
        node = ctx.importFrom('@znight/core', 'ParamFunctionOf', { type: true })
        cache.set('@znight/core#ParamFunctionOf', node)
      }
      return node
    },
  }
}
