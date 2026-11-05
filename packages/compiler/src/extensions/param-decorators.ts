/**
 * Custom parameter decorators (RFC 0010): the definitions (`export const CurrentUser =
 * createParamDecorator<User>({ http: ... })`), the uses read by the transport extensions through
 * `AnalyzeContext.paramDecorator`, and the uses no extension claimed.
 *
 * Every problem is a ZNIGHT005 located on the use, the definition related. Nothing is computed for a
 * project without definitions.
 */
import type { Expression, ObjectExpression, SpreadElement } from 'oxc-parser'
import type { Reporter } from '../analysis/arguments.ts'
import type { Diagnostic, Location, Project, ScopeRef, TypeInfo, ValueRef } from '../project/index.ts'
import type {
  AnalyzeContext,
  ArgInfo,
  ClassInfo,
  DecoratorInfo,
  DefinitionInfo,
  ParamDecoratorResolver,
  ParamDecoratorUse,
  ParameterInfo,
  TypeHelpers,
} from './api.ts'
import type { DefinitionIndex } from './definitions.ts'

import { ErrorCode } from '@znight/core'

import { evaluateArgument } from '../analysis/arguments.ts'
import { unionType } from '../project/index.ts'

/** Canonical identity of the factory. */
export const CREATE_PARAM_DECORATOR = '@znight/core#createParamDecorator'

/** `const` aliases followed from a resolver reference to the function or class. */
const MAX_ALIAS_HOPS = 8

/** A resolver entry of a definition, before binding. */
type ResolverEntry =
  | { readonly kind: 'function'; readonly async: boolean }
  | { readonly kind: 'class'; readonly ref: ValueRef }

/** A definition, parsed once. */
interface ParsedDefinition {
  readonly info: DefinitionInfo
  /** Why the definition cannot be used (shape errors); `undefined` when valid. */
  readonly problem:
    | { readonly message: string; readonly hints: readonly string[]; readonly location: Location }
    | undefined
  readonly valueType: TypeInfo | undefined
  /** Resolvers by transport key. */
  readonly resolvers: ReadonlyMap<string, ResolverEntry>
}

/** The custom parameter decorators of one compile. */
export class ParamDecoratorIndex {
  readonly #project: Project
  readonly #definitions: DefinitionIndex
  readonly #types: TypeHelpers
  readonly #report: Reporter
  #byIdentity: Map<string, DefinitionInfo> | undefined
  readonly #parsed = new Map<string, ParsedDefinition>()
  /** Uses claimed by an extension. */
  readonly #claimed = new Set<DecoratorInfo>()

  constructor(project: Project, definitions: DefinitionIndex, types: TypeHelpers, report: Reporter) {
    this.#project = project
    this.#definitions = definitions
    this.#types = types
    this.#report = report
  }

  /** Definitions by identity (empty for most projects). */
  #all(): ReadonlyMap<string, DefinitionInfo> {
    this.#byIdentity ??= new Map(
      this.#definitions.definitionsOf(CREATE_PARAM_DECORATOR).map(definition => [definition.identity, definition]),
    )
    return this.#byIdentity
  }

  /** `true` when the decorator is a use of a custom parameter decorator. */
  isUse(decorator: DecoratorInfo): boolean {
    return decorator.identity !== undefined && decorator.owner === undefined && this.#all().has(decorator.identity)
  }

  /** {@link AnalyzeContext.paramDecorator}. */
  use(
    param: ParameterInfo,
    transport: string,
    from: ClassInfo,
    ctx: Pick<AnalyzeContext, 'resolveClassRef' | 'classInfo'>,
  ): ParamDecoratorUse | undefined {
    if (this.#all().size === 0) {
      return undefined
    }
    const decorator = param.decorators.find(candidate => this.isUse(candidate))
    if (decorator === undefined) {
      return undefined
    }
    this.#claimed.add(decorator)
    const failed: ParamDecoratorUse = Object.freeze({ ok: false, decorator })
    const definition = this.#parse(decorator.identity as string)
    const name = definition.info.displayName
    const method = from.methods.find(candidate => candidate.params.includes(param))
    const where = `parameter '${param.name}' of ${from.displayName}.${method?.name ?? '?'}()`
    const related = [{ message: `@${name} is defined here`, location: definition.info.location }]
    const error = (message: string, hints: readonly string[], location = decorator.location): ParamDecoratorUse => {
      this.#error(message, hints, location, related)
      return failed
    }
    if (definition.problem) {
      return error(`@${name} cannot be used: ${definition.problem.message}`, definition.problem.hints)
    }
    if (!decorator.called) {
      return error(`@${name} must be called: @${name}()`, [`Write @${name}()`])
    }
    if (param.rest) {
      return error(`@${name} cannot decorate the rest ${where}`, ['Declare a regular parameter'])
    }
    const entry = definition.resolvers.get(transport)
    if (entry === undefined) {
      return error(`@${name} has no '${transport}' resolver: it cannot be used on ${where}`, [
        `Add a ${transport} resolver to the definition: createParamDecorator<${this.#format(definition.valueType)}>({ ..., ${transport}: ctx => ... })`,
      ])
    }
    // data argument (a `value` argument, §4.6)
    const call = decorator.node.expression
    const args = call.type === 'CallExpression' ? call.arguments : []
    if (args.length > 1) {
      return error(`@${name} takes at most one argument (its data)`, ['Pass a single value (an object or an array)'])
    }
    let data: ArgInfo | undefined
    const first = args[0]
    if (first !== undefined) {
      if (first.type === 'SpreadElement') {
        return error(`@${name} does not accept spread arguments`, ['Pass the value directly'])
      }
      const file = this.#project.getFile(from.file)
      if (file === undefined) {
        return failed
      }
      const scope: ScopeRef = { file, namespace: from.declaration.namespace }
      data = evaluateArgument(this.#project, scope, first, 'value', `data argument of @${name}`, this.#report)
      if (data.error !== undefined) {
        return failed
      }
    }
    // resolver
    let resolver: ParamDecoratorResolver
    if (entry.kind === 'class') {
      const ref = ctx.resolveClassRef(entry.ref, { from, role: 'parameter resolver', lazy: true })
      if (ref === undefined) {
        return failed
      }
      const resolve = ctx.classInfo(ref.identity)?.methods.find(member => member.name === 'resolve' && !member.static)
      resolver = Object.freeze({ kind: 'class', ref, async: resolve?.async === true, arity: resolve?.params.length })
    } else {
      resolver = Object.freeze({ kind: 'function', async: entry.async })
    }
    // value type (§4.5, rule 7)
    const valueType = definition.valueType as TypeInfo
    const accepted = param.optional || param.hasDefault ? withoutUndefined(valueType) : valueType
    const verdict = this.#types.assignable(accepted, { parameter: param })
    if (verdict === false) {
      const declared = this.#types.format(param.type)
      const injected = this.#types.format(valueType)
      const nullability =
        !param.optional && this.#types.assignable(withoutUndefined(valueType), { parameter: param }) === true
      return error(`@${name}() injects ${injected}, which ${where} does not accept (${declared})`, [
        nullability
          ? `Declare the parameter as optional (${param.name}?: ${declared}), or make the decorator inject ${declared}`
          : `Declare the parameter as ${injected}, or use a decorator that injects ${declared}`,
      ])
    }
    return Object.freeze({
      ok: true,
      decorator,
      identity: definition.info.identity,
      name: definition.info.name,
      valueType,
      data,
      resolver,
      cast: verdict === undefined,
      location: decorator.location,
    })
  }

  /** Reports every use no extension claimed (§4.5, rule 3). Call once, after the extensions. */
  reportUnclaimed(classes: Iterable<ClassInfo>): void {
    if (this.#all().size === 0) {
      return
    }
    for (const cls of classes) {
      const visit = (decorators: readonly DecoratorInfo[], what: string): void => {
        for (const decorator of decorators) {
          if (!this.isUse(decorator) || this.#claimed.has(decorator)) {
            continue
          }
          const definition = this.#parse(decorator.identity as string)
          const name = definition.info.displayName
          this.#error(
            `@${name} cannot be used on ${what}: a custom parameter decorator decorates a parameter of a handler (a route of a @Controller, a field of a @Resolver, a message handler of a @Consumer)`,
            [
              decorator.target === 'constructorParameter'
                ? 'Inject a provider in the constructor instead, or move the parameter to a handler'
                : 'Move it to a handler parameter',
            ],
            decorator.location,
            [{ message: `@${name} is defined here`, location: definition.info.location }],
          )
        }
      }
      visit(cls.decorators, `class ${cls.displayName}`)
      if (cls.ctor.declaredBy === cls.identity) {
        for (const param of cls.ctor.params) {
          visit(param.decorators, `constructor parameter '${param.name}' of ${cls.displayName}`)
        }
      }
      for (const method of cls.methods) {
        visit(method.decorators, `method ${cls.displayName}.${method.name}()`)
        for (const param of method.params) {
          visit(param.decorators, `parameter '${param.name}' of ${cls.displayName}.${method.name}()`)
        }
      }
      for (const property of cls.properties) {
        visit(property.decorators, `property ${cls.displayName}.${property.name}`)
      }
    }
  }

  #parse(identity: string): ParsedDefinition {
    let parsed = this.#parsed.get(identity)
    if (parsed === undefined) {
      parsed = this.#parseDefinition(this.#all().get(identity) as DefinitionInfo)
      this.#parsed.set(identity, parsed)
    }
    return parsed
  }

  #parseDefinition(info: DefinitionInfo): ParsedDefinition {
    const resolvers = new Map<string, ResolverEntry>()
    const invalid = (message: string, hints: readonly string[], location = info.call): ParsedDefinition => ({
      info,
      problem: { message, hints, location },
      valueType: undefined,
      resolvers,
    })
    if (!info.exported) {
      return invalid(
        `${info.displayName} is not exported, and the generated module imports it`,
        [`Export it: export const ${info.name} = createParamDecorator<...>({ ... })`],
        info.location,
      )
    }
    const valueType = info.typeArgs[0]
    if (valueType === undefined) {
      return invalid(`the definition of ${info.displayName} has no type argument`, [
        'Give the injected type: createParamDecorator<User>({ ... })',
      ])
    }
    const arg = info.args[0]
    const object = arg === undefined ? undefined : unwrap(arg.node)
    if (object?.type !== 'ObjectExpression' || info.args.length > 1) {
      return invalid('the argument of createParamDecorator must be an object literal of resolvers', [
        'Write createParamDecorator<T>({ http: ctx => ..., graphql: ctx => ... })',
      ])
    }
    const file = this.#project.getFile(info.file)
    const symbol = this.#project.lookupIdentity(info.identity)
    const namespace = symbol.kind === 'declaration' ? symbol.declarations[0]?.namespace : undefined
    if (file === undefined) {
      return invalid('its file cannot be read', [])
    }
    const scope: ScopeRef = { file, namespace }
    for (const property of object.properties) {
      const key = property.type === 'Property' ? propertyKey(property) : undefined
      if (property.type !== 'Property' || key === undefined) {
        return invalid(
          'the resolvers object must only have plain keys (no spread, no computed key)',
          ['Write each transport key: { http: ..., graphql: ... }'],
          file.location(property),
        )
      }
      const value = unwrap(property.value as Expression)
      if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
        resolvers.set(key, { kind: 'function', async: value.async })
        continue
      }
      const entry = this.#reference(scope, value)
      if (entry === undefined) {
        return invalid(
          `the '${key}' resolver must be an inline function, or a reference to a function or a provider class`,
          ['Write an arrow function (ctx => ...), or reference an exported function or class'],
          file.location(value),
        )
      }
      resolvers.set(key, entry)
    }
    return { info, problem: undefined, valueType, resolvers }
  }

  /**
   * A reference to a function or a class, `undefined` for anything else (or anything the compiler
   * cannot classify, such as an export of an untyped package). `const` aliases are followed
   * (`const R = UserResolver`).
   */
  #reference(scope: ScopeRef, value: Expression, hops = 0): ResolverEntry | undefined {
    if (hops > MAX_ALIAS_HOPS || (value.type !== 'Identifier' && value.type !== 'MemberExpression')) {
      return undefined
    }
    const evaluation = this.#project.evaluate(scope, value, { refs: 'nested' })
    if (evaluation.kind !== 'ref') {
      return undefined
    }
    const symbol = evaluation.ref.symbol
    if (symbol.kind === 'expression') {
      // `export default (class { ... })`, `export default (ctx => ...)`
      const file = this.#project.getFile(symbol.file)
      const expression = unwrap(symbol.expression)
      if (expression.type === 'ClassExpression') {
        return { kind: 'class', ref: evaluation.ref }
      }
      return file === undefined ? undefined : this.#aliased({ file, namespace: undefined }, expression, hops)
    }
    if (symbol.kind !== 'declaration') {
      return undefined
    }
    if (symbol.declarations.some(declaration => declaration.kind === 'class')) {
      return { kind: 'class', ref: evaluation.ref }
    }
    const declaration = symbol.declaration
    if (declaration.kind === 'function') {
      return { kind: 'function', async: (declaration.node as { async?: boolean }).async === true }
    }
    if (declaration.kind !== 'const' && declaration.kind !== 'let' && declaration.kind !== 'var') {
      return undefined
    }
    const node = declaration.node as {
      init?: Expression | null
      id?: { typeAnnotation?: { typeAnnotation?: { type: string } } | null }
    }
    if (!node.init) {
      // `declare const resolve: (ctx: HttpContext) => User`
      return node.id?.typeAnnotation?.typeAnnotation?.type === 'TSFunctionType'
        ? { kind: 'function', async: false }
        : undefined
    }
    const file = this.#project.getFile(declaration.file)
    return file === undefined
      ? undefined
      : this.#aliased({ file, namespace: declaration.namespace }, unwrap(node.init), hops)
  }

  /** The initializer of a binding: an inline function, or another reference (an alias). */
  #aliased(scope: ScopeRef, init: Expression, hops: number): ResolverEntry | undefined {
    if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
      return { kind: 'function', async: init.async }
    }
    return this.#reference(scope, init, hops + 1)
  }

  #format(type: TypeInfo | undefined): string {
    return type === undefined ? 'T' : this.#types.format(type)
  }

  #error(
    message: string,
    hints: readonly string[],
    location: Location,
    related: NonNullable<Diagnostic['related']>,
  ): void {
    this.#report({ code: ErrorCode.InvalidDecorator, severity: 'error', message, location, hints, related })
  }
}

type ObjectProperty = Exclude<ObjectExpression['properties'][number], SpreadElement>

function propertyKey(property: ObjectProperty): string | undefined {
  if (property.computed || property.kind !== 'init') {
    return undefined
  }
  const key = property.key
  if (key.type === 'Identifier') {
    return key.name
  }
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value
  }
  return undefined
}

function unwrap(expression: Expression): Expression {
  let current = expression
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression'
  ) {
    current = current.expression
  }
  return current
}

/** `T | undefined` → `T` (an optional parameter, or one with a default value, accepts `undefined`). */
function withoutUndefined(type: TypeInfo): TypeInfo {
  if (type.kind === 'primitive' && (type.name === 'undefined' || type.name === 'void')) {
    return unionType([])
  }
  if (type.kind !== 'union') {
    return type
  }
  return unionType(
    type.types.filter(
      member => !(member.kind === 'primitive' && (member.name === 'undefined' || member.name === 'void')),
    ),
  )
}
