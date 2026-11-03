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

import type { GenerateContext, GenInput, GenNode, GenParam } from '@znight/compiler'
import type { Token } from '@znight/core'
import type { MetaEntry } from '@znight/http/compiler'
import type { FieldData, GraphQLData, ParamData, ResolverData } from './data.ts'
import type { ArgModel, FieldModel, GraphQLModel, TypeModel } from './model.ts'
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
      return ctx.obj([...head, ['fields', ctx.arr(type.fields.map(field => fieldNode(ctx, imports, field)))]])
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
    case 'union': {
      const discriminator = type.discriminator
      let node: GenNode
      if (discriminator === undefined || discriminator.by === 'typename') node = ctx.obj([['by', 'typename']])
      else if (discriminator.by === 'property') {
        node = ctx.obj([
          ['by', 'property'],
          ['property', discriminator.property],
          ['values', ctx.obj(Object.entries(discriminator.values))],
        ])
      } else {
        node = ctx.obj([
          ['by', 'class'],
          [
            'classes',
            ctx.arr(discriminator.classes.map(entry => ctx.arr([ctx.importValue(entry.identity), entry.name]))),
          ],
        ])
      }
      return ctx.obj([...head, ['members', ctx.lit([...type.members])], ['discriminator', node]])
    }
    case 'scalar':
      // built-in scalars carry no description (the runtime builds them, sdl.ts prints them alike);
      // user scalars bring theirs with the imported definition
      return type.definition === undefined
        ? ctx.obj([...head, ['builtin', ctx.lit(true)]])
        : ctx.obj([...head, ['scalar', ctx.importValue(type.definition)]])
  }
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
  entries.push(['invoke', invokeNode(ctx, imports, resolver, field)])
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

/** Which `invoke` parameters a field uses: `(r, p, a, c, i)`. */
function usedParameters(field: FieldData): readonly [p: boolean, a: boolean, c: boolean, i: boolean] {
  let p = false
  let a = false
  let c = false
  let i = false
  for (const param of field.params) {
    switch (param?.kind) {
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
  return [p, a, c, i]
}

/**
 * `(r: Resolver, p: unknown, a: GraphQLArgs, c: GraphQLContext, i: GraphQLResolveInfo) => r.m(...)`:
 * unused middle parameters are `_`-prefixed, trailing ones omitted (`noUnusedParameters`).
 */
function invokeNode(ctx: Context, imports: Imports, resolver: ResolverData, field: FieldData): GenNode {
  const used = usedParameters(field)
  const last = used.lastIndexOf(true)
  const types = [() => ctx.code`unknown`, imports.argsType, imports.contextType, imports.infoType]
  const names = ['p', 'a', 'c', 'i']
  const params: [string, GenNode][] = [['r', imports.hostType(resolver.host.identity)]]
  for (let index = 0; index <= last; index++) {
    params.push([`${used[index] ? '' : '_'}${names[index] as string}`, (types[index] as () => GenNode)()])
  }
  const validated = field.params.flatMap((param, index) =>
    param?.kind === 'args' && param.schema !== undefined ? [index] : [],
  )
  return ctx.arrow(params, (r, ...rest) => {
    const [p, a, c, i] = rest as (GenParam | undefined)[]
    const scope: Scope = { p, a, c, i }
    if (validated.length === 0) return call(ctx, r, field, index => argument(ctx, scope, field, index))
    return validatingBlock(ctx, imports, r, scope, field, validated)
  })
}

/** The parameters of the `invoke` arrow (absent when not declared). */
interface Scope {
  readonly p: GenNode | undefined
  readonly a: GenNode | undefined
  readonly c: GenNode | undefined
  readonly i: GenNode | undefined
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
    default:
      return ctx.lit(undefined)
  }
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
        const param = field.params[index] as Extract<ParamData, { kind: 'args' }>
        statements.push(ctx.code`const ${name} = ${validation(ctx, imports, scope, param)}`)
        const resume = ctx.arrow(
          [],
          () =>
            call(ctx, r, field, position => {
              const value = local.get(position)
              if (value === undefined) return argument(ctx, scope, field, position)
              if (position < index) return ctx.code`${value} as never`
              if (position === index) return ctx.code`await ${value} as never`
              const later = field.params[position] as Extract<ParamData, { kind: 'args' }>
              return ctx.code`await ${validation(ctx, imports, scope, later)} as never`
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
