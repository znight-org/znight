/**
 * `generate` of the graphql extension (RFC 0005 §7.1, §7.3): `metadata.extensions.graphql` from the
 * model `validate` built, and the SDL artifact when the extension is configured with `{ sdl }`.
 *
 * Data, not code, except `invoke`: one arrow per resolver field mapping the graphql-js arguments to
 * the method parameters. It is synchronous unless an argument is validated with a Standard Schema
 * whose validation turns out asynchronous: like the `invoke` of `@znight/http` routes, a
 * synchronous validation (Zod, Valibot, ArkType without async refinements) costs no promise.
 *
 * ```ts
 * ['invoke']: (r: BookResolver, p: unknown, _a: GraphQLArgs, c: GraphQLContext) =>
 *   r.author(p as never, c.loader('src/authors-by-id.loader.ts#AuthorsById') as never),
 * ```
 */

import type { ClassRef, GenerateContext, GenInput, GenNode, GenParam, StaticValue, ValueRef } from '@znight/compiler'
import type { Token } from '@znight/core'
import type { MetaEntry } from '@znight/http/compiler'
import type { FieldData, GraphQLData, ParamData, ResolverData } from './data.ts'
import type { ArgModel, DiscriminatorModel, FieldModel, GraphQLModel, TypeModel } from './model.ts'
import type { ResolvedGraphQLCompilerOptions } from './options.ts'

import { GRAPHQL_METADATA_VERSION } from '../metadata.ts'
import { compareStrings } from './constants.ts'
import { RUNTIME_MODULE } from './ids.ts'

type Context = GenerateContext<GraphQLData>

/** Module of `isThenable` (a required peer of `@znight/graphql`). */
const HTTP_MODULE = '@znight/http'

/** Imports created on first use: an unused import would break `noUnusedLocals`. */
interface Imports {
  argsType(): GenNode
  contextType(): GenNode
  infoType(): GenNode
  resolverContextType(): GenNode
  paramFunctionOf(): GenNode
  validateArgs(): GenNode
  isThenable(): GenNode
  hostType(identity: string): GenNode
}

/** Builds the graphql section; `undefined` (no section) when the application has no resolver. */
export function generateGraphQL(
  ctx: Context,
  model: GraphQLModel | undefined,
  options: ResolvedGraphQLCompilerOptions,
): GenNode | undefined {
  if (model === undefined) return undefined
  if (options.sdl !== false) ctx.emitFile(options.sdl, `${model.sdl}\n`)
  const imports = createImports(ctx)
  const entries: [string, GenInput][] = [
    ['version', ctx.lit(GRAPHQL_METADATA_VERSION)],
    ['schemaHash', model.schemaHash],
    ['roots', ctx.obj(Object.entries(model.roots))],
    ['types', ctx.arr(model.types.map(type => typeNode(ctx, imports, type)))],
  ]
  const groups = groupsNode(ctx, model.meta)
  if (groups !== undefined) entries.push(['groups', groups])
  return ctx.obj(entries)
}

function createImports(ctx: Context): Imports {
  let args: GenNode | undefined
  let context: GenNode | undefined
  let info: GenNode | undefined
  let resolverContext: GenNode | undefined
  let paramFunctionOf: GenNode | undefined
  let validateArgs: GenNode | undefined
  let isThenable: GenNode | undefined
  const hosts = new Map<string, GenNode>()
  return {
    argsType: () => {
      args ??= ctx.importFrom(RUNTIME_MODULE, 'GraphQLArgs', { type: true })
      return args
    },
    contextType: () => {
      context ??= ctx.importFrom(RUNTIME_MODULE, 'GraphQLContext', { type: true })
      return context
    },
    infoType: () => {
      info ??= ctx.importFrom('graphql', 'GraphQLResolveInfo', { type: true })
      return info
    },
    resolverContextType: () => {
      resolverContext ??= ctx.importFrom(RUNTIME_MODULE, 'ResolverContext', { type: true })
      return resolverContext
    },
    paramFunctionOf: () => {
      paramFunctionOf ??= ctx.importFrom('@znight/core', 'ParamFunctionOf', { type: true })
      return paramFunctionOf
    },
    validateArgs: () => {
      validateArgs ??= ctx.importFrom(RUNTIME_MODULE, 'validateArgs')
      return validateArgs
    },
    isThenable: () => {
      isThenable ??= ctx.importFrom(HTTP_MODULE, 'isThenable')
      return isThenable
    },
    hostType: identity => {
      let node = hosts.get(identity)
      if (node === undefined) {
        node = ctx.importType(identity)
        hosts.set(identity, node)
      }
      return node
    },
  }
}

function typeNode(ctx: Context, imports: Imports, type: TypeModel): GenNode {
  const head: [string, GenInput][] = [
    ['kind', type.kind],
    ['name', type.name],
  ]
  if (type.description !== undefined && type.kind !== 'scalar') head.push(['description', type.description])
  switch (type.kind) {
    case 'object':
    case 'interface': {
      const entries: [string, GenInput][] = [...head]
      if (type.interfaces.length > 0) entries.push(['interfaces', ctx.lit([...type.interfaces])])
      entries.push(['fields', ctx.arr(type.fields.map(field => fieldNode(ctx, imports, field)))])
      if (type.kind === 'interface') entries.push(['discriminator', discriminatorNode(ctx, type.discriminator)])
      return ctx.obj(entries)
    }
    case 'input':
      return ctx.obj([...head, ['fields', ctx.arr(type.fields.map(field => inputValueNode(ctx, field)))]])
    case 'enum':
      return ctx.obj([
        ...head,
        [
          'values',
          ctx.arr(
            type.values.map(value => {
              const entries: [string, GenInput][] = [
                ['name', value.name],
                ['value', value.value],
              ]
              if (value.description !== undefined) entries.push(['description', value.description])
              if (value.deprecationReason !== undefined) entries.push(['deprecationReason', value.deprecationReason])
              return ctx.obj(entries)
            }),
          ),
        ],
      ])
    case 'union':
      return ctx.obj([
        ...head,
        ['members', ctx.lit([...type.members])],
        ['discriminator', discriminatorNode(ctx, type.discriminator)],
      ])
    case 'scalar': {
      // built-in scalars carry no description (the runtime builds them, sdl.ts prints them alike);
      // code-first user scalars bring theirs with the imported definition, schema-first ones take
      // the SDL's (they win over the definition's)
      if (type.definition === undefined) return ctx.obj([...head, ['builtin', ctx.lit(true)]])
      const entries: [string, GenInput][] = [...head, ['scalar', ctx.importValue(type.definition)]]
      if (type.fromSdl === true) {
        if (type.description !== undefined) entries.push(['description', type.description])
        if (type.specifiedByURL !== undefined) entries.push(['specifiedByURL', type.specifiedByURL])
        entries.push(['sdl', ctx.lit(true)])
      }
      return ctx.obj(entries)
    }
  }
}

/** How the runtime tells the members of a union or the implementations of an interface apart. */
function discriminatorNode(ctx: Context, discriminator: DiscriminatorModel | undefined): GenNode {
  if (discriminator === undefined || discriminator.by === 'typename') return ctx.obj([['by', 'typename']])
  if (discriminator.by === 'property') {
    return ctx.obj([
      ['by', 'property'],
      ['property', discriminator.property],
      ['values', ctx.obj(Object.entries(discriminator.values))],
    ])
  }
  return ctx.obj([
    ['by', 'class'],
    ['classes', ctx.arr(discriminator.classes.map(entry => ctx.arr([ctx.importValue(entry.identity), entry.name])))],
  ])
}

function fieldNode(ctx: Context, imports: Imports, field: FieldModel): GenNode {
  const entries: [string, GenInput][] = [
    ['name', field.name],
    ['type', field.type],
  ]
  if (field.description !== undefined) entries.push(['description', field.description])
  if (field.deprecationReason !== undefined) entries.push(['deprecationReason', field.deprecationReason])
  if (field.args.length > 0) entries.push(['args', ctx.arr(field.args.map(arg => inputValueNode(ctx, arg)))])
  if (field.binding !== undefined) {
    entries.push(['resolver', resolverNode(ctx, imports, field.binding.resolver, field.binding.field)])
  }
  return ctx.obj(entries)
}

function inputValueNode(ctx: Context, arg: ArgModel): GenNode {
  const entries: [string, GenInput][] = [
    ['name', arg.name],
    ['type', arg.type],
  ]
  if (arg.description !== undefined) entries.push(['description', arg.description])
  if (arg.deprecationReason !== undefined) entries.push(['deprecationReason', arg.deprecationReason])
  if (arg.defaultValue !== undefined) entries.push(['defaultValue', ctx.lit(arg.defaultValue as never)])
  if (arg.nullAsUndefined) entries.push(['nullAsUndefined', ctx.lit(true)])
  return ctx.obj(entries)
}

function resolverNode(ctx: Context, imports: Imports, resolver: ResolverData, field: FieldData): GenNode {
  const guards = [...resolver.guards, ...field.guards].map(ref => ctx.tokenOf(ref) ?? ref.token)
  const entries: [string, GenInput][] = [
    ['token', ctx.tokenOf(resolver.host) ?? resolver.host.identity],
    ['method', field.method],
    ['operation', field.operation],
    ['guards', ctx.lit(guards)],
    ['meta', ctx.obj(field.meta.map(entry => [entry.key, ctx.lit(entry.value as never)] as const))],
  ]
  const loaders = field.params.flatMap(param => (param?.kind === 'loader' ? [loaderToken(ctx, param)] : []))
  if (loaders.length > 0) entries.push(['loaders', ctx.lit(loaders)])
  // custom parameters (RFC 0010): the pipeline builds the ResolverContext and resolves the class resolvers
  const resolvers = paramResolvers(field)
  if (field.params.some(param => param?.kind === 'custom')) entries.push(['context', ctx.lit(true)])
  if (resolvers.length > 0) {
    entries.push(['paramResolvers', ctx.lit(resolvers.map(ref => ctx.tokenOf(ref) ?? ref.token))])
  }
  entries.push(['invoke', invokeNode(ctx, imports, resolver, field, resolvers)])
  return ctx.obj(entries)
}

/** The provider token a loader parameter is bound to. */
function loaderToken(ctx: Context, param: Extract<ParamData, { kind: 'loader' }>): Token {
  const ref = ctx.binding(param.binding)
  if (typeof ref === 'string') return ref
  if (ref !== undefined && 'token' in ref) return ref.token
  return param.identity
}

// ------------------------------------------------------------------------------------------- invoke

/** The provider classes resolving custom parameters, in order of first use (`x[i]`). */
function paramResolvers(field: FieldData): ClassRef[] {
  const found = new Map<string, ClassRef>()
  for (const param of field.params) {
    const resolver = param?.kind === 'custom' ? param.resolver : undefined
    if (resolver !== undefined && !found.has(resolver.token)) found.set(resolver.token, resolver)
  }
  return [...found.values()]
}

/** Which `invoke` parameters a field uses: `(r, p, a, c, i, f, x)`. */
function usedParameters(field: FieldData): readonly boolean[] {
  let p = false
  let a = false
  let c = false
  let i = false
  let f = false
  let x = false
  for (const param of field.params) {
    switch (param?.kind) {
      case 'custom':
        f = true
        x ||= param.resolver !== undefined
        break
      case 'parent':
        p = true
        break
      case 'args':
        a = true
        break
      case 'ctx':
      case 'loader':
        c = true
        break
      case 'info':
        i = true
        break
    }
  }
  return [p, a, c, i, f, x]
}

/**
 * `(r: Resolver, p: unknown, a: GraphQLArgs, c: GraphQLContext, i: GraphQLResolveInfo) => r.m(...)`:
 * unused middle parameters are `_`-prefixed, trailing ones omitted (`noUnusedParameters`).
 */
function invokeNode(
  ctx: Context,
  imports: Imports,
  resolver: ResolverData,
  field: FieldData,
  resolvers: readonly ClassRef[],
): GenNode {
  const used = usedParameters(field)
  const last = used.lastIndexOf(true)
  const types = [
    () => ctx.code`unknown`,
    imports.argsType,
    imports.contextType,
    imports.infoType,
    imports.resolverContextType,
    () =>
      tupleType(
        ctx,
        resolvers.map(ref => ctx.importType(ref)),
      ),
  ]
  const names = ['p', 'a', 'c', 'i', 'f', 'x']
  const params: [string, GenNode][] = [['r', imports.hostType(resolver.host.identity)]]
  for (let index = 0; index <= last; index++) {
    params.push([`${used[index] ? '' : '_'}${names[index] as string}`, (types[index] as () => GenNode)()])
  }
  const deferred = field.params.flatMap((param, index) => (param !== undefined && isDeferred(param) ? [index] : []))
  const positions = new Map(resolvers.map((ref, position) => [ref.token, position]))
  return ctx.arrow(params, (r, ...rest) => {
    const [p, a, c, i, f, x] = rest as (GenParam | undefined)[]
    const scope: Scope = { p, a, c, i, f, x, resolvers: positions, imports }
    if (deferred.length === 0) return call(ctx, r, field, index => argument(ctx, scope, field, index))
    return validatingBlock(ctx, imports, r, scope, field, deferred)
  })
}

/** `readonly [A, B]`. */
function tupleType(ctx: Context, nodes: readonly GenNode[]): GenNode {
  const joined = nodes.slice(1).reduce((all, node) => ctx.code`${all}, ${node}`, nodes[0] as GenNode)
  return ctx.code`readonly [${joined}]`
}

/** An argument whose expression may return a thenable: a validated `@Args`, or a custom parameter. */
function isDeferred(param: ParamData): boolean {
  return (param.kind === 'args' && param.schema !== undefined) || param.kind === 'custom'
}

/** The parameters of the `invoke` arrow (absent when not declared). */
interface Scope {
  readonly p: GenNode | undefined
  readonly a: GenNode | undefined
  readonly c: GenNode | undefined
  readonly i: GenNode | undefined
  /** The `ResolverContext` of custom parameters. */
  readonly f: GenNode | undefined
  /** The class resolver instances (`x[i]`). */
  readonly x: GenNode | undefined
  /** Position of each class resolver token in `x`. */
  readonly resolvers: ReadonlyMap<string, number>
  readonly imports: Imports
}

/** `r.method(args)`. */
function call(ctx: Context, r: GenNode, field: FieldData, argumentOf: (index: number) => GenNode): GenNode {
  return ctx.call(
    ctx.member(r, field.method),
    field.params.map((_, index) => argumentOf(index)),
  )
}

/** The expression passed for the parameter `index` (validation not applied). */
function argument(ctx: Context, scope: Scope, field: FieldData, index: number): GenNode {
  const param = field.params[index]
  switch (param?.kind) {
    case 'parent':
      return ctx.code`${scope.p as GenNode} as never`
    case 'ctx':
      return scope.c as GenNode
    case 'info':
      return scope.i as GenNode
    case 'loader':
      return ctx.code`${ctx.call(ctx.member(scope.c as GenNode, 'loader'), [loaderToken(ctx, param)])} as never`
    case 'args':
      return ctx.code`${argsValue(ctx, scope, param.name)} as never`
    case 'custom':
      return customArgument(ctx, scope, param)
    default:
      return ctx.lit(undefined)
  }
}

/**
 * A custom parameter (RFC 0010): `(D.resolvers.graphql as ParamFunctionOf<typeof D, 'graphql'>)(f, data)`
 * or `x[i].resolve(f, data)`, cast with `as never` when the value type could not be checked.
 */
function customArgument(ctx: Context, scope: Scope, param: Extract<ParamData, { kind: 'custom' }>): GenNode {
  const f = scope.f as GenNode
  const data = param.data === undefined ? ctx.lit(undefined) : dataNode(ctx, param.data.value)
  let node: GenNode
  if (param.resolver === undefined) {
    const decorator = ctx.importValue(param.identity)
    const type = ctx.code`${scope.imports.paramFunctionOf()}<typeof ${decorator}, 'graphql'>`
    node = ctx.call(ctx.code`${ctx.member(decorator, 'resolvers', 'graphql')} as ${type}`, [f, data])
  } else {
    const position = scope.resolvers.get(param.resolver.token) as number
    if (param.arity === undefined) {
      // a `resolve` the compiler cannot read (inherited from a mixin...): the instance is cast to a
      // method taking both arguments (method parameters are bivariant), the value with `as never`
      return ctx.code`(${scope.x as GenNode}[${position}] as { resolve(ctx: unknown, data: unknown): unknown }).resolve(${f}, ${data}) as never`
    }
    // a `resolve(ctx)` that ignores the data gets no data argument (TypeScript checks the arity)
    const arity = Math.min(param.arity, 2)
    let args = ctx.code``
    if (arity === 1) args = f
    else if (arity === 2) args = ctx.code`${f}, ${data}`
    node = ctx.code`${scope.x as GenNode}[${position}].resolve(${args})`
  }
  return param.cast ? ctx.code`${node} as never` : node
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

/** The expression of a deferred parameter (validation or custom resolver), before any `await`. */
function deferredValue(ctx: Context, imports: Imports, scope: Scope, field: FieldData, index: number): GenNode {
  const param = field.params[index] as ParamData
  return param.kind === 'custom'
    ? customArgument(ctx, scope, param)
    : validation(ctx, imports, scope, param as Extract<ParamData, { kind: 'args' }>)
}

/** `a['name']`, or `a` for `@Args()`. */
function argsValue(ctx: Context, scope: Scope, name: string | undefined): GenNode {
  const a = scope.a as GenNode
  return name === undefined ? a : ctx.code`${a}[${name}]`
}

/** `validateArgs(Schema, a['input'], 'input')`. */
function validation(
  ctx: Context,
  imports: Imports,
  scope: Scope,
  param: Extract<ParamData, { kind: 'args' }>,
): GenNode {
  return ctx.call(imports.validateArgs(), [
    ctx.ref(param.schema as NonNullable<typeof param.schema>),
    argsValue(ctx, scope, param.name),
    param.name ?? 'args',
  ])
}

/**
 * The body of the `invoke` of a field validating arguments: each validation is evaluated in order
 * into a `const`; while they return values the method is called synchronously, the first thenable
 * resumes in an `async` arrow that awaits it and the later validations (the order of evaluation and
 * the error reported first are those of an `async` invoke awaiting every validation).
 *
 * ```ts
 * (r: BookResolver, _p: unknown, a: GraphQLArgs) => {
 *   const v0 = validateArgs(NewBookInput, a['input'], 'input')
 *   if (isThenable(v0)) return (async () => r.addBook(await v0 as never))()
 *   return r.addBook(v0 as never)
 * }
 * ```
 */
function validatingBlock(
  ctx: Context,
  imports: Imports,
  r: GenNode,
  scope: Scope,
  field: FieldData,
  validated: readonly number[],
): GenNode {
  return ctx.block(
    validated.map(index => `v${index}`),
    (...locals) => {
      const local = new Map(validated.map((index, position) => [index, locals[position] as GenNode]))
      const statements: GenNode[] = []
      for (const index of validated) {
        const name = local.get(index) as GenNode
        statements.push(ctx.code`const ${name} = ${deferredValue(ctx, imports, scope, field, index)}`)
        const resume = ctx.arrow(
          [],
          () =>
            call(ctx, r, field, position => {
              const value = local.get(position)
              if (value === undefined) return argument(ctx, scope, field, position)
              if (position < index) return ctx.code`${value} as never`
              if (position === index) return ctx.code`await ${value} as never`
              return ctx.code`await ${deferredValue(ctx, imports, scope, field, position)} as never`
            }),
          { async: true },
        )
        statements.push(ctx.code`if (${ctx.call(imports.isThenable(), [name])}) return (${resume})()`)
      }
      statements.push(
        ctx.code`return ${call(ctx, r, field, position => {
          const value = local.get(position)
          return value === undefined ? argument(ctx, scope, field, position) : ctx.code`${value} as never`
        })}`,
      )
      return statements
    },
  )
}

// ------------------------------------------------------------------------------------------- groups

/**
 * `groups`: the route decorator groups the runtime needs (required, holding several keys, or named
 * differently from their key), sorted; `undefined` when there is none (RFC 0001, as `extensions.http`).
 */
function groupsNode(ctx: Context, meta: readonly MetaEntry[]): GenNode | undefined {
  const groups = new Map<string, { readonly keys: Set<string>; required: boolean }>()
  for (const entry of meta) {
    const group = groups.get(entry.group)
    if (group === undefined) groups.set(entry.group, { keys: new Set([entry.key]), required: entry.required })
    else {
      group.keys.add(entry.key)
      group.required ||= entry.required
    }
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
