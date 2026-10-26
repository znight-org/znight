/**
 * `analyzeClass` of the messaging extension: reads `@Consumer` classes, their `@OnMessage` handlers
 * (`@Retry`, parameters), their `@OnError` method, registers the consumer provider and reports every
 * problem that can be detected on one class (ZNIGHT005, ZNIGHT011, ZNIGHT017).
 *
 * Handlers may be declared on base classes: the consumer inherits the messaging methods of its
 * analysable base classes (the nearest declaration of a method carrying messaging decorators wins, an
 * override without decorators keeps the inherited handler).
 */
import type {
  AnalyzeContext,
  ClassInfo,
  DecoratorInfo,
  Location,
  MethodInfo,
  ParameterInfo,
  StaticValue,
  TypeHelpers,
  TypeInfo,
  ValueRef,
} from '@znight/compiler'
import type { Scope } from '@znight/core'
import type { HandlerData, HandlerParamData, MessagingData, RetryPolicyData } from './data.ts'

import {
  CONSUMER_SCOPES,
  INBOUND_MESSAGE_IDENTITY,
  INVALID_CONSUMER,
  INVALID_DECORATOR,
  METHOD_DECORATORS,
  MessagingDecorator,
  PARAMETER_DECORATORS,
  UNVALIDATED_INPUT,
} from './constants.ts'
import { isPattern, patternCovers } from './patterns.ts'
import { normalizeRetryDecorator } from './retry.ts'
import { describeValue, isRecord, propertyLocation } from './values.ts'

type Context = AnalyzeContext<MessagingData>

/** The messaging declarations of one method. */
interface MemberAnalysis {
  readonly method: string
  readonly declaredBy: string
  /** Number of `@OnMessage` decorators (valid or not). */
  readonly onMessage: number
  /** One entry per valid `@OnMessage` decorator. */
  readonly handlers: readonly HandlerData[]
  /** Location of the `@OnError` decorator when the method is the error handler. */
  readonly errorHandler: Location | undefined
}

/** Types injected as is by `@Message()` without being "unvalidated input" (binary payloads). */
const BINARY_TYPES: ReadonlySet<string> = new Set([
  'globalThis#Uint8Array',
  'globalThis#ArrayBuffer',
  'globalThis#Buffer',
  'node:buffer#Buffer',
  'buffer#Buffer',
])

/** Maximum depth of the base class chain walked for inherited handlers. */
const MAX_CHAIN = 32

/** Analyses a class carrying at least one decorator of the extension. */
export function analyzeMessagingClass(cls: ClassInfo, ctx: Context): void {
  const own = analyzeMembers(cls, ctx)
  const consumers = cls.decorators.filter(decorator => decorator.identity === MessagingDecorator.Consumer)
  const consumer = consumers[0]
  if (consumer === undefined) {
    const decorators = cls.methods.flatMap(method =>
      method.decorators
        .filter(decorator => decorator.identity !== undefined && METHOD_DECORATORS.has(decorator.identity))
        .map(decorator => ({ name: decorator.name, location: decorator.location })),
    )
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
  for (const duplicate of consumers.slice(1)) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@${duplicate.name} is applied several times on ${cls.displayName}`,
      location: duplicate.location,
      hints: [`Keep a single @${duplicate.name}: a class consumes one queue`],
    })
  }

  const options = readConsumerOptions(consumer, cls, ctx)
  const token = ctx.registerProvider(cls, { scope: options.scope })
  const chain = classChain(cls, ctx)

  // messaging methods of the class and its bases: the nearest declaration wins, at the position of
  // the first declaration (base classes first)
  const merged = new Map<string, MemberAnalysis>()
  for (let index = chain.length - 1; index >= 0; index--) {
    const owner = chain[index] as ClassInfo
    for (const [name, member] of index === 0 ? own : analyzeMembers(owner, ctx)) merged.set(name, member)
  }
  const members = [...merged.values()]
  const handlers = members.flatMap(member => member.handlers)

  if (!members.some(member => member.onMessage > 0)) {
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `@Consumer ${cls.displayName} has no @OnMessage handler`,
      location: consumer.location,
      hints: ['Decorate at least one public method with @OnMessage() (default handler) or @OnMessage("type")'],
    })
  }
  checkHandlerTypes(cls.displayName, handlers, ctx)

  const errorHandlers = members.filter(member => member.errorHandler !== undefined)
  const errorHandler = errorHandlers[0]
  for (const extra of errorHandlers.slice(1)) {
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `@Consumer ${cls.displayName} has several @OnError methods: ${errorHandlers.map(member => `${member.declaredBy}.${member.method}()`).join(', ')}`,
      location: extra.errorHandler as Location,
      hints: ['Keep a single @OnError method per consumer'],
      related: [{ message: 'First @OnError method', location: errorHandler?.errorHandler as Location }],
    })
  }

  ctx.store({
    kind: 'consumer',
    token,
    identity: cls.identity,
    displayName: cls.displayName,
    queue: options.queue,
    options: options.options,
    handlers,
    errorHandler: errorHandler?.method,
    chain: chain.map(owner => owner.identity),
    location: consumer.location,
  })
}

// ------------------------------------------------------------------------------------------ consumer

interface ConsumerOptions {
  /** Empty when invalid (reported). */
  readonly queue: string
  readonly scope: Scope
  readonly options: Readonly<Record<string, StaticValue>> | undefined
}

/** `@Consumer(queue)` / `@Consumer({ queue, scope?, concurrency?, deadLetter?, ...driver options })`. */
function readConsumerOptions(decorator: DecoratorInfo, cls: ClassInfo, ctx: Context): ConsumerOptions {
  const invalid: ConsumerOptions = { queue: '', scope: 'singleton', options: undefined }
  const prefix = `@Consumer ${cls.displayName}`
  if (!decorator.called) return invalid // `@Consumer` without call: already reported
  const arg = decorator.args[0]
  if (arg === undefined) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `${prefix}: the queue to consume is required`,
      location: decorator.location,
      hints: ["Write @Consumer('orders') or @Consumer({ queue: 'orders', concurrency: 5 })"],
    })
    return invalid
  }
  if (!arg.evaluated) return invalid // not statically evaluable: already reported
  const value = arg.value
  if (typeof value === 'string') {
    if (value === '') {
      ctx.report({
        code: INVALID_CONSUMER,
        severity: 'error',
        message: `${prefix}: the queue must be a non-empty string`,
        location: arg.location,
      })
    }
    return { queue: value, scope: 'singleton', options: undefined }
  }
  if (!isRecord(value)) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `${prefix}: expected a queue name or an options object ({ queue, scope?, concurrency?, deadLetter? }), got ${describeValue(value)}`,
      location: arg.location,
    })
    return invalid
  }

  const fail = (key: string, message: string, hints?: readonly string[]): void => {
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `${prefix}: ${message}`,
      location: propertyLocation(ctx.project, arg, key),
      ...(hints === undefined ? {} : { hints }),
    })
  }

  let queue = ''
  const rawQueue = value['queue']
  if (rawQueue === undefined) {
    fail('queue', 'the "queue" option is required', ["Write @Consumer({ queue: 'orders', ... })"])
  } else if (typeof rawQueue !== 'string' || rawQueue === '') {
    fail('queue', `"queue" must be a non-empty string, got ${describeValue(rawQueue)}`)
  } else {
    queue = rawQueue
  }

  let scope: Scope = 'singleton'
  const rawScope = value['scope']
  if (rawScope !== undefined) {
    if (typeof rawScope === 'string' && CONSUMER_SCOPES.includes(rawScope)) {
      scope = rawScope as Scope
    } else {
      fail('scope', `"scope" must be 'singleton', 'request' or 'transient', got ${describeValue(rawScope)}`)
    }
  }

  const concurrency = value['concurrency']
  if (
    concurrency !== undefined &&
    !(typeof concurrency === 'number' && Number.isSafeInteger(concurrency) && concurrency > 0)
  ) {
    fail('concurrency', `"concurrency" must be a positive integer, got ${describeValue(concurrency)}`)
  }

  const deadLetter = value['deadLetter']
  if (deadLetter !== undefined && deadLetter !== false && (typeof deadLetter !== 'string' || deadLetter === '')) {
    fail('deadLetter', `"deadLetter" must be a queue name or false, got ${describeValue(deadLetter)}`)
  } else if (deadLetter === queue && queue !== '') {
    fail('deadLetter', `the dead-letter queue cannot be the consumed queue "${queue}"`, [
      'Use another queue (default: the driver naming, e.g. "orders.dlq"), or false to disable dead-lettering',
    ])
  }

  const options: Record<string, StaticValue> = {}
  for (const [key, option] of Object.entries(value)) {
    if (key === 'queue' || key === 'scope' || option === undefined) continue
    options[key] = option
  }
  return { queue, scope, options: Object.keys(options).length === 0 ? undefined : Object.freeze(options) }
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

/**
 * Handler selection checks, mirroring the runtime (`consumers.ts`): exact types first, then patterns
 * in declaration order, then the single default handler.
 */
function checkHandlerTypes(consumer: string, handlers: readonly HandlerData[], ctx: Context): void {
  let fallback: HandlerData | undefined
  const exact = new Map<string, HandlerData>()
  const patterns: (HandlerData & { readonly type: string })[] = []
  const label = (handler: HandlerData): string => `${handler.declaredBy}.${handler.method}()`
  for (const handler of handlers) {
    const type = handler.type
    if (type === undefined) {
      if (fallback === undefined) {
        fallback = handler
        continue
      }
      ctx.report({
        code: INVALID_CONSUMER,
        severity: 'error',
        message: `@Consumer ${consumer}: ${label(fallback)} and ${label(handler)} are both default @OnMessage() handlers`,
        location: handler.location,
        hints: ['Give one of them a message type: @OnMessage("order.created")'],
        related: [{ message: 'First default handler', location: fallback.location }],
      })
      continue
    }
    const previous = isPattern(type) ? patterns.find(pattern => pattern.type === type) : exact.get(type)
    if (previous !== undefined) {
      ctx.report({
        code: INVALID_CONSUMER,
        severity: 'error',
        message: `@Consumer ${consumer}: several @OnMessage handlers for type "${type}" (${label(previous)} and ${label(handler)})`,
        location: handler.location,
        hints: ['A message type is handled by a single method: merge the handlers'],
        related: [{ message: `First handler of "${type}"`, location: previous.location }],
      })
      continue
    }
    if (!isPattern(type)) {
      exact.set(type, handler)
      continue
    }
    const covering = patterns.find(pattern => patternCovers(pattern.type, type))
    if (covering !== undefined) {
      ctx.report({
        code: INVALID_CONSUMER,
        severity: 'error',
        message: `@Consumer ${consumer}: the pattern "${type}" of ${label(handler)} never matches: every type it matches is matched first by "${covering.type}" (${label(covering)})`,
        location: handler.location,
        hints: ['Patterns are tried in declaration order (after exact types): declare the more specific pattern first'],
        related: [{ message: `Pattern "${covering.type}"`, location: covering.location }],
      })
    }
    patterns.push({ ...handler, type })
  }
}

// ------------------------------------------------------------------------------------------- members

/** Messaging methods declared by `cls` itself, by name, in declaration order. */
function analyzeMembers(cls: ClassInfo, ctx: Context): Map<string, MemberAnalysis> {
  const members = new Map<string, MemberAnalysis>()
  for (const method of cls.methods) {
    const member = analyzeMethod(cls, method, ctx)
    if (member !== undefined) members.set(method.name, member)
  }
  return members
}

function analyzeMethod(cls: ClassInfo, method: MethodInfo, ctx: Context): MemberAnalysis | undefined {
  const onMessage = decoratorsOf(method.decorators, MessagingDecorator.OnMessage)
  const retry = decoratorsOf(method.decorators, MessagingDecorator.Retry)
  const onError = decoratorsOf(method.decorators, MessagingDecorator.OnError)
  const decoratedParams = method.params.some(param => param.decorators.some(isParameterDecorator))
  if (onMessage.length === 0 && retry.length === 0 && onError.length === 0 && !decoratedParams) return undefined

  const where = `${cls.displayName}.${method.name}()`
  const primary = onMessage[0] ?? onError[0]
  if (primary !== undefined) checkMethodShape(method, primary, where, ctx)
  for (const duplicate of [...retry.slice(1), ...onError.slice(1)]) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@${duplicate.name} is applied several times on ${where}`,
      location: duplicate.location,
      hints: [`Keep a single @${duplicate.name}`],
    })
  }
  if (onMessage.length > 0 && onError[0] !== undefined) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `${where} cannot be both an @OnMessage handler and the @OnError method`,
      location: onError[0].location,
      hints: ['Declare the error handler in a separate method'],
    })
  }
  if (onMessage.length === 0 && retry[0] !== undefined) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@Retry has no effect on ${where}: it is not an @OnMessage handler`,
      location: retry[0].location,
      hints: ['Add @OnMessage() to the method, or remove @Retry'],
    })
  }

  let handlers: HandlerData[] = []
  if (onMessage.length > 0) {
    const policy: RetryPolicyData | undefined =
      retry[0] === undefined ? undefined : normalizeRetryDecorator(retry[0], where, ctx)
    const params = analyzeHandlerParams(method, where, ctx)
    handlers = onMessage.flatMap(decorator => {
      const type = messageType(decorator, where, ctx)
      if (type === false) return []
      return [
        Object.freeze({
          method: method.name,
          type,
          retry: policy,
          params,
          declaredBy: cls.displayName,
          location: decorator.location,
        }),
      ]
    })
  } else {
    reportStrayParameterDecorators(method, where, onError.length > 0, ctx)
  }

  const errorHandler = onMessage.length === 0 ? onError[0] : undefined
  if (errorHandler !== undefined) checkErrorHandler(method, errorHandler, where, ctx)
  return {
    method: method.name,
    declaredBy: cls.displayName,
    onMessage: onMessage.length,
    handlers,
    errorHandler: errorHandler?.location,
  }
}

/** Handlers are called by the generated code: `consumer.method(...)`. */
function checkMethodShape(method: MethodInfo, decorator: DecoratorInfo, where: string, ctx: Context): void {
  const name = `@${decorator.name}`
  let problem: { message: string; hint: string } | undefined
  if (method.kind !== 'method') {
    problem = { message: `${name} cannot be applied to the accessor ${where}`, hint: 'Use a regular method' }
  } else if (method.static) {
    problem = {
      message: `${name} cannot be applied to the static method ${where}`,
      hint: 'Handlers are called on the consumer instance: remove `static`',
    }
  } else if (method.privateName) {
    problem = {
      message: `${name} cannot be applied to the #private method ${where}`,
      hint: 'Use a public method: the generated code calls it',
    }
  } else if (method.visibility !== 'public') {
    problem = {
      message: `${where} must be public: ${name} methods are called by the generated code`,
      hint: `Remove the '${method.visibility}' modifier`,
    }
  } else if (method.computed) {
    problem = {
      message: `${name} cannot be applied to ${where}: computed method names are not supported`,
      hint: 'Use a plain method name',
    }
  } else if (method.generator) {
    problem = {
      message: `${name} cannot be applied to the generator method ${where}`,
      hint: 'Use a regular (or async) method',
    }
  }
  if (problem !== undefined) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: problem.message,
      location: decorator.location,
      hints: [problem.hint],
    })
  }
}

/** Type of an `@OnMessage` decorator: a string, `undefined` (default handler) or `false` (invalid). */
function messageType(decorator: DecoratorInfo, where: string, ctx: Context): string | undefined | false {
  const arg = decorator.args[0]
  if (arg === undefined || (arg.evaluated && arg.value === undefined)) return undefined
  if (!arg.evaluated) return false // not statically evaluable: already reported
  if (typeof arg.value !== 'string') {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@OnMessage on ${where} expects a message type (a string), got ${describeValue(arg.value)}`,
      location: arg.location,
      hints: ['Use @OnMessage() for the default handler'],
    })
    return false
  }
  if (arg.value === '') {
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `The @OnMessage type of ${where} must be a non-empty string`,
      location: arg.location,
      hints: ['Use @OnMessage() for the default handler'],
    })
    return false
  }
  return arg.value
}

/** The `@OnError` method is called as `consumer[method](error, message)`. */
function checkErrorHandler(method: MethodInfo, decorator: DecoratorInfo, where: string, ctx: Context): void {
  const required = method.params.filter(param => !param.optional && !param.hasDefault && !param.rest).length
  if (required > 2) {
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `The @OnError method ${where} has ${required} required parameters: it is called with (error, message)`,
      location: method.location,
      hints: ['Declare onError(error: unknown, message: InboundMessage)'],
    })
  }
  if (method.returnType !== undefined && !isErrorHandlerResult(ctx.types.awaited(method.returnType))) {
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `The @OnError method ${where} returns '${ctx.types.format(method.returnType)}': return 'ack' to acknowledge the message, or nothing to dead-letter it`,
      location: decorator.location,
      hints: ["Declare the return type `'ack' | undefined` (or `void`)"],
    })
  }
}

// ---------------------------------------------------------------------------------------- parameters

function analyzeHandlerParams(method: MethodInfo, where: string, ctx: Context): readonly HandlerParamData[] {
  return Object.freeze(method.params.map(param => analyzeHandlerParam(param, where, ctx)))
}

function analyzeHandlerParam(param: ParameterInfo, where: string, ctx: Context): HandlerParamData {
  const decorators = parameterDecorators(param)
  const decorator = decorators[0]
  if (decorator === undefined) {
    if (param.optional || param.hasDefault || param.rest) return { kind: 'undefined' }
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `Parameter '${param.name}' of ${where} has no @Message(), @Headers() or @Ctx() decorator`,
      location: param.location,
      hints: [
        'Every handler parameter is extracted from the message: @Message(schema?) for the payload, @Headers(name?) for the headers, @Ctx() for the InboundMessage',
      ],
    })
    return { kind: 'undefined' }
  }
  if (decorators.length > 1) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `Parameter '${param.name}' of ${where} has several messaging decorators (${decorators.map(found => `@${found.name}`).join(', ')})`,
      location: (decorators[1] as DecoratorInfo).location,
      hints: ['Keep a single one'],
    })
  }
  if (param.rest) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@${decorator.name} cannot be applied to the rest parameter '...${param.name}' of ${where}`,
      location: decorator.location,
    })
    return { kind: 'undefined' }
  }
  switch (decorator.identity) {
    case MessagingDecorator.Message:
      return messageParam(param, decorator, where, ctx)
    case MessagingDecorator.Headers:
      return headersParam(param, decorator, where, ctx)
    default:
      return { kind: 'message', narrow: narrowsPayload(param.type, ctx.types) }
  }
}

/** `@Message()` / `@Message(schema)`. */
function messageParam(param: ParameterInfo, decorator: DecoratorInfo, where: string, ctx: Context): HandlerParamData {
  const arg = decorator.args[0]
  if (arg === undefined || (arg.evaluated && arg.value === undefined)) {
    checkUnvalidated(param, decorator, where, ctx)
    return { kind: 'payload' }
  }
  if (arg.ref !== undefined) {
    if (isClassReference(arg.ref)) {
      ctx.report({
        code: INVALID_DECORATOR,
        severity: 'error',
        message: `@Message(${arg.text}) on ${where}: '${arg.ref.name}' is a class, not a Standard Schema`,
        location: arg.location,
        hints: [
          'Pass a Standard Schema (Zod, Valibot, ArkType...): export const OrderPlaced = z.object({ ... })',
          'Or inject the raw payload with @Message() and validate it in the handler',
        ],
      })
      return { kind: 'undefined' }
    }
    return { kind: 'validated', schema: arg.ref }
  }
  if (!arg.evaluated) return { kind: 'undefined' } // unexported or invalid reference: already reported
  ctx.report({
    code: INVALID_DECORATOR,
    severity: 'error',
    message: `@Message on ${where} expects a Standard Schema (Zod, Valibot, ArkType...), got ${describeValue(arg.value)}`,
    location: arg.location,
    hints: [
      'Declare the schema with `export const OrderPlaced = z.object({ ... })` and pass it: @Message(OrderPlaced)',
    ],
  })
  return { kind: 'undefined' }
}

/** `@Headers()` / `@Headers(name)`. */
function headersParam(param: ParameterInfo, decorator: DecoratorInfo, where: string, ctx: Context): HandlerParamData {
  const arg = decorator.args[0]
  if (arg === undefined || (arg.evaluated && arg.value === undefined)) return { kind: 'headers' }
  if (!arg.evaluated) return { kind: 'undefined' } // not statically evaluable: already reported
  const name = arg.value
  if (typeof name !== 'string' || name === '') {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@Headers on ${where} expects a header name (a non-empty string), got ${describeValue(name)}`,
      location: arg.location,
      hints: ['Use @Headers() to inject every header'],
    })
    return { kind: 'undefined' }
  }
  if (!param.optional && !param.hasDefault && !acceptsUndefined(param.type)) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'warning',
      message: `@Headers(${JSON.stringify(name)}) injects 'string | undefined' (the header may be missing) but parameter '${param.name}' of ${where} is typed '${ctx.types.format(param.type)}'`,
      location: param.typeLocation,
      hints: [`Declare it '${param.name}?: string' or '${param.name}: string | undefined', or give it a default value`],
    })
  }
  return { kind: 'header', name }
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
    code: UNVALIDATED_INPUT,
    severity: ctx.options.strictValidation ? 'error' : 'warning',
    message: `Unvalidated message payload: parameter '${param.name}' of ${where} ${typed} but @Message() has no schema`,
    location: decorator.location,
    hints: [
      'Validate it with a Standard Schema (Zod, Valibot, ArkType...): @Message(OrderPlaced)',
      "Or declare the parameter as 'unknown' and check it in the handler",
    ],
  })
}

/** Methods whose parameters carry messaging decorators without being `@OnMessage` handlers. */
function reportStrayParameterDecorators(method: MethodInfo, where: string, errorHandler: boolean, ctx: Context): void {
  for (const param of method.params) {
    for (const decorator of parameterDecorators(param)) {
      ctx.report({
        code: INVALID_DECORATOR,
        severity: 'error',
        message: `@${decorator.name} has no effect on parameter '${param.name}' of ${where}: it is not an @OnMessage handler`,
        location: decorator.location,
        hints: errorHandler
          ? ['@OnError methods are called with (error, message): remove the decorator']
          : ['Add @OnMessage() to the method, or remove the decorator'],
      })
    }
  }
}

// ------------------------------------------------------------------------------------------- helpers

function decoratorsOf(decorators: readonly DecoratorInfo[], identity: string): DecoratorInfo[] {
  return decorators.filter(decorator => decorator.identity === identity)
}

/**
 * Messaging decorators of a parameter. De-duplicated by position: the compiler (0.1) reports the
 * decorators of a parameter with a default value (`@Headers('x') x = 'a'`) twice.
 */
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

/** A reference to a class declaration (`@Message(OrderDto)`). */
function isClassReference(ref: ValueRef): boolean {
  const symbol = ref.symbol
  return symbol.kind === 'declaration' && symbol.declaration.kind === 'class'
}

/** Primitive and binary payload types need no schema (`unknown` is honest, `any` is not). */
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

/** Whether `undefined` is assignable to the type (unknown types are given the benefit of the doubt). */
function acceptsUndefined(type: TypeInfo): boolean {
  switch (type.kind) {
    case 'primitive':
      return type.name === 'any' || type.name === 'unknown' || type.name === 'undefined' || type.name === 'void'
    case 'union':
      return type.types.some(acceptsUndefined)
    case 'opaque':
    case 'typeParameter':
      return true
    default:
      return false
  }
}

/** Valid results of an `@OnError` method: `'ack'`, nothing (`void`, `undefined`), or unknown types. */
function isErrorHandlerResult(type: TypeInfo): boolean {
  switch (type.kind) {
    case 'primitive':
      return ['void', 'undefined', 'any', 'unknown', 'never'].includes(type.name)
    case 'literal':
      return type.value === 'ack'
    case 'union':
      return type.types.every(isErrorHandlerResult)
    case 'promise':
      return isErrorHandlerResult(type.inner)
    case 'opaque':
    case 'typeParameter':
      return true
    default:
      return false
  }
}

/** `@Ctx() message: InboundMessage<Order>` narrows the payload: the invoker casts `m`. */
function narrowsPayload(type: TypeInfo, types: TypeHelpers): boolean {
  const { type: inner } = types.stripNullish(type)
  if (inner.kind !== 'reference' || inner.identity !== INBOUND_MESSAGE_IDENTITY) return false
  const payload = inner.typeArgs[0]
  return (
    payload !== undefined && !(payload.kind === 'primitive' && (payload.name === 'unknown' || payload.name === 'any'))
  )
}
