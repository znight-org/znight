/**
 * `analyzeClass` of the events extension (RFC 0011 §5.4, §6): reads the `@OnEvent` methods of a
 * class, validates their shape (ZNIGHT005), options and parameter (ZNIGHT070), reads the listened
 * classes from the parameter type, declares a concrete host as a root (`addRoot`: a singleton
 * provider when nothing else registers it) and stores one {@link ListenerData} per listened class.
 * Listeners of an abstract class are stored without root: its concrete providers inherit them
 * (`generate`).
 */
import type {
  AnalyzeContext,
  ClassInfo,
  DecoratorInfo,
  Location,
  MethodInfo,
  ParameterInfo,
  ReferenceType,
  StaticValue,
  TypeInfo,
} from '@znight/compiler'
import type { EventsData, ListenerData } from './data.ts'

import { INVALID_DECORATOR, INVALID_LISTENER, NEST_OPTIONS, ON_EVENT, OPTION_KEYS, ROOT_REASON } from './constants.ts'
import { closest, describeValue, isRecord, propertyLocation } from './values.ts'

type Context = AnalyzeContext<EventsData>

/** Analyses a class carrying at least one `@OnEvent`. */
export function analyzeEventsClass(cls: ClassInfo, ctx: Context): void {
  const methods = cls.methods.filter(method => method.decorators.some(isOnEvent))
  const first = methods[0]?.decorators.find(isOnEvent)
  if (first === undefined) return
  if (cls.typeParameters.length > 0) {
    for (const method of methods) {
      for (const decorator of method.decorators.filter(isOnEvent)) {
        ctx.report({
          code: INVALID_DECORATOR,
          severity: 'error',
          message: `@OnEvent cannot be applied to the generic class ${cls.displayName}<${cls.typeParameters.join(', ')}>`,
          location: decorator.location,
          hints: ['Listeners run on a provider: remove the type parameters of the host'],
        })
      }
    }
    return
  }

  const listeners: ListenerData[] = []
  for (const method of methods) {
    const own = method.decorators.filter(isOnEvent)
    const decorator = own[0] as DecoratorInfo
    const where = `${cls.displayName}.${method.name}()`
    for (const extra of own.slice(1)) {
      ctx.report({
        code: INVALID_LISTENER,
        severity: 'error',
        message: `@OnEvent is applied twice to ${where}`,
        location: extra.location,
        hints: ['Listen to several events with one @OnEvent and a union: handle(event: A | B)'],
      })
    }
    if (!checkMethodShape(method, decorator, where, ctx)) continue
    if (!decorator.called) continue // `@OnEvent` without call: reported by the compiler
    const options = readOptions(decorator, where, ctx)
    const events = readEvents(method, where, ctx)
    if (options === undefined || events === undefined) continue
    for (const event of events) {
      listeners.push({
        kind: 'listener',
        host: cls,
        method: method.name,
        event,
        order: options.order,
        detached: options.detached,
        location: decorator.location,
      })
    }
  }
  if (listeners.length === 0) return
  // the host is an entry point of the plugin: a root of ZNIGHT019 and prune, a singleton when
  // nothing else registers it; an abstract class is never instantiated: its subclasses inherit
  if (!cls.abstract) ctx.addRoot(cls, { reason: ROOT_REASON, location: first.location })
  for (const listener of listeners) ctx.store(listener)
}

function isOnEvent(decorator: DecoratorInfo): boolean {
  return decorator.identity === ON_EVENT
}

// ------------------------------------------------------------------------------------------ method

/** Listeners are called by the generated code: `host.method(event)`. */
function checkMethodShape(method: MethodInfo, decorator: DecoratorInfo, where: string, ctx: Context): boolean {
  let problem: { message: string; hint: string } | undefined
  if (method.kind !== 'method') {
    problem = { message: `@OnEvent cannot be applied to the accessor ${where}`, hint: 'Use a regular method' }
  } else if (method.static) {
    problem = {
      message: `@OnEvent cannot be applied to the static method ${where}`,
      hint: 'Listeners are called on the host instance: remove `static`',
    }
  } else if (method.privateName) {
    problem = {
      message: `@OnEvent cannot be applied to the #private method ${where}`,
      hint: 'Use a public method: the generated code calls it',
    }
  } else if (method.visibility !== 'public') {
    problem = {
      message: `${where} must be public: @OnEvent methods are called by the generated code`,
      hint: `Remove the '${method.visibility}' modifier`,
    }
  } else if (method.computed) {
    problem = {
      message: `@OnEvent cannot be applied to ${where}: computed method names are not supported`,
      hint: 'Use a plain method name',
    }
  } else if (method.generator) {
    problem = {
      message: `@OnEvent cannot be applied to the generator method ${where}`,
      hint: 'Use a regular (or async) method',
    }
  } else if (method.typeParameters.length > 0) {
    problem = {
      message: `@OnEvent cannot be applied to the generic method ${where}`,
      hint: 'Type the parameter with the event class, without type parameters',
    }
  }
  if (problem === undefined) return true
  ctx.report({
    code: INVALID_DECORATOR,
    severity: 'error',
    message: problem.message,
    location: decorator.location,
    hints: [problem.hint],
  })
  return false
}

// ----------------------------------------------------------------------------------------- options

interface ListenerOptions {
  readonly order: number
  readonly detached: boolean
}

const DEFAULT_OPTIONS: ListenerOptions = { order: 0, detached: false }

/** The options object: known keys, typed values; `undefined` when invalid (reported). */
function readOptions(decorator: DecoratorInfo, where: string, ctx: Context): ListenerOptions | undefined {
  const arg = decorator.args[0]
  if (arg === undefined) return DEFAULT_OPTIONS
  if (!arg.evaluated) return undefined // not statically evaluable: reported by the compiler
  const value = arg.value
  if (value === undefined) return DEFAULT_OPTIONS
  if (typeof value === 'string') {
    ctx.report({
      code: INVALID_LISTENER,
      severity: 'error',
      message: `@OnEvent(${JSON.stringify(value)}) on ${where}: events are classes, not names`,
      location: arg.location,
      hints: [
        'Remove the name and type the parameter with the event class: @OnEvent() handle(event: OrderCreated)',
        'A wildcard (order.*) becomes a base class listened to by the listener (OrderCreated extends OrderEvent)',
      ],
    })
    return undefined
  }
  if (!isRecord(value)) {
    ctx.report({
      code: INVALID_LISTENER,
      severity: 'error',
      message: `@OnEvent options must be an object literal, got ${describeValue(value)}`,
      location: arg.location,
      hints: ['@OnEvent({ detached: true, order: -10 })'],
    })
    return undefined
  }
  const record: Readonly<Record<string, StaticValue>> = value
  let valid = true
  const fail = (key: string, message: string, hints: readonly string[]): void => {
    valid = false
    ctx.report({
      code: INVALID_LISTENER,
      severity: 'error',
      message: `@OnEvent on ${where}: ${message}`,
      location: propertyLocation(ctx.project, arg, key),
      hints,
    })
  }
  for (const key of Object.keys(record)) {
    if (OPTION_KEYS.includes(key)) continue
    const nest = NEST_OPTIONS.get(key)
    if (nest !== undefined) {
      fail(key, `unknown option '${key}' (an option of @nestjs/event-emitter)`, [nest])
    } else if (key === 'phase') {
      fail(key, "unknown option 'phase': transaction phases are not supported yet", [
        'Publish after the transaction committed, or buffer the events until the commit (see the application events guide)',
      ])
    } else {
      const suggestion = closest(key, OPTION_KEYS)
      fail(key, `unknown option '${key}'${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`, [
        `Options of @OnEvent: ${OPTION_KEYS.join(', ')}`,
      ])
    }
  }
  const order = record['order'] ?? 0
  if (typeof order !== 'number' || !Number.isSafeInteger(order)) {
    fail('order', `'order' must be an integer, got ${describeValue(order)}`, [
      'Lower orders run first; the default is 0',
    ])
  }
  const detached = record['detached'] ?? false
  if (typeof detached !== 'boolean') {
    fail('detached', `'detached' must be a boolean, got ${describeValue(detached)}`, [
      '@OnEvent({ detached: true }) runs the listener after the publication',
    ])
  }
  if (!valid) return undefined
  return { order: Object.is(order, -0) ? 0 : (order as number), detached: detached as boolean }
}

// ------------------------------------------------------------------------------------------ events

/** The listened classes, from the type of the only parameter; `undefined` when invalid (reported). */
function readEvents(method: MethodInfo, where: string, ctx: Context): ClassInfo[] | undefined {
  const params = method.params
  const fail = (location: Location, message: string, hints: readonly string[]): undefined => {
    ctx.report({ code: INVALID_LISTENER, severity: 'error', message, location, hints })
    return undefined
  }
  const param = params[0]
  if (param === undefined || params.length > 1) {
    return fail(
      (params[1] as ParameterInfo | undefined)?.location ?? method.location,
      `${where} takes ${params.length === 0 ? 'no parameter' : `${params.length} parameters`}: an @OnEvent method takes exactly one, the event`,
      ['handle(event: UserCreated): the type of the parameter is the event the method listens to'],
    )
  }
  if (param.rest) {
    return fail(param.location, `The parameter of ${where} cannot be a rest parameter`, [
      'handle(event: UserCreated): one parameter typed with the event class',
    ])
  }
  const decorator = param.decorators[0]
  if (decorator !== undefined) {
    return fail(
      decorator.location,
      `@${decorator.name} cannot be applied to the parameter of ${where}: an @OnEvent method only receives its event`,
      ['Remove the parameter decorator'],
    )
  }
  if (param.optional || param.hasDefault) {
    return fail(param.location, `The event parameter of ${where} cannot be optional: an event is never absent`, [
      `Remove the ${param.optional ? "'?'" : 'default value'}`,
    ])
  }
  const { type, nullable } = ctx.types.stripNullish(param.type)
  if (nullable) {
    return fail(
      param.typeLocation,
      `The event parameter of ${where} cannot be nullable (${ctx.types.format(param.type)}): an event is never absent`,
      [`Type it ${ctx.types.format(type)}`],
    )
  }
  const members = type.kind === 'union' ? type.types : [type]
  const classes: ClassInfo[] = []
  let valid = true
  for (const member of members) {
    const cls = eventClassOf(member, param, where, ctx)
    if (cls === undefined) valid = false
    else if (!classes.some(other => other.identity === cls.identity)) classes.push(cls)
  }
  if (!valid) return undefined
  return withoutOverlaps(classes, param, where, ctx)
}

/** The class a member of the parameter type names, or `undefined` (reported). */
function eventClassOf(member: TypeInfo, param: ParameterInfo, where: string, ctx: Context): ClassInfo | undefined {
  const fail = (message: string, hints: readonly string[]): undefined => {
    ctx.report({ code: INVALID_LISTENER, severity: 'error', message, location: param.typeLocation, hints })
    return undefined
  }
  const written = ctx.types.format(member)
  if (member.kind !== 'reference') {
    if (member.kind === 'opaque' && member.reason === 'missing-annotation') {
      return fail(`The event parameter of ${where} has no type annotation: the type names the event`, [
        `${param.name}: UserCreated, where UserCreated is the event class`,
      ])
    }
    const what =
      member.kind === 'opaque' && member.reason === 'object-literal' ? 'an inline object type' : `'${written}'`
    return fail(`${where} listens to ${what}, which is not a class: listeners are matched on the class of the event`, [
      'Listen to a class (or a union of classes, or a base class): handle(event: UserCreated)',
    ])
  }
  const cls = ctx.classInfo(member.identity)
  if (cls === undefined) {
    return fail(`${where} listens to ${member.name}, which is not a class: nothing at runtime identifies it`, [
      `Listen to a class: declare \`export class ${member.name} { ... }\` (an interface or a type alias cannot be matched)`,
    ])
  }
  if (member.typeArgs.length > 0 && writesTypeArguments(member, param, ctx)) {
    return fail(`${where} listens to ${written}: type arguments are erased at runtime`, [
      `Listen to ${member.name}, or declare a class for this case (class UserCreated extends ${written} {})`,
    ])
  }
  if (cls.importRoute === undefined) {
    const reason = cls.importError?.message
    return fail(
      `${where} listens to ${cls.displayName}, which the generated module cannot import${reason === undefined ? '' : `: ${reason}`}`,
      [`Export the event class (export class ${cls.name} ...)`],
    )
  }
  return cls
}

/** `true` when the annotation writes type arguments for `member` (`EntityCreated<User>`, not a default). */
function writesTypeArguments(member: ReferenceType, param: ParameterInfo, ctx: Context): boolean {
  const location = param.typeLocation
  const text = ctx.project.getFile(location.file)?.text.slice(location.start, location.end)
  if (text === undefined) return true
  return new RegExp(`(^|[^\\w$])${member.name.replace(/[$]/g, '\\$')}\\s*<`).test(text)
}

/**
 * A union whose members extend one another (`A | Base` with `A extends Base`): the base already
 * receives the subclass, so the subclass is dropped, with a warning.
 */
function withoutOverlaps(
  classes: readonly ClassInfo[],
  param: ParameterInfo,
  where: string,
  ctx: Context,
): ClassInfo[] {
  const kept: ClassInfo[] = []
  for (const cls of classes) {
    const base = classes.find(
      other => other !== cls && cls.heritage.some(reference => reference.identity === other.identity),
    )
    if (base === undefined) {
      kept.push(cls)
      continue
    }
    ctx.report({
      code: INVALID_LISTENER,
      severity: 'warning',
      message: `${where} listens to ${cls.displayName} and to its base class ${base.displayName}: it is called once per event`,
      location: param.typeLocation,
      hints: [`Remove ${cls.displayName} from the union: listening to ${base.displayName} covers it`],
    })
  }
  return kept
}
