/**
 * `analyzeClass` of the graphql extension (RFC 0005 §6.1, §6.5): registers `@Resolver` classes as
 * providers (and roots), checks their field methods and parameters, binds `@UseGuard` guards and
 * `Loader<L>` parameters with lazy edges (resolved per call, in the current scope), reads route
 * decorators with the readers of `@znight/http/compiler`, and stores one {@link ResolverData} per
 * resolver. Types are not read here: `validate` builds the schema model from the method signatures.
 */

import type {
  AnalyzeContext,
  ClassInfo,
  ClassRef,
  DecoratorInfo,
  Location,
  MethodInfo,
  ParameterInfo,
  StaticValue,
} from '@znight/compiler'
import type { Scope } from '@znight/core'
import type { MetaEntry } from '@znight/http/compiler'
import type { FieldData, FieldOperation, GraphQLData, ParamData, ResolverData } from './data.ts'
import type { ResolvedGraphQLCompilerOptions } from './options.ts'

import { effectiveRouteMeta, readRouteMeta } from '@znight/http/compiler'

import { isGraphQLName } from '../names.ts'
import { Codes, ROOT_REASON } from './constants.ts'
import {
  EXTENSION_NAME,
  FIELD_DECORATORS,
  GraphQLIds,
  HTTP_CONTROLLER,
  HTTP_LOOK_ALIKES,
  PARAMETER_DECORATORS,
  RUNTIME_MODULE,
} from './ids.ts'

type Context = AnalyzeContext<GraphQLData>

const SCOPES: readonly Scope[] = ['singleton', 'request', 'transient']

/** Shape options reading `Loader<L>` parameters: the alias is kept, `L` stays a named shape. */
const LOADER_SHAPE = Object.freeze({ keep: Object.freeze([GraphQLIds.Loader]), jsdoc: false })

/**
 * Analyses a class carrying at least one graphql decorator (class, method or parameter). In
 * schema-first mode (RFC 0007), `@Resolver('Type')` names the SDL type of the field resolvers and
 * `@Parent()` is optional.
 */
export function analyzeGraphQLClass(cls: ClassInfo, ctx: Context, options: ResolvedGraphQLCompilerOptions): void {
  const resolvers = cls.decorators.filter(decorator => decorator.identity === GraphQLIds.Resolver)
  const resolver = resolvers[0]
  if (resolver === undefined) {
    reportOutsideResolver(cls, ctx)
    storeClaims(ctx, cls, undefined, options)
    return
  }
  for (const extra of resolvers.slice(1)) {
    error(ctx, Codes.InvalidDecorator, extra.location, `@Resolver is applied twice to ${cls.displayName}`, [
      'Apply it once',
    ])
  }
  const controller = cls.decorators.find(decorator => decorator.identity === HTTP_CONTROLLER)
  if (controller !== undefined) {
    error(
      ctx,
      Codes.InvalidDecorator,
      resolver.location,
      `${cls.displayName} cannot be both a @Resolver and a @Controller`,
      [
        'A class is the provider of one extension: move the GraphQL fields to their own @Resolver() class (both may call the same service)',
      ],
      [{ message: '@Controller is applied here', location: controller.location }],
    )
    storeClaims(ctx, cls, resolver, options)
    return
  }
  if (ctx.options.library) {
    error(
      ctx,
      Codes.InvalidResolver,
      resolver.location,
      `${cls.displayName} is a @Resolver in a compiled provider library: the schema is derived from the sources`,
      ['Publish the package as a source library (without library: true), so that applications compile its resolvers'],
    )
    storeClaims(ctx, cls, resolver, options)
    return
  }
  if (cls.abstract || cls.typeParameters.length > 0) {
    error(
      ctx,
      Codes.InvalidDecorator,
      resolver.location,
      cls.abstract
        ? `@Resolver cannot be applied to the abstract class ${cls.displayName}`
        : `@Resolver cannot be applied to the generic class ${cls.displayName}<${cls.typeParameters.join(', ')}>`,
      [cls.abstract ? 'Resolvers are instantiated: remove `abstract`' : 'Remove the type parameters of the resolver'],
    )
    storeClaims(ctx, cls, resolver, options)
    return
  }

  const { scope, typeName } = resolverArguments(ctx, resolver, options.schema !== false)
  ctx.registerProvider(cls, { scope })
  // resolvers are entry points of the plugin: roots of ZNIGHT019 and prune
  ctx.addRoot(cls, { reason: ROOT_REASON, location: resolver.location })

  const classGuards = guardsOf(ctx, cls, cls.decorators)
  const classMeta = readRouteMeta(ctx, cls)
  const fields: FieldData[] = []
  for (const method of cls.methods) {
    const decorators = method.decorators.filter(isFieldDecorator)
    if (decorators.length === 0) {
      reportStrayMethodDecorators(cls, method, ctx)
      continue
    }
    fields.push(...analyzeMethod(ctx, cls, method, decorators, classMeta, options.schema !== false))
  }
  const data: ResolverData = {
    kind: 'resolver',
    host: cls,
    scope,
    location: resolver.location,
    guards: classGuards,
    fields,
    ...(typeName === undefined ? {} : { typeName }),
  }
  if (options.schema !== false && typeName === undefined) {
    for (const field of fields) {
      if (field.operation !== 'field') continue
      error(
        ctx,
        Codes.InvalidResolver,
        field.location,
        `@ResolveField ${cls.displayName}.${field.method} needs the type it resolves a field of: name it in @Resolver (schema-first)`,
        [
          `@Resolver('Event') on ${cls.displayName}, where Event is the object type of the SDL declaring '${field.name}'`,
        ],
      )
    }
  }
  ctx.store(data)
}

/**
 * Schema-first: a class rejected above (no `@Resolver`, abstract, a controller...) still names the
 * fields its methods resolve, stored as an `invalid` resolver, so that these fields are not also
 * reported as missing a resolver (one diagnostic per mistake).
 */
function storeClaims(
  ctx: Context,
  cls: ClassInfo,
  resolver: DecoratorInfo | undefined,
  options: ResolvedGraphQLCompilerOptions,
): void {
  if (options.schema === false) return
  const typeArg = resolver?.args[0]
  const typeName =
    typeArg?.evaluated === true && typeof typeArg.value === 'string'
      ? { name: typeArg.value, location: typeArg.location }
      : undefined
  const fields: FieldData[] = []
  for (const method of cls.methods) {
    for (const decorator of method.decorators.filter(isFieldDecorator)) {
      const arg = decorator.args[0]
      fields.push({
        method: method.name,
        operation: FIELD_DECORATORS.get(decorator.identity as string) as FieldOperation,
        name: arg?.evaluated === true && typeof arg.value === 'string' ? arg.value : method.name,
        location: decorator.location,
        methodLocation: method.location,
        guards: [],
        meta: [],
        params: [],
        complete: false,
      })
    }
  }
  if (fields.length === 0) return
  ctx.store({
    kind: 'resolver',
    host: cls,
    scope: 'singleton',
    location: resolver?.location ?? cls.location,
    guards: [],
    fields,
    invalid: true,
    ...(typeName === undefined ? {} : { typeName }),
  })
}

function isFieldDecorator(decorator: DecoratorInfo): boolean {
  return decorator.identity !== undefined && FIELD_DECORATORS.has(decorator.identity)
}

function isParameterDecorator(decorator: DecoratorInfo): boolean {
  return decorator.identity !== undefined && PARAMETER_DECORATORS.has(decorator.identity)
}

/** `@Resolver()`, `@Resolver({ scope })`, `@Resolver('Event')`, `@Resolver('Event', { scope })` (schema-first). */
function resolverArguments(
  ctx: Context,
  decorator: DecoratorInfo,
  schemaFirst: boolean,
): { scope: Scope; typeName?: { readonly name: string; readonly location: Location } } {
  const [first, second] = decorator.args
  if (first?.evaluated !== true || typeof first.value !== 'string') {
    if (second !== undefined) {
      error(ctx, Codes.InvalidDecorator, second.location, '@Resolver takes the options as its only argument here', [
        "@Resolver({ scope: 'request' }), or @Resolver('Event', { scope: 'request' }) in schema-first mode",
      ])
    }
    return { scope: resolverScope(ctx, first) }
  }
  const scope = resolverScope(ctx, second)
  const name = first.value
  if (!schemaFirst) {
    error(
      ctx,
      Codes.InvalidDecorator,
      first.location,
      `@Resolver('${name}'): naming the type is schema-first only, the code-first schema is derived from the types`,
      [
        'Remove the type name: @ResolveField methods add fields to the type of their @Parent() parameter',
        "Or switch to schema-first: graphql.configure({ schema: 'src/**/*.graphql' }) in znight.config.ts",
      ],
    )
    return { scope }
  }
  if (!isGraphQLName(name)) {
    error(ctx, Codes.NameConflict, first.location, `'${name}' is not a valid GraphQL type name (@Resolver)`, [
      'GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __',
    ])
    return { scope }
  }
  return { scope, typeName: { name, location: first.location } }
}

/** The `{ scope }` options of `@Resolver`. */
function resolverScope(ctx: Context, arg: DecoratorInfo['args'][number] | undefined): Scope {
  if (arg === undefined || !arg.evaluated || arg.value === undefined) return 'singleton'
  const value = arg.value
  if (!isRecord(value)) {
    error(ctx, Codes.InvalidDecorator, arg.location, `@Resolver expects { scope? }, got ${describe(value)}`, [
      "@Resolver() or @Resolver({ scope: 'request' })",
    ])
    return 'singleton'
  }
  let scope: Scope = 'singleton'
  for (const [key, option] of Object.entries(value)) {
    if (key !== 'scope') {
      error(ctx, Codes.InvalidDecorator, arg.location, `@Resolver: unknown option "${key}"`, ['Options: { scope? }'])
    } else if (SCOPES.includes(option as Scope)) {
      scope = option as Scope
    } else if (option !== undefined) {
      error(ctx, Codes.InvalidDecorator, arg.location, `@Resolver: invalid scope ${describe(option)}`, [
        `Use one of ${SCOPES.map(candidate => `'${candidate}'`).join(', ')}`,
      ])
    }
  }
  return scope
}

/** `@UseGuard(A, B)` decorators of a target: guard classes bound with lazy edges (C3). */
function guardsOf(ctx: Context, cls: ClassInfo, decorators: readonly DecoratorInfo[]): ClassRef[] {
  const guards: ClassRef[] = []
  for (const decorator of decorators) {
    if (decorator.identity !== GraphQLIds.UseGuard) continue
    if (decorator.args.length === 0) {
      error(ctx, Codes.InvalidDecorator, decorator.location, '@UseGuard needs at least one guard class', [
        '@UseGuard(AccessGuard)',
      ])
    }
    for (const arg of decorator.args) {
      // resolved per resolver call in the current scope: a singleton resolver may use a request-scoped guard
      const ref = ctx.resolveClassRef(arg, { from: cls, role: 'guard', lazy: true })
      if (ref !== undefined) guards.push(ref)
    }
  }
  return guards
}

// ------------------------------------------------------------------------------------------ methods

function analyzeMethod(
  ctx: Context,
  cls: ClassInfo,
  method: MethodInfo,
  decorators: readonly DecoratorInfo[],
  classMeta: readonly MetaEntry[],
  schemaFirst: boolean,
): FieldData[] {
  const where = `${cls.displayName}.${method.name}`
  const primary = decorators[0] as DecoratorInfo
  let complete = checkMethodShape(ctx, method, primary, where)
  complete = checkForeignHandler(ctx, method, primary, where) && complete
  const params: (ParamData | undefined)[] = []
  for (const param of method.params) {
    const data = analyzeParameter(ctx, cls, param, where)
    params.push(data)
    if (data === undefined) complete = false
  }
  const parents = params.filter(param => param?.kind === 'parent')
  for (const extra of parents.slice(1)) {
    error(
      ctx,
      Codes.InvalidResolver,
      (extra as { location: Location }).location,
      `${where} has several @Parent() parameters`,
      ['Declare the parent object once'],
    )
    complete = false
  }
  const guards = guardsOf(ctx, cls, method.decorators)
  const meta = effectiveRouteMeta(classMeta, readRouteMeta(ctx, cls, method))

  const fields: FieldData[] = []
  const seen = new Set<string>()
  for (const decorator of decorators) {
    const operation = FIELD_DECORATORS.get(decorator.identity as string) as FieldOperation
    const explicit = fieldName(ctx, decorator, method, where)
    // an invalid name is reported: the field stays known (incomplete), so no "no @Query" cascade
    const name = explicit ?? method.name
    const key = `${operation}\0${name}`
    if (seen.has(key)) {
      error(
        ctx,
        Codes.InvalidDecorator,
        decorator.location,
        `@${decorator.name}('${name}') is applied twice to ${where}`,
        ['Apply each field decorator once'],
      )
      continue
    }
    seen.add(key)
    let fieldComplete = complete && explicit !== undefined
    // schema-first: the type is named by @Resolver('Type'), the parent is optional (NestJS)
    if (operation === 'field' && parents.length === 0 && !schemaFirst) {
      error(ctx, Codes.InvalidResolver, decorator.location, `@ResolveField ${where} has no @Parent() parameter`, [
        `Declare the parent object first: ${method.name}(@Parent() parent: ParentType, ...)`,
      ])
      fieldComplete = false
    } else if (operation !== 'field' && parents.length > 0) {
      error(
        ctx,
        Codes.InvalidResolver,
        (parents[0] as { location: Location }).location,
        `@Parent() is only available in @ResolveField methods, not in the @${decorator.name} ${where}`,
        ['Root fields have no parent object: remove the parameter'],
      )
      fieldComplete = false
    }
    fields.push({
      method: method.name,
      operation,
      name,
      location: decorator.location,
      methodLocation: method.location,
      guards,
      meta,
      params,
      complete: fieldComplete,
    })
  }
  return fields
}

/** The field name: the static decorator argument, or the method name. */
function fieldName(ctx: Context, decorator: DecoratorInfo, method: MethodInfo, where: string): string | undefined {
  const arg = decorator.args[0]
  if (arg === undefined || (arg.evaluated && arg.value === undefined)) {
    if (isGraphQLName(method.name)) return method.name
    error(
      ctx,
      Codes.NameConflict,
      decorator.location,
      `'${method.name}' is not a valid GraphQL field name (${where}): name the field in the decorator`,
      ['GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __', `@${decorator.name}('validName')`],
    )
    return undefined
  }
  if (!arg.evaluated) return undefined // not statically evaluable: reported by the compiler
  const value = arg.value
  if (typeof value !== 'string') {
    error(
      ctx,
      Codes.InvalidDecorator,
      arg.location,
      `@${decorator.name} on ${where} expects a field name, got ${describe(value)}`,
      [`@${decorator.name}('${method.name}') or @${decorator.name}()`],
    )
    return undefined
  }
  if (!isGraphQLName(value)) {
    error(ctx, Codes.NameConflict, arg.location, `'${value}' is not a valid GraphQL field name (${where})`, [
      'GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __',
    ])
    return undefined
  }
  return value
}

/** Resolver methods are called by the generated code: `resolver.method(...)`. */
function checkMethodShape(ctx: Context, method: MethodInfo, decorator: DecoratorInfo, where: string): boolean {
  const name = `@${decorator.name}`
  let problem: { message: string; hint: string } | undefined
  if (method.kind !== 'method') {
    problem = { message: `${name} cannot be applied to the accessor ${where}`, hint: 'Use a regular method' }
  } else if (method.static) {
    problem = {
      message: `${name} cannot be applied to the static method ${where}`,
      hint: 'Fields are resolved on the resolver instance: remove `static`',
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
  } else if (method.typeParameters.length > 0) {
    problem = {
      message: `${name} cannot be applied to the generic method ${where}<${method.typeParameters.join(', ')}>`,
      hint: 'The schema is derived from the signature: remove the type parameters',
    }
  }
  if (problem === undefined) return true
  error(ctx, Codes.InvalidDecorator, decorator.location, problem.message, [problem.hint])
  return false
}

/** A resolver method cannot also be handled by another extension (`@Get`, `@OnMessage`, `@Cron`). */
function checkForeignHandler(ctx: Context, method: MethodInfo, decorator: DecoratorInfo, where: string): boolean {
  for (const other of method.decorators) {
    const owner = other.owner
    if (owner === undefined || owner === EXTENSION_NAME || owner === 'core' || owner === 'manifest') continue
    error(
      ctx,
      Codes.InvalidDecorator,
      other.location,
      `${where} cannot be both a GraphQL field (@${decorator.name}) and a @${other.name} handler`,
      ['A class is the provider of one extension: let both handlers call a shared service'],
    )
    return false
  }
  return true
}

// --------------------------------------------------------------------------------------- parameters

/**
 * Graphql parameter decorators of a parameter, de-duplicated by position (the compiler reports the
 * decorators of a parameter with a default value twice).
 */
function parameterDecorators(param: ParameterInfo): DecoratorInfo[] {
  const seen = new Set<number>()
  return param.decorators.filter(decorator => {
    if (!isParameterDecorator(decorator) || seen.has(decorator.location.start)) return false
    seen.add(decorator.location.start)
    return true
  })
}

function analyzeParameter(ctx: Context, cls: ClassInfo, param: ParameterInfo, where: string): ParamData | undefined {
  const decorators = parameterDecorators(param)
  const decorator = decorators[0]
  if (decorator === undefined) {
    const lookAlike = param.decorators.find(
      found => found.identity !== undefined && HTTP_LOOK_ALIKES.has(found.identity),
    )
    if (lookAlike !== undefined) {
      const replacement = (HTTP_LOOK_ALIKES.get(lookAlike.identity as string) as string).split('#')[1] as string
      error(
        ctx,
        Codes.InvalidDecorator,
        lookAlike.location,
        `@${lookAlike.name} on parameter '${param.name}' of ${where} is imported from '@znight/http': resolver parameters use @${replacement}() from '${RUNTIME_MODULE}'`,
        [`Import it from '${RUNTIME_MODULE}': import { ${replacement} } from '${RUNTIME_MODULE}'`],
      )
      return undefined
    }
    error(
      ctx,
      Codes.InvalidDecorator,
      param.location,
      `Parameter '${param.name}' of ${where} has no @Args(), @Parent(), @Ctx(), @Info() or @Loader() decorator`,
      [
        'Every resolver parameter is filled by GraphQL: @Args(name?, schema?) for arguments, @Parent() for the parent object, @Ctx() for the GraphQLContext, @Info() for the GraphQLResolveInfo, @Loader() for a DataLoader',
      ],
    )
    return undefined
  }
  if (decorators.length > 1) {
    error(
      ctx,
      Codes.InvalidDecorator,
      (decorators[1] as DecoratorInfo).location,
      `Parameter '${param.name}' of ${where} has several GraphQL decorators (${decorators.map(found => `@${found.name}`).join(', ')})`,
      ['Keep a single one'],
    )
    return undefined
  }
  if (param.rest) {
    error(
      ctx,
      Codes.InvalidDecorator,
      decorator.location,
      `@${decorator.name} cannot be applied to the rest parameter '...${param.name}' of ${where}`,
    )
    return undefined
  }
  switch (PARAMETER_DECORATORS.get(decorator.identity as string)) {
    case 'args':
      return argsParameter(ctx, decorator, param, where)
    case 'parent':
      return { kind: 'parent', location: decorator.location }
    case 'ctx':
      return { kind: 'ctx' }
    case 'info':
      return { kind: 'info' }
    default:
      return loaderParameter(ctx, cls, param, where)
  }
}

/** `@Args()`, `@Args('name')`, `@Args('name', Schema)`, `@Args(Schema)`. */
function argsParameter(
  ctx: Context,
  decorator: DecoratorInfo,
  param: ParameterInfo,
  where: string,
): ParamData | undefined {
  const [first, second, ...extra] = decorator.args
  if (extra.length > 0) {
    error(ctx, Codes.InvalidDecorator, decorator.location, `@Args takes at most two arguments (${where})`, [
      "@Args(), @Args('name'), @Args('name', Schema) or @Args(Schema)",
    ])
    return undefined
  }
  let name: string | undefined
  let schemaArg = second
  if (first !== undefined) {
    if (!first.evaluated && first.ref === undefined) return undefined // reported by the compiler
    if (typeof first.value === 'string') {
      if (!isGraphQLName(first.value)) {
        error(
          ctx,
          Codes.NameConflict,
          first.location,
          `'${first.value}' is not a valid GraphQL argument name (parameter '${param.name}' of ${where})`,
          ['GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __'],
        )
        return undefined
      }
      name = first.value
    } else if (first.ref !== undefined) {
      if (second !== undefined) {
        error(ctx, Codes.InvalidDecorator, second.location, `@Args(Schema) takes no second argument (${where})`, [
          "@Args('name', Schema) validates one argument, @Args(Schema) every argument",
        ])
        return undefined
      }
      schemaArg = first
    } else if (first.value !== undefined) {
      error(
        ctx,
        Codes.InvalidDecorator,
        first.location,
        `@Args on parameter '${param.name}' of ${where} expects an argument name or a schema, got ${describe(first.value)}`,
        ["@Args('id'), @Args() or @Args('input', Schema)"],
      )
      return undefined
    }
  }
  if (schemaArg !== undefined && !(schemaArg.evaluated && schemaArg.value === undefined)) {
    if (schemaArg.ref === undefined) {
      if (schemaArg.evaluated) {
        error(
          ctx,
          Codes.InvalidDecorator,
          schemaArg.location,
          `The schema of @Args on parameter '${param.name}' of ${where} must be a reference to an exported schema`,
          ['Declare it with `export const Schema = z.object(...)` and pass Schema: the generated module imports it'],
        )
      }
      return undefined
    }
    return { kind: 'args', name, schema: schemaArg.ref, location: decorator.location }
  }
  return { kind: 'args', name, schema: undefined, location: decorator.location }
}

/** `@Loader() authors: Loader<AuthorsById>`: binds `AuthorsById` with a lazy edge. */
function loaderParameter(ctx: Context, cls: ClassInfo, param: ParameterInfo, where: string): ParamData | undefined {
  const root = ctx.types.shape({ parameter: param }, LOADER_SHAPE)
  const shape = root.root
  const argument = shape.kind === 'reference' && shape.identity === GraphQLIds.Loader ? shape.typeArgs[0] : undefined
  const identity = argument?.kind === 'named' ? root.named.get(argument.key)?.identity : undefined
  if (identity === undefined) {
    error(
      ctx,
      Codes.InvalidLoader,
      param.typeLocation,
      `@Loader() parameter '${param.name}' of ${where} must be typed Loader<L>, with L a loader class`,
      [
        `${param.name}: Loader<AuthorsById>, where AuthorsById is a provider implementing BatchLoad<K, V> (import type { Loader } from '${RUNTIME_MODULE}')`,
      ],
    )
    return undefined
  }
  // the DataLoader is created per execution, in the current scope: a lazy edge (no ZNIGHT003)
  const binding = ctx.bindInjection(
    { type: identity, location: param.typeLocation, label: `loader '${param.name}' of ${where}()` },
    { from: cls, lazy: true },
  )
  return { kind: 'loader', binding, identity, location: param.typeLocation }
}

// ------------------------------------------------------------------------------------ outside resolvers

/**
 * Graphql decorators on a class without `@Resolver`: field methods are not inherited (a base
 * class), and parameter or guard decorators have no effect.
 */
function reportOutsideResolver(cls: ClassInfo, ctx: Context): void {
  for (const decorator of cls.decorators) {
    if (decorator.identity === GraphQLIds.UseGuard) {
      error(
        ctx,
        Codes.InvalidDecorator,
        decorator.location,
        `@UseGuard has no effect: ${cls.displayName} is not a @Resolver`,
        [`Add @Resolver() to ${cls.displayName}`],
      )
    }
  }
  for (const method of cls.methods) {
    const fields = method.decorators.filter(isFieldDecorator)
    for (const field of fields) {
      error(
        ctx,
        Codes.InvalidResolver,
        field.location,
        `@${field.name} ${cls.displayName}.${method.name} is declared on a class that is not a @Resolver`,
        [
          cls.abstract
            ? `Resolver methods are not inherited: declare the field on the concrete @Resolver() class (it may call ${method.name} of the base class)`
            : `Add @Resolver() to ${cls.displayName} (resolver methods are not inherited from base classes)`,
        ],
      )
    }
    if (fields.length === 0) reportStrayMethodDecorators(cls, method, ctx)
  }
}

/** `@UseGuard` or parameter decorators on a method that is not a field. */
function reportStrayMethodDecorators(cls: ClassInfo, method: MethodInfo, ctx: Context): void {
  const where = `${cls.displayName}.${method.name}`
  for (const decorator of method.decorators) {
    if (decorator.identity === GraphQLIds.UseGuard) {
      error(
        ctx,
        Codes.InvalidDecorator,
        decorator.location,
        `@UseGuard has no effect: ${where} is not a GraphQL field`,
        ['Add @Query(), @Mutation(), @Subscription() or @ResolveField() to the method'],
      )
    }
  }
  for (const param of method.params) {
    for (const decorator of parameterDecorators(param)) {
      error(
        ctx,
        Codes.InvalidDecorator,
        decorator.location,
        `@${decorator.name} has no effect: ${where} is not a GraphQL field`,
        ['Add @Query(), @Mutation(), @Subscription() or @ResolveField() to the method'],
      )
    }
  }
}

// ------------------------------------------------------------------------------------------ helpers

function error(
  ctx: Context,
  code: (typeof Codes)[keyof typeof Codes],
  location: Location,
  message: string,
  hints: readonly string[] = [],
  related: readonly { readonly message: string; readonly location: Location }[] = [],
): void {
  ctx.report({
    code,
    severity: 'error',
    message,
    location,
    ...(hints.length === 0 ? {} : { hints }),
    ...(related.length === 0 ? {} : { related }),
  })
}

/** An evaluated object literal (not an array, not a reference). */
function isRecord(value: StaticValue): value is Readonly<Record<string, StaticValue>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Short description of a value for messages. */
export function describe(value: StaticValue): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return 'an array'
  return isRecord(value) ? 'an object' : 'a reference'
}
