/**
 * `analyzeClass` of the websocket extension (RFC 0003 §6.2): reads `@Gateway` classes, their
 * lifecycle methods, `@OnMessage` handlers, parameters, guards and route decorators, registers the
 * gateway provider and reports what one class can tell (ZNIGHT005, ZNIGHT007, ZNIGHT017, ZNIGHT050).
 *
 * Handlers may be declared on base classes: the gateway inherits the websocket methods of its
 * analysable bases (the nearest declaration of a method carrying websocket decorators wins).
 */
import type {
  AnalyzeContext,
  ArgInfo,
  ClassInfo,
  ClassRef,
  DecoratorInfo,
  Location,
  MethodInfo,
  ParameterInfo,
  StaticValue,
  TypeInfo,
  ValueRef,
} from '@znight/compiler'
import type { MetaEntry } from '@znight/http/compiler'
import type { GatewayOptionsData, HandlerData, LifecycleData, WebSocketData, WsParamData } from './data.ts'

import { readRouteMeta } from '@znight/http/compiler'
import { checkRoutePath, normalizePath } from '@znight/http/path'

import {
  EVENT_NAME,
  INVALID_DECORATOR,
  INVALID_GATEWAY,
  INVALID_ROUTE,
  METHOD_DECORATORS,
  PARAMETER_DECORATORS,
  parseSize,
  RUNTIME_MODULE,
  SUBPROTOCOL,
  UNVALIDATED_INPUT,
  WsDecorator,
} from './constants.ts'

type Context = AnalyzeContext<WebSocketData>

/** The websocket declarations of one method. */
interface MemberAnalysis {
  readonly method: string
  readonly declaredBy: string
  readonly onConnect: LifecycleData | undefined
  readonly onDisconnect: LifecycleData | undefined
  readonly handlers: readonly HandlerData[]
}

/** Types a `@Payload()` without schema may have (RFC 0003 §5.5). */
const BINARY_TYPES: ReadonlySet<string> = new Set([
  'globalThis#Uint8Array',
  'globalThis#ArrayBuffer',
  'globalThis#Buffer',
  'node:buffer#Buffer',
  'buffer#Buffer',
])

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'path',
  'scope',
  'protocol',
  'protocols',
  'maxPayload',
  'concurrency',
  'rateLimit',
  'backpressure',
])

/** Maximum depth of the base class chain walked for inherited handlers. */
const MAX_CHAIN = 32

/** Analyses a class carrying at least one decorator of the extension. */
export function analyzeWebSocketClass(cls: ClassInfo, ctx: Context): void {
  const gateways = cls.decorators.filter(decorator => decorator.identity === WsDecorator.Gateway)
  const gateway = gateways[0]
  if (gateway === undefined) {
    // analysed anyway: errors on the methods are reported once, here, and validate() reports
    // the decorators of a class that is not a base of a gateway
    analyzeMembers(cls, ctx)
    const decorators = [
      ...cls.decorators.filter(isOwnClassDecorator),
      ...cls.methods.flatMap(method => method.decorators.filter(isOwnMethodDecorator)),
    ].map(decorator => ({ name: decorator.name, location: decorator.location }))
    if (decorators.length > 0) {
      ctx.store({
        kind: 'members',
        identity: cls.identity,
        displayName: cls.displayName,
        abstract: cls.abstract,
        decorators,
      })
    }
    return
  }
  for (const duplicate of gateways.slice(1)) {
    report(ctx, INVALID_DECORATOR, duplicate.location, `@Gateway is applied several times on ${cls.displayName}`, [
      'Keep a single @Gateway: a class serves one path',
    ])
  }
  const read = readGatewayOptions(gateway, cls, ctx)
  const token = ctx.registerProvider(cls, { scope: read.scope })
  const chain = classChain(cls, ctx)

  const merged = new Map<string, MemberAnalysis>()
  for (let index = chain.length - 1; index >= 0; index--) {
    const owner = chain[index] as ClassInfo
    for (const [name, member] of analyzeMembers(owner, ctx, index === 0 ? undefined : cls)) merged.set(name, member)
  }
  const members = [...merged.values()]
  const handlers = members.flatMap(member => member.handlers)
  const onConnect = single(ctx, cls, members, 'onConnect', '@OnConnect')
  const onDisconnect = single(ctx, cls, members, 'onDisconnect', '@OnDisconnect')
  checkHandlers(cls, read.options.protocol, handlers, ctx)
  if (handlers.length === 0 && onConnect === undefined && onDisconnect === undefined) {
    report(
      ctx,
      INVALID_GATEWAY,
      gateway.location,
      `@Gateway ${cls.displayName} has no handler`,
      ['Decorate a public method with @OnMessage("event"), @OnConnect() or @OnDisconnect()'],
      'warning',
    )
  }

  ctx.store({
    kind: 'gateway',
    token,
    identity: cls.identity,
    displayName: cls.displayName,
    path: read.path,
    options: read.options,
    meta: readRouteMeta(ctx, cls),
    handshakeGuards: guardRefs(ctx, cls, cls.decorators, WsDecorator.UseHandshakeGuard),
    messageGuards: guardRefs(ctx, cls, cls.decorators, WsDecorator.UseMessageGuard),
    onConnect,
    onDisconnect,
    handlers,
    chain: chain.map(owner => owner.identity),
    location: gateway.location,
  })
}

function isOwnClassDecorator(decorator: DecoratorInfo): boolean {
  return decorator.identity === WsDecorator.UseHandshakeGuard || decorator.identity === WsDecorator.UseMessageGuard
}

function isOwnMethodDecorator(decorator: DecoratorInfo): boolean {
  return decorator.identity !== undefined && METHOD_DECORATORS.has(decorator.identity)
}

function report(
  ctx: Context,
  code: string,
  location: Location,
  message: string,
  hints?: readonly string[],
  severity: 'error' | 'warning' = 'error',
  related?: readonly { readonly message: string; readonly location: Location }[],
): void {
  ctx.report({
    code: code as never,
    severity,
    message,
    location,
    ...(hints === undefined ? {} : { hints }),
    ...(related === undefined ? {} : { related }),
  })
}

// ------------------------------------------------------------------------------------------ options

interface ReadOptions {
  readonly path: string | undefined
  readonly scope: 'singleton' | 'request'
  readonly options: GatewayOptionsData
}

function isRecord(value: StaticValue): value is Readonly<Record<string, StaticValue>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function describe(value: StaticValue): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return 'an array'
  return isRecord(value) ? 'an object' : 'a reference'
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** `@Gateway()`, `@Gateway('/chat')` or `@Gateway({ path, scope, protocol, ... })`. */
function readGatewayOptions(decorator: DecoratorInfo, cls: ClassInfo, ctx: Context): ReadOptions {
  const prefix = `@Gateway ${cls.displayName}`
  const fallback: ReadOptions = { path: undefined, scope: 'singleton', options: { protocol: 'events' } }
  const arg = decorator.args[0]
  if (!decorator.called) return fallback // reported by the compiler
  if (arg === undefined) return { ...fallback, path: '/' }
  if (!arg.evaluated) return fallback // not statically evaluable: reported by the compiler
  const value = arg.value
  if (typeof value === 'string') return { ...fallback, path: checkPath(ctx, prefix, value, arg.location) }
  if (value === undefined) return { ...fallback, path: '/' }
  if (!isRecord(value)) {
    report(
      ctx,
      INVALID_DECORATOR,
      arg.location,
      `${prefix}: expected a path or an options object, got ${describe(value)}`,
      ["Write @Gateway('/chat') or @Gateway({ path: '/chat', protocol: 'raw' })"],
    )
    return fallback
  }
  const fail = (message: string, hints?: readonly string[]): void => {
    report(ctx, INVALID_GATEWAY, arg.location, `${prefix}: ${message}`, hints)
  }
  for (const key of Object.keys(value)) {
    if (!OPTION_KEYS.has(key)) fail(`unknown option "${key}"`, [`Known options: ${[...OPTION_KEYS].join(', ')}`])
  }
  let path: string | undefined = '/'
  const rawPath = value['path']
  if (rawPath !== undefined) {
    if (typeof rawPath === 'string') path = checkPath(ctx, prefix, rawPath, arg.location)
    else {
      fail(`"path" must be a string, got ${describe(rawPath)}`)
      path = undefined
    }
  }
  let scope: 'singleton' | 'request' = 'singleton'
  const rawScope = value['scope']
  if (rawScope === 'request') scope = 'request'
  else if (rawScope === 'transient') {
    fail("a gateway cannot be 'transient'", [
      "Use scope: 'request' for one instance per connection, or the default singleton",
    ])
  } else if (rawScope !== undefined && rawScope !== 'singleton') {
    fail(`"scope" must be 'singleton' or 'request', got ${describe(rawScope)}`)
  }
  let protocol: 'events' | 'raw' = 'events'
  const rawProtocol = value['protocol']
  if (rawProtocol === 'raw') protocol = 'raw'
  else if (rawProtocol !== undefined && rawProtocol !== 'events') {
    fail(`"protocol" must be 'events' or 'raw', got ${describe(rawProtocol)}`)
  }
  const options: { -readonly [K in keyof GatewayOptionsData]: GatewayOptionsData[K] } = { protocol }
  const protocols = value['protocols']
  if (protocols !== undefined) {
    if (
      !Array.isArray(protocols) ||
      protocols.length === 0 ||
      !protocols.every(item => typeof item === 'string' && SUBPROTOCOL.test(item)) ||
      new Set(protocols).size !== protocols.length
    ) {
      fail(`"protocols" must be a non-empty list of distinct subprotocol tokens, got ${describe(protocols)}`, [
        "protocols: ['chat.v1']",
      ])
    } else {
      options.protocols = protocols as string[]
    }
  }
  const maxPayload = value['maxPayload']
  if (maxPayload !== undefined) {
    const bytes = parseSize(maxPayload)
    if (bytes === undefined)
      fail(`"maxPayload" must be a positive byte size ('64kb', 65536), got ${describe(maxPayload)}`)
    else options.maxPayload = bytes
  }
  const concurrency = value['concurrency']
  if (concurrency !== undefined) {
    if (isPositiveInteger(concurrency)) options.concurrency = concurrency
    else fail(`"concurrency" must be a positive integer, got ${describe(concurrency)}`)
  }
  const rateLimit = value['rateLimit']
  if (rateLimit !== undefined) {
    const onLimit = isRecord(rateLimit) ? (rateLimit['onLimit'] ?? 'reject') : undefined
    if (
      !isRecord(rateLimit) ||
      !isPositiveInteger(rateLimit['messages']) ||
      !isPositiveInteger(rateLimit['intervalMs']) ||
      (onLimit !== 'reject' && onLimit !== 'close') ||
      Object.keys(rateLimit).some(key => key !== 'messages' && key !== 'intervalMs' && key !== 'onLimit')
    ) {
      fail(`"rateLimit" must be { messages, intervalMs, onLimit?: 'reject' | 'close' }, got ${describe(rateLimit)}`, [
        'rateLimit: { messages: 30, intervalMs: 1000 }',
      ])
    } else {
      options.rateLimit = {
        messages: rateLimit['messages'] as number,
        intervalMs: rateLimit['intervalMs'] as number,
        onLimit: onLimit as 'reject' | 'close',
      }
    }
  }
  const backpressure = value['backpressure']
  if (backpressure !== undefined) {
    const limit = isRecord(backpressure) ? backpressure['limit'] : undefined
    const onLimit = isRecord(backpressure) ? backpressure['onLimit'] : undefined
    const bytes = limit === undefined ? undefined : parseSize(limit)
    if (
      !isRecord(backpressure) ||
      (limit !== undefined && bytes === undefined) ||
      (onLimit !== undefined && onLimit !== 'close' && onLimit !== 'drop') ||
      Object.keys(backpressure).some(key => key !== 'limit' && key !== 'onLimit')
    ) {
      fail(`"backpressure" must be { limit?: ByteSize, onLimit?: 'close' | 'drop' }, got ${describe(backpressure)}`)
    } else {
      options.backpressure = {
        ...(bytes === undefined ? {} : { limit: bytes }),
        ...(onLimit === undefined ? {} : { onLimit: onLimit as 'close' | 'drop' }),
      }
    }
  }
  return { path, scope, options }
}

/** The normalised path, or `undefined` when it breaks the route grammar (ZNIGHT007). */
function checkPath(ctx: Context, prefix: string, raw: string, location: Location): string | undefined {
  const path = normalizePath(raw)
  const issue = checkRoutePath(path)
  if (issue === undefined) return path
  report(ctx, INVALID_ROUTE, location, `${prefix}: invalid path "${raw}": ${issue.message}`, [
    "Gateway paths use the route grammar: '/chat', '/docs/:docId', '/feeds/*'",
  ])
  return undefined
}

/** The class and its analysable base classes (nearest first). */
function classChain(cls: ClassInfo, ctx: Context): ClassInfo[] {
  const chain = [cls]
  const seen = new Set([cls.identity])
  let current = cls
  while (current.superClass !== undefined && chain.length < MAX_CHAIN) {
    const base = ctx.classInfo(current.superClass.identity)
    if (base === undefined || seen.has(base.identity)) break
    chain.push(base)
    seen.add(base.identity)
    current = base
  }
  return chain
}

/** `@UseHandshakeGuard` / `@UseMessageGuard` arguments, bound with a gateway → guard edge. */
function guardRefs(ctx: Context, from: ClassInfo, decorators: readonly DecoratorInfo[], identity: string): ClassRef[] {
  const refs: ClassRef[] = []
  for (const decorator of decorators) {
    if (decorator.identity !== identity) continue
    if (decorator.called && decorator.args.length === 0) {
      report(ctx, INVALID_DECORATOR, decorator.location, `@${decorator.name} requires at least one guard`, [
        `@${decorator.name}(MyGuard)`,
      ])
    }
    for (const arg of decorator.args) {
      const ref = ctx.resolveClassRef(arg, { from, role: 'guard' })
      if (ref) refs.push(ref)
    }
  }
  return refs
}

/** The single `@OnConnect` / `@OnDisconnect` of a gateway (ZNIGHT050 for several). */
function single(
  ctx: Context,
  cls: ClassInfo,
  members: readonly MemberAnalysis[],
  key: 'onConnect' | 'onDisconnect',
  name: string,
): LifecycleData | undefined {
  const found = members.flatMap(member => (member[key] === undefined ? [] : [member[key] as LifecycleData]))
  const first = found[0]
  for (const extra of found.slice(1)) {
    report(
      ctx,
      INVALID_GATEWAY,
      extra.location,
      `${cls.displayName} has several ${name} methods: ${found.map(item => `${item.declaredBy}.${item.method}`).join(', ')}`,
      [`Keep a single ${name} method per gateway`],
      'error',
      [{ message: `First ${name} method`, location: (first as LifecycleData).location }],
    )
  }
  return first
}

/** Events handled twice, several default handlers, events on raw gateways (ZNIGHT050). */
function checkHandlers(
  cls: ClassInfo,
  protocol: 'events' | 'raw',
  handlers: readonly HandlerData[],
  ctx: Context,
): void {
  const label = (handler: HandlerData): string => `${handler.declaredBy}.${handler.method}`
  if (protocol === 'raw') {
    for (const handler of handlers) {
      if (handler.event === undefined) continue
      report(
        ctx,
        INVALID_GATEWAY,
        handler.location,
        `@OnMessage("${handler.event}") on the raw gateway ${cls.displayName}`,
        ['A raw gateway has no events: use @OnMessage() for its single handler, or protocol: "events"'],
      )
    }
    const first = handlers[0]
    for (const extra of handlers.slice(1)) {
      report(
        ctx,
        INVALID_GATEWAY,
        extra.location,
        `The raw gateway ${cls.displayName} has several handlers: ${handlers.map(label).join(', ')}`,
        ['A raw gateway has a single @OnMessage() handler receiving every frame'],
        'error',
        [{ message: 'First handler', location: (first as HandlerData).location }],
      )
    }
    return
  }
  let fallback: HandlerData | undefined
  const byEvent = new Map<string, HandlerData>()
  for (const handler of handlers) {
    if (handler.event === undefined) {
      if (fallback === undefined) {
        fallback = handler
        continue
      }
      report(
        ctx,
        INVALID_GATEWAY,
        handler.location,
        `${cls.displayName} has several default handlers: ${label(fallback)} and ${label(handler)}`,
        ['Give one of them an event: @OnMessage("message.send")'],
        'error',
        [{ message: 'First default handler', location: fallback.location }],
      )
      continue
    }
    const first = byEvent.get(handler.event)
    if (first === undefined) {
      byEvent.set(handler.event, handler)
      continue
    }
    report(
      ctx,
      INVALID_GATEWAY,
      handler.location,
      `${cls.displayName} handles "${handler.event}" twice: ${label(first)} and ${label(handler)}`,
      ['An event has a single handler per gateway: merge the methods, or rename one of the events'],
      'error',
      [{ message: 'first handled here', location: first.location }],
    )
  }
}

// ------------------------------------------------------------------------------------------- members

/**
 * Websocket methods declared by `cls` itself, by name. `host` is the gateway when `cls` is one of
 * its bases (its methods were already reported when the base was analysed: no second report).
 */
function analyzeMembers(cls: ClassInfo, ctx: Context, host?: ClassInfo): Map<string, MemberAnalysis> {
  const members = new Map<string, MemberAnalysis>()
  const quiet = host === undefined ? ctx : silenced(ctx)
  for (const method of cls.methods) {
    const member = analyzeMethod(cls, method, quiet, host ?? cls)
    if (member !== undefined) members.set(method.name, member)
  }
  return members
}

/** The context without reports (a base class analysed again for a gateway). */
function silenced(ctx: Context): Context {
  return new Proxy(ctx, {
    get(target, key, receiver) {
      if (key === 'report') return () => undefined
      const value: unknown = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function analyzeMethod(cls: ClassInfo, method: MethodInfo, ctx: Context, host: ClassInfo): MemberAnalysis | undefined {
  const onConnect = method.decorators.filter(decorator => decorator.identity === WsDecorator.OnConnect)
  const onDisconnect = method.decorators.filter(decorator => decorator.identity === WsDecorator.OnDisconnect)
  const onMessage = method.decorators.filter(decorator => decorator.identity === WsDecorator.OnMessage)
  const guards = method.decorators.filter(decorator => decorator.identity === WsDecorator.UseMessageGuard)
  const decoratedParams = method.params.some(param => param.decorators.some(isParameterDecorator))
  if (onConnect.length + onDisconnect.length + onMessage.length + guards.length === 0 && !decoratedParams) {
    return undefined
  }
  const where = `${cls.displayName}.${method.name}`
  const roles = [onConnect[0], onDisconnect[0], onMessage[0]].filter(item => item !== undefined) as DecoratorInfo[]
  const primary = roles[0]
  if (primary === undefined) {
    for (const guard of guards) {
      report(
        ctx,
        INVALID_DECORATOR,
        guard.location,
        `@UseMessageGuard has no effect on ${where}: it is not an @OnMessage handler`,
        ['Add @OnMessage("event") to the method, or put the guard on the gateway class'],
      )
    }
    reportStrayParameters(method, where, ctx)
    return {
      method: method.name,
      declaredBy: cls.displayName,
      onConnect: undefined,
      onDisconnect: undefined,
      handlers: [],
    }
  }
  checkMethodShape(method, primary, where, ctx)
  if (roles.length > 1) {
    report(
      ctx,
      INVALID_GATEWAY,
      (roles[1] as DecoratorInfo).location,
      `${where} has several roles (${roles.map(role => `@${role.name}`).join(', ')})`,
      ['A method is either @OnConnect, @OnDisconnect or an @OnMessage handler: split it'],
    )
  }
  for (const duplicate of [...onConnect.slice(1), ...onDisconnect.slice(1)]) {
    report(ctx, INVALID_DECORATOR, duplicate.location, `@${duplicate.name} is applied several times on ${where}`, [
      `Keep a single @${duplicate.name}`,
    ])
  }
  const location = primary.location
  if (onMessage.length === 0) {
    for (const guard of guards) {
      report(
        ctx,
        INVALID_DECORATOR,
        guard.location,
        `@UseMessageGuard has no effect on ${where}: it is not an @OnMessage handler`,
        ['Message guards run before @OnMessage handlers; guard the handshake with @UseHandshakeGuard on the class'],
      )
    }
    const lifecycle: LifecycleData = {
      method: method.name,
      params: analyzeParams(method, where, 'lifecycle', ctx),
      declaredBy: cls.displayName,
      location,
    }
    return {
      method: method.name,
      declaredBy: cls.displayName,
      onConnect: onConnect.length > 0 ? lifecycle : undefined,
      onDisconnect: onConnect.length === 0 ? lifecycle : undefined,
      handlers: [],
    }
  }
  const params = analyzeParams(method, where, 'message', ctx)
  const meta: readonly MetaEntry[] = readRouteMeta(ctx, cls, method)
  const methodGuards = guardRefs(ctx, host, method.decorators, WsDecorator.UseMessageGuard)
  const handlers = onMessage.flatMap(decorator => {
    const event = eventOf(decorator, where, ctx)
    if (event === false) return []
    return [
      Object.freeze({
        method: method.name,
        event,
        meta,
        guards: methodGuards,
        params,
        declaredBy: cls.displayName,
        location: decorator.location,
      }),
    ]
  })
  return { method: method.name, declaredBy: cls.displayName, onConnect: undefined, onDisconnect: undefined, handlers }
}

/** The event of `@OnMessage(event?)`: a string, `undefined` (default handler) or `false` (invalid). */
function eventOf(decorator: DecoratorInfo, where: string, ctx: Context): string | undefined | false {
  const arg = decorator.args[0]
  if (arg === undefined || (arg.evaluated && arg.value === undefined)) return undefined
  if (!arg.evaluated) return false
  const value = arg.value
  if (typeof value !== 'string') {
    report(
      ctx,
      INVALID_DECORATOR,
      arg.location,
      `@OnMessage on ${where} expects an event name (a string), got ${describe(value)}`,
      ['Use @OnMessage() for the default handler'],
    )
    return false
  }
  if (value.startsWith('$')) {
    report(ctx, INVALID_GATEWAY, arg.location, `Event name "${value}" is reserved (${where})`, [
      `Names starting with "$" are protocol events${value === '$ping' ? '; "$ping" is answered by Znight itself' : ''}`,
    ])
    return false
  }
  if (!EVENT_NAME.test(value)) {
    report(ctx, INVALID_GATEWAY, arg.location, `Invalid event name "${value}" (${where})`, [
      'An event name starts with a letter, then up to 127 letters, digits or _ . : / -',
    ])
    return false
  }
  return value
}

/** Handlers are called by the generated code: `gateway.method(...)`. */
function checkMethodShape(method: MethodInfo, decorator: DecoratorInfo, where: string, ctx: Context): void {
  const name = `@${decorator.name}`
  let problem: readonly [string, string] | undefined
  if (method.kind !== 'method') problem = [`${name} cannot be applied to the accessor ${where}`, 'Use a regular method']
  else if (method.static) problem = [`${name} cannot be applied to the static method ${where}`, 'Remove `static`']
  else if (method.privateName)
    problem = [`${name} cannot be applied to the #private method ${where}`, 'Use a public method']
  else if (method.visibility !== 'public') {
    problem = [
      `${where} must be public: ${name} methods are called by the generated code`,
      `Remove the '${method.visibility}' modifier`,
    ]
  } else if (method.computed)
    problem = [`${name} cannot be applied to ${where}: computed names are not supported`, 'Use a plain method name']
  else if (method.generator)
    problem = [`${name} cannot be applied to the generator method ${where}`, 'Use a regular (or async) method']
  if (problem !== undefined) report(ctx, INVALID_DECORATOR, decorator.location, problem[0], [problem[1]])
}

// ---------------------------------------------------------------------------------------- parameters

function analyzeParams(
  method: MethodInfo,
  where: string,
  role: 'message' | 'lifecycle',
  ctx: Context,
): readonly WsParamData[] {
  let payload: DecoratorInfo | undefined
  return Object.freeze(
    method.params.map(param => {
      const data = analyzeParam(param, where, role, ctx)
      if (data.kind === 'payload' || data.kind === 'validated') {
        const decorator = parameterDecorators(param)[0] as DecoratorInfo
        if (payload !== undefined) {
          report(ctx, INVALID_GATEWAY, decorator.location, `${where} has two @Payload parameters`, [
            'A message has one payload: keep a single @Payload()',
          ])
        }
        payload ??= decorator
      }
      return data
    }),
  )
}

function analyzeParam(param: ParameterInfo, where: string, role: 'message' | 'lifecycle', ctx: Context): WsParamData {
  const absent: WsParamData = { kind: 'undefined', optional: param.optional || param.hasDefault }
  const decorators = parameterDecorators(param)
  const decorator = decorators[0]
  if (decorator === undefined) {
    const foreign = foreignParameterDecorator(param)
    if (foreign !== undefined) {
      report(
        ctx,
        INVALID_DECORATOR,
        foreign.decorator.location,
        `@${foreign.decorator.name} on parameter '${param.name}' of ${where} is imported from '${foreign.module}': gateway handlers use ${foreign.name} from '${RUNTIME_MODULE}'`,
        [`Import it from '${RUNTIME_MODULE}': import { ${foreign.name} } from '${RUNTIME_MODULE}'`],
      )
      return absent
    }
    if (param.optional || param.hasDefault || param.rest) return absent
    report(
      ctx,
      INVALID_GATEWAY,
      param.location,
      `Parameter '${param.name}' of ${where} has no @Payload(), @Conn() or @Ctx() decorator`,
      [
        role === 'message'
          ? 'Every handler parameter is extracted from the message: @Payload(schema?), @Conn() or @Ctx()'
          : '@OnConnect and @OnDisconnect methods receive the connection: @Conn()',
      ],
    )
    return absent
  }
  if (decorators.length > 1) {
    report(
      ctx,
      INVALID_DECORATOR,
      (decorators[1] as DecoratorInfo).location,
      `Parameter '${param.name}' of ${where} has several websocket decorators`,
      ['Keep a single one'],
    )
  }
  if (param.rest) {
    report(
      ctx,
      INVALID_DECORATOR,
      decorator.location,
      `@${decorator.name} cannot be applied to the rest parameter '...${param.name}' of ${where}`,
    )
    return absent
  }
  if (decorator.identity === WsDecorator.Conn) return { kind: 'connection' }
  if (role === 'lifecycle') {
    report(
      ctx,
      INVALID_GATEWAY,
      decorator.location,
      `@${decorator.name} on ${where}: only @OnMessage handlers receive a message`,
      ['@OnConnect and @OnDisconnect methods take @Conn() only'],
    )
    return absent
  }
  if (decorator.identity === WsDecorator.Ctx) return { kind: 'context' }
  return payloadParam(param, decorator, where, ctx)
}

/** `@Payload()` / `@Payload(schema)`. */
function payloadParam(param: ParameterInfo, decorator: DecoratorInfo, where: string, ctx: Context): WsParamData {
  const arg: ArgInfo | undefined = decorator.args[0]
  if (arg === undefined || (arg.evaluated && arg.value === undefined)) {
    checkUnvalidated(param, decorator, where, ctx)
    return { kind: 'payload' }
  }
  if (arg.ref !== undefined) {
    if (isClassReference(arg.ref)) {
      report(
        ctx,
        INVALID_DECORATOR,
        arg.location,
        `@Payload(${arg.text}) on ${where}: '${arg.ref.name}' is a class, not a Standard Schema`,
        ['Pass a Standard Schema (Zod, Valibot, ArkType...): export const SendMessage = z.object({ ... })'],
      )
      return { kind: 'undefined', optional: false }
    }
    return { kind: 'validated', schema: arg.ref }
  }
  if (!arg.evaluated) return { kind: 'undefined', optional: false }
  report(
    ctx,
    INVALID_DECORATOR,
    arg.location,
    `@Payload on ${where} expects a Standard Schema (Zod, Valibot, ArkType...), got ${describe(arg.value)}`,
    ['Declare the schema with `export const SendMessage = z.object({ ... })` and pass it: @Payload(SendMessage)'],
  )
  return { kind: 'undefined', optional: false }
}

/** ZNIGHT017: a structured payload injected without schema is trusted blindly. */
function checkUnvalidated(param: ParameterInfo, decorator: DecoratorInfo, where: string, ctx: Context): void {
  const { type } = ctx.types.stripNullish(param.type)
  if (isSafePayloadType(type)) return
  const typed =
    type.kind === 'opaque' && type.reason === 'missing-annotation'
      ? 'has no type annotation'
      : `is typed '${ctx.types.format(param.type)}'`
  ctx.report({
    code: UNVALIDATED_INPUT as never,
    severity: ctx.options.strictValidation ? 'error' : 'warning',
    message: `Unvalidated message payload: parameter '${param.name}' of ${where} ${typed} but @Payload() has no schema`,
    location: decorator.location,
    hints: [
      'Validate it with a Standard Schema (Zod, Valibot, ArkType...): @Payload(SendMessage)',
      "Or declare the parameter as 'unknown' (or 'string | Uint8Array') and check it in the handler",
    ],
  })
}

/** Parameter decorators of a method that has no websocket role. */
function reportStrayParameters(method: MethodInfo, where: string, ctx: Context): void {
  for (const param of method.params) {
    for (const decorator of parameterDecorators(param)) {
      report(
        ctx,
        INVALID_DECORATOR,
        decorator.location,
        `@${decorator.name} has no effect on parameter '${param.name}' of ${where}: it is not a gateway handler`,
        ['Add @OnMessage("event"), @OnConnect() or @OnDisconnect() to the method, or remove the decorator'],
      )
    }
  }
}

interface ForeignDecorator {
  readonly decorator: DecoratorInfo
  readonly module: string
  readonly name: string
}

/** A parameter decorator named like a websocket one (`Ctx`, `Payload`) imported from another package. */
function foreignParameterDecorator(param: ParameterInfo): ForeignDecorator | undefined {
  for (const decorator of param.decorators) {
    const identity = decorator.identity
    const separator = identity?.lastIndexOf('#') ?? -1
    if (identity === undefined || separator <= 0) continue
    const module = identity.slice(0, separator)
    const name = identity.slice(separator + 1)
    if (module === RUNTIME_MODULE || !module.startsWith('@znight/')) continue
    if (PARAMETER_DECORATORS.has(`${RUNTIME_MODULE}#${name}`)) return { decorator, module, name }
  }
  return undefined
}

/** Websocket decorators of a parameter, de-duplicated by position. */
function parameterDecorators(param: ParameterInfo): DecoratorInfo[] {
  const seen = new Set<number>()
  return param.decorators.filter(decorator => {
    if (!isParameterDecorator(decorator) || seen.has(decorator.location.start)) return false
    seen.add(decorator.location.start)
    return true
  })
}

function isParameterDecorator(decorator: DecoratorInfo): boolean {
  return decorator.identity !== undefined && PARAMETER_DECORATORS.has(decorator.identity)
}

function isClassReference(ref: ValueRef): boolean {
  const symbol = ref.symbol
  return symbol.kind === 'declaration' && symbol.declaration.kind === 'class'
}

/** `string`, `Uint8Array`, `string | Uint8Array`, literals and `unknown` need no schema. */
function isSafePayloadType(type: TypeInfo): boolean {
  switch (type.kind) {
    case 'primitive':
      return type.name !== 'any' && type.name !== 'object'
    case 'literal':
      return true
    case 'union':
      return type.types.every(isSafePayloadType)
    case 'reference':
      return BINARY_TYPES.has(type.identity)
    default:
      return false
  }
}
