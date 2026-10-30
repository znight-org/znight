/**
 * User-defined route metadata decorators (`createRouteDecorator<T>(key, { group?, required? })`).
 *
 * A decorator is a route decorator when its callee is a `const` initialised with a call to
 * `@znight/http#createRouteDecorator` whose first argument (the key) and optional second argument
 * (the options) are statically evaluable. Its argument is evaluated like a `value` decorator
 * argument (literals, `const` references, references to exported bindings); without argument the
 * value is `true`. Decorators of one group are alternatives: one per controller or route.
 */
import type {
  AnalyzeContext,
  ClassInfo,
  DecoratorInfo,
  Diagnostic,
  Location,
  StaticValue,
  ValueRef,
} from '@znight/compiler'
import type { HttpControllerData, MetaEntry } from './model.ts'

import { type AstNode, child, children, isNode, unwrap } from './ast.ts'
import { Codes, GROUP_NAME, Ids } from './model.ts'

type Context = AnalyzeContext<HttpControllerData>
type Project = Context['project']
type ScopeInput = Parameters<Project['evaluate']>[0]
type ExpressionInput = Parameters<Project['evaluate']>[1]
type EntityName = Parameters<Project['resolveIdentifier']>[1]

/** A route decorator definition: `export const Roles = createRouteDecorator<T>(key, options)`. */
export interface RouteDecoratorDefinition {
  readonly kind: 'route'
  readonly key: string
  /** `options.group ?? key`. */
  readonly group: string
  readonly required: boolean
  /** Name of the `const` (`Roles`). */
  readonly name: string
  /** Location of the `const` name. */
  readonly definition: Location
}

/** What a decorator identity refers to. */
export type RouteDecoratorResolution =
  | RouteDecoratorDefinition
  | { readonly kind: 'other' }
  | {
      readonly kind: 'invalid'
      readonly message: string
      readonly hints: readonly string[]
      /** The definition, when the problem is there. */
      readonly definition?: Location
    }

const OTHER: RouteDecoratorResolution = Object.freeze({ kind: 'other' })

/** Resolutions per analysis context (one context per compile). */
const caches = new WeakMap<object, Map<string, RouteDecoratorResolution>>()

/** Resolves a decorator identity to a route decorator definition (memoized per compile). */
export function resolveRouteDecorator(ctx: Context, identity: string): RouteDecoratorResolution {
  let cache = caches.get(ctx)
  if (!cache) {
    cache = new Map()
    caches.set(ctx, cache)
  }
  let resolution = cache.get(identity)
  if (!resolution) {
    resolution = resolve(ctx, identity)
    cache.set(identity, resolution)
  }
  return resolution
}

function resolve(ctx: Context, identity: string): RouteDecoratorResolution {
  if (identity.startsWith('globalThis#')) {
    return OTHER
  }
  const symbol = ctx.project.lookupIdentity(identity)
  if (symbol.kind !== 'declaration') {
    return OTHER
  }
  const declaration = symbol.declarations.find(candidate => candidate.kind === 'const')
  const node = declaration?.node as unknown
  const file = declaration ? ctx.project.getFile(declaration.file) : undefined
  if (!declaration || !isNode(node) || !file) {
    return OTHER
  }
  const scope = { file, namespace: declaration.namespace } as unknown as ScopeInput
  const init = child(node, 'init')
  if (!init) {
    // `export declare const Roles: RouteDecorator<string[]>` (declaration file): the key is lost
    const annotation = child(child(node, 'id') ?? node, 'typeAnnotation')
    const type = annotation
      ? ctx.project.resolveType(scope, annotation as unknown as Parameters<Project['resolveType']>[1])
      : undefined
    if (type?.kind === 'reference' && type.identity === Ids.RouteDecorator) {
      return {
        kind: 'invalid',
        message: `the key of the route decorator ${declaration.name} cannot be read: it is declared without initializer`,
        hints: [
          'Route decorators must be declared in analysed sources: `export const X = createRouteDecorator(key)`',
          'For a provider library, publish its sources ("znight": { "library": "source" })',
        ],
      }
    }
    return OTHER
  }
  const call = unwrap(init)
  const callee = call.type === 'CallExpression' ? child(call, 'callee') : undefined
  if (!callee || !isEntityName(unwrap(callee))) {
    return OTHER
  }
  const resolved = ctx.project.resolveIdentifier(scope, unwrap(callee) as unknown as EntityName, 'value')
  if (resolved.identity?.identity !== Ids.createRouteDecorator) {
    return OTHER
  }
  const definition = file.location(declaration.span)
  const [keyNode, optionsNode, ...extra] = children(call, 'arguments')
  if (!keyNode || keyNode.type === 'SpreadElement') {
    return {
      kind: 'invalid',
      message: `createRouteDecorator() requires a key (${declaration.name})`,
      hints: [`export const ${declaration.name} = createRouteDecorator('${declaration.name.toLowerCase()}')`],
      definition,
    }
  }
  const key = ctx.project.evaluate(scope, keyNode as unknown as ExpressionInput, { refs: 'none' })
  if (key.kind !== 'value' || typeof key.value !== 'string' || key.value === '') {
    return {
      kind: 'invalid',
      message: `the key of the route decorator ${declaration.name} must be a statically evaluable non-empty string`,
      hints: ["Use a string literal or a `const` string: createRouteDecorator('roles')"],
      definition,
    }
  }
  const optionsHints = [
    `export const ${declaration.name} = createRouteDecorator('${key.value}', { group: 'access', required: true })`,
  ]
  if (extra.length > 0 || optionsNode?.type === 'SpreadElement') {
    return {
      kind: 'invalid',
      message: `createRouteDecorator() takes a key and an optional { group?, required? } object (${declaration.name})`,
      hints: optionsHints,
      definition,
    }
  }
  let options: StaticValue
  if (optionsNode !== undefined) {
    const evaluated = ctx.project.evaluate(scope, optionsNode as unknown as ExpressionInput, { refs: 'none' })
    if (evaluated.kind !== 'value') {
      return {
        kind: 'invalid',
        message: `the options of the route decorator ${declaration.name} must be statically evaluable (literals and \`const\` references)`,
        hints: optionsHints,
        definition,
      }
    }
    options = evaluated.value
  }
  const parsed = parseRouteDecoratorOptions(key.value, options)
  if ('error' in parsed) {
    return {
      kind: 'invalid',
      message: `the options of the route decorator ${declaration.name} ${parsed.error}`,
      hints: optionsHints,
      definition,
    }
  }
  return { kind: 'route', key: key.value, ...parsed, name: declaration.name, definition }
}

/**
 * The group and `required` of a route decorator from its evaluated options (`undefined`: the
 * defaults), or why the options are invalid.
 */
export function parseRouteDecoratorOptions(
  key: string,
  options: StaticValue,
): { readonly group: string; readonly required: boolean } | { readonly error: string } {
  if (options === undefined) {
    return { group: key, required: false }
  }
  if (!isPlainObject(options)) {
    return { error: 'must be an object { group?, required? }' }
  }
  const unknown = Object.keys(options).find(name => name !== 'group' && name !== 'required')
  if (unknown !== undefined) {
    return { error: `have an unknown property "${unknown}" (expected group and required)` }
  }
  // the grammar applies to an explicit group only: without one, any key is its own group
  const group = options['group'] ?? key
  if (typeof group !== 'string' || (group !== key && !GROUP_NAME.test(group))) {
    const shown = typeof group === 'object' && group !== null ? 'a reference' : JSON.stringify(group)
    return { error: `have an invalid group ${shown}: a letter followed by letters, digits, _ . or -` }
  }
  const required = options['required'] ?? false
  if (typeof required !== 'boolean') {
    return { error: 'have a non-boolean "required"' }
  }
  return { group, required }
}

function isPlainObject(value: unknown): value is Record<string, StaticValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isEntityName(node: AstNode): boolean {
  if (node.type === 'Identifier') {
    return true
  }
  if (node.type === 'MemberExpression' && node['computed'] !== true) {
    const object = child(node, 'object')
    return child(node, 'property')?.type === 'Identifier' && object !== undefined && isEntityName(object)
  }
  return false
}

/**
 * Metadata entries of the route decorators applied to a class or a method (source order).
 * `target` names the class or the handler (`BookController`, `BookController.remove`). Problems are
 * reported as ZNIGHT005: two decisions of one group on the same target included.
 */
export function routeMeta(
  ctx: Context,
  cls: ClassInfo,
  decorators: readonly DecoratorInfo[],
  target: string,
): MetaEntry[] {
  const entries: MetaEntry[] = []
  for (const decorator of decorators) {
    if (decorator.owner !== undefined || decorator.identity === undefined) {
      continue
    }
    const resolution = resolveRouteDecorator(ctx, decorator.identity)
    if (resolution.kind === 'other') {
      continue
    }
    if (resolution.kind === 'invalid') {
      report(
        ctx,
        decorator,
        `Invalid route decorator @${decorator.name}: ${resolution.message}`,
        resolution.hints,
        resolution.definition === undefined
          ? undefined
          : { message: 'The route decorator is defined here', location: resolution.definition },
      )
      continue
    }
    const value = metaValue(ctx, cls, decorator)
    if (value === INVALID) {
      continue
    }
    const previous = entries.find(entry => entry.group === resolution.group)
    if (previous) {
      if (previous.key === resolution.key && resolution.group === resolution.key) {
        report(
          ctx,
          decorator,
          `@${decorator.name} sets the route metadata '${resolution.key}', already set on the same target`,
          ['Apply each route decorator once per controller or route'],
          { message: 'First applied here', location: previous.location },
        )
      } else {
        const alternatives =
          previous.decorator === resolution.name
            ? `@${resolution.name} once`
            : `one of @${previous.decorator}, @${resolution.name}`
        report(
          ctx,
          decorator,
          `@${resolution.name} sets the "${resolution.group}" decision of ${target}, already set by @${previous.decorator} on the same target`,
          [`Keep ${alternatives}: the decorators of the "${resolution.group}" group are alternatives`],
          { message: 'First applied here', location: previous.location },
        )
      }
      continue
    }
    entries.push({
      key: resolution.key,
      value,
      location: decorator.location,
      group: resolution.group,
      required: resolution.required,
      decorator: resolution.name,
      identity: decorator.identity,
      definition: resolution.definition,
    })
  }
  return entries
}

/** `true` when the decorator is a route metadata decorator. */
export function isRouteMetaDecorator(ctx: Context, decorator: DecoratorInfo): boolean {
  return (
    decorator.owner === undefined &&
    decorator.identity !== undefined &&
    resolveRouteDecorator(ctx, decorator.identity).kind !== 'other'
  )
}

const INVALID: unique symbol = Symbol('invalid')

function metaValue(ctx: Context, cls: ClassInfo, decorator: DecoratorInfo): StaticValue | typeof INVALID {
  if (!decorator.called) {
    report(ctx, decorator, `@${decorator.name} must be called: @${decorator.name}()`, [
      `Write @${decorator.name}(${decorator.args.length > 0 ? '...' : ''})`,
    ])
    return INVALID
  }
  const [arg, ...extra] = decorator.args
  if (arg === undefined) {
    return true
  }
  if (extra.length > 0) {
    report(ctx, decorator, `@${decorator.name} takes at most one argument`, [
      'Pass a single value (an array or an object)',
    ])
    return INVALID
  }
  if (arg.text.startsWith('...')) {
    report(ctx, decorator, `@${decorator.name} does not accept spread arguments`, ['Pass the value directly'])
    return INVALID
  }
  const evaluation = ctx.project.evaluate(cls.file, arg.node as unknown as ExpressionInput, { refs: 'nested' })
  switch (evaluation.kind) {
    case 'value':
      return checkRefs(ctx, decorator, evaluation.value) ? evaluation.value : INVALID
    case 'ref':
      return checkRefs(ctx, decorator, evaluation.ref) ? evaluation.ref : INVALID
    case 'error': {
      ctx.report({
        code: Codes.InvalidDecorator,
        severity: 'error',
        message: `Invalid argument of @${decorator.name}: ${evaluation.error.message}`,
        location: evaluation.error.location,
        hints: [evaluation.error.hint ?? 'Extract the value to `export const X = ...` and reference it'],
      })
      return INVALID
    }
  }
}

/** Checks that every reference of a value can be imported by the generated module. */
function checkRefs(ctx: Context, decorator: DecoratorInfo, value: StaticValue): boolean {
  let ok = true
  const visit = (current: StaticValue): void => {
    if (isValueRef(current)) {
      const route = ctx.project.importRoute(current.symbol)
      if (!route.ok) {
        ok = false
        ctx.report({
          code: Codes.InvalidDecorator,
          severity: 'error',
          message: `Invalid argument of @${decorator.name}: '${current.text}' cannot be imported by the generated module (${route.error.message})`,
          location: current.location,
          hints: route.error.hints.length > 0 ? [...route.error.hints] : ['Export it from its module'],
        })
      }
      return
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item)
      }
    } else if (typeof current === 'object' && current !== null) {
      for (const item of Object.values(current)) {
        visit(item)
      }
    }
  }
  visit(value)
  return ok
}

/** `true` for a {@link ValueRef} (the only non-plain object a static value can hold). */
export function isValueRef(value: unknown): value is ValueRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype !== Object.prototype && prototype !== null && (value as { kind?: unknown }).kind === 'ref'
}

function report(
  ctx: Context,
  decorator: DecoratorInfo,
  message: string,
  hints: readonly string[],
  related?: { readonly message: string; readonly location: Diagnostic['location'] },
): void {
  ctx.report({
    code: Codes.InvalidDecorator,
    severity: 'error',
    message,
    location: decorator.location,
    hints,
    ...(related?.location ? { related: [{ message: related.message, location: related.location }] } : {}),
  })
}
