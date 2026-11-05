/**
 * `generate` of the `@znight/http` compiler extension: the `metadata.extensions.http` section
 * (README, "Compiler contract"). Controllers are sorted by token, routes keep their source order and
 * every route gets an `invoke(c, ctx)` arrow extracting, coercing and validating its arguments.
 */
import type { ClassRef, GenerateContext, GenInput, GenNode, StaticValue, ValueRef } from '@znight/compiler'
import type {
  CoercionPlan,
  CustomParamData,
  HttpControllerData,
  HttpParamData,
  HttpRouteData,
  MetaEntry,
  ParamCoercion,
  SseRouteData,
  UploadData,
} from './model.ts'

import { compareStrings } from '../path.ts'
import { HTTP_PACKAGE } from './model.ts'
import { isValueRef } from './route-decorators.ts'

type Context = GenerateContext<HttpControllerData>

/** `uploads` helper by kind and presence (`@UploadedFile` / `@UploadedFiles`, required or not). */
const UPLOAD_HELPERS = {
  file: { required: 'file', optional: 'optionalFile' },
  files: { required: 'files', optional: 'optionalFiles' },
} as const

/** Imports of `@znight/http` helpers, created on first use (the generated module has no unused import). */
interface Helpers {
  coerce(): GenNode
  validate(): GenNode
  isThenable(): GenNode
  uploads(): GenNode
  context(): GenNode
  paramFunctionOf(): GenNode
  /** The resolver instances of the route being generated (`x`), with the index of each token. */
  readonly resolvers?: { readonly x: GenNode; readonly index: ReadonlyMap<string, number> }
}

/** Generates `metadata.extensions.http` (`undefined` when the application has no controller). */
export function generateHttp(ctx: Context): GenNode | undefined {
  if (ctx.stored.length === 0) {
    return undefined
  }
  const controllers = [...ctx.stored].sort((a, b) => compareStrings(a.token, b.token))
  const helpers = createHelpers(ctx)
  const entries: [string, GenInput][] = [
    ['controllers', ctx.arr(controllers.map(controller => controllerNode(ctx, helpers, controller)))],
  ]
  const groups = groupsNode(ctx, controllers)
  if (groups !== undefined) {
    entries.push(['groups', groups])
  }
  return ctx.obj(entries)
}

/**
 * `groups`: the route decorator groups the runtime needs (required, holding several keys, or named
 * differently from their key), sorted, with sorted keys; `undefined` when there is none, so that
 * applications without groups keep a byte-identical output.
 */
function groupsNode(ctx: Context, controllers: readonly HttpControllerData[]): GenNode | undefined {
  const groups = new Map<string, { readonly keys: Set<string>; required: boolean }>()
  const visit = (entries: readonly MetaEntry[]): void => {
    for (const entry of entries) {
      const group = groups.get(entry.group)
      if (group === undefined) {
        groups.set(entry.group, { keys: new Set([entry.key]), required: entry.required })
      } else {
        group.keys.add(entry.key)
        group.required ||= entry.required
      }
    }
  }
  for (const controller of controllers) {
    visit(controller.meta)
    for (const route of controller.routes) {
      visit(route.meta)
    }
  }
  const needed = [...groups]
    .filter(([name, group]) => group.required || group.keys.size > 1 || !group.keys.has(name))
    .sort(([a], [b]) => compareStrings(a, b))
  if (needed.length === 0) {
    return undefined
  }
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

function createHelpers(ctx: Context): Helpers {
  let coerce: GenNode | undefined
  let validate: GenNode | undefined
  let isThenable: GenNode | undefined
  let uploads: GenNode | undefined
  let context: GenNode | undefined
  let paramFunctionOf: GenNode | undefined
  return {
    coerce: () => {
      coerce ??= ctx.importFrom(HTTP_PACKAGE, 'coerce')
      return coerce
    },
    validate: () => {
      validate ??= ctx.importFrom(HTTP_PACKAGE, 'validate')
      return validate
    },
    isThenable: () => {
      isThenable ??= ctx.importFrom(HTTP_PACKAGE, 'isThenable')
      return isThenable
    },
    uploads: () => {
      uploads ??= ctx.importFrom(HTTP_PACKAGE, 'uploads')
      return uploads
    },
    context: () => {
      context ??= ctx.importFrom(HTTP_PACKAGE, 'HttpContext', { type: true })
      return context
    },
    paramFunctionOf: () => {
      paramFunctionOf ??= ctx.importFrom('@znight/core', 'ParamFunctionOf', { type: true })
      return paramFunctionOf
    },
  }
}

function controllerNode(ctx: Context, helpers: Helpers, controller: HttpControllerData): GenNode {
  return ctx.obj([
    ['token', controller.token],
    ['basePath', controller.basePath],
    ['guards', tokens(ctx, controller.guards)],
    ['interceptors', tokens(ctx, controller.interceptors)],
    ['meta', metaNode(ctx, controller.meta)],
    ['routes', ctx.arr(controller.routes.map(route => routeNode(ctx, helpers, controller, route)))],
  ])
}

function routeNode(ctx: Context, helpers: Helpers, controller: HttpControllerData, route: HttpRouteData): GenNode {
  const entries: [string, GenInput][] = [
    ['method', route.method],
    ['path', route.path],
    ['fullPath', route.fullPath],
    ['handler', route.handler],
  ]
  if (route.status !== undefined) {
    entries.push(['status', route.status])
  }
  if (route.headers.length > 0) {
    entries.push(['headers', ctx.obj(route.headers.map(([name, value]) => [name, value] as const))])
  }
  entries.push(
    ['meta', metaNode(ctx, route.meta)],
    ['guards', tokens(ctx, route.guards)],
    ['interceptors', tokens(ctx, route.interceptors)],
    ['params', ctx.arr(route.params.map(param => paramNode(ctx, param)))],
  )
  if (route.bodyLimit !== undefined) {
    entries.push(['bodyLimit', route.bodyLimit])
  }
  const uploads = route.params.flatMap(param => (param.upload === undefined ? [] : [param.upload]))
  if (uploads.length > 0) {
    entries.push(['uploads', ctx.arr(uploads.map(upload => uploadNode(ctx, upload)))])
  }
  if (route.rawResponse) {
    entries.push(['rawResponse', true])
  }
  if (route.sse !== undefined) {
    entries.push(['sse', sseNode(ctx, route.sse)])
  }
  const resolvers = paramResolvers(route)
  if (resolvers.length > 0) {
    entries.push(['paramResolvers', tokens(ctx, resolvers)])
  }
  entries.push(['invoke', invokeNode(ctx, helpers, controller, route, resolvers)])
  return ctx.obj(entries)
}

/** `{ heartbeat?, retry?, maxDuration? }` (`{}` without options). */
function sseNode(ctx: Context, sse: SseRouteData): GenNode {
  const entries: [string, GenInput][] = []
  if (sse.heartbeat !== undefined) {
    entries.push(['heartbeat', sse.heartbeat])
  }
  if (sse.retry !== undefined) {
    entries.push(['retry', sse.retry])
  }
  if (sse.maxDuration !== undefined) {
    entries.push(['maxDuration', sse.maxDuration])
  }
  return ctx.obj(entries)
}

function paramNode(ctx: Context, param: HttpParamData): GenNode {
  const entries: [string, GenInput][] = [
    ['index', param.index],
    ['source', param.source],
  ]
  if (param.key !== undefined) {
    entries.push(['name', param.key])
  }
  if (param.type !== undefined) {
    entries.push(['type', param.type])
  }
  if (param.optional) {
    entries.push(['optional', true])
  }
  if (param.schema !== undefined) {
    entries.push(['schema', true])
  }
  return ctx.obj(entries)
}

/** `{ field?, multiple?, required?, maxSize?, maxFiles?, mimeTypes? }` (absent values omitted). */
function uploadNode(ctx: Context, upload: UploadData): GenNode {
  const entries: [string, GenInput][] = []
  if (upload.field !== undefined) {
    entries.push(['field', upload.field])
  }
  if (upload.multiple) {
    entries.push(['multiple', true])
  }
  if (upload.required) {
    entries.push(['required', true])
  }
  if (upload.maxSize !== undefined) {
    entries.push(['maxSize', upload.maxSize])
  }
  if (upload.maxFiles !== undefined) {
    entries.push(['maxFiles', upload.maxFiles])
  }
  if (upload.mimeTypes !== undefined) {
    entries.push(['mimeTypes', ctx.lit(upload.mimeTypes)])
  }
  return ctx.obj(entries)
}

function metaNode(ctx: Context, meta: readonly MetaEntry[]): GenNode {
  return ctx.obj(meta.map(entry => [entry.key, ctx.lit(entry.value)] as const))
}

function tokens(ctx: Context, refs: readonly ClassRef[]): GenNode {
  return ctx.arr(refs.map(ref => ctx.tokenOf(ref) ?? ref.token))
}

// -------------------------------------------------------------------------------------------------
// invoke
// -------------------------------------------------------------------------------------------------

/**
 * `(c: Controller, ctx: HttpContext) => c.handler(...args)`, synchronous when no argument is
 * validated with a schema. A route validating arguments gets a block that stays synchronous as long
 * as every `validate()` returns a value (see {@link validatingBlock}). `@Validate(S)` without
 * `@Body()` parameter reads the body in `invoke`: that arrow is `async` and `await`s every
 * `validate()`.
 */
function invokeNode(
  ctx: Context,
  helpers: Helpers,
  controller: HttpControllerData,
  route: HttpRouteData,
  resolvers: readonly ClassRef[],
): GenNode {
  const params: [string, GenNode][] = [['c', ctx.importType(controller.identity)]]
  // `ctx` is declared only when used (generated code type-checks with `noUnusedParameters`)
  if (route.params.length > 0 || route.bodySchema !== undefined) {
    params.push(['ctx', helpers.context()])
  }
  // `x`: the instances of the parameter resolvers (RFC 0010), only for routes that have some
  if (resolvers.length > 0) {
    const tuple = resolvers.map(ref => ctx.importType(ref))
    params.push(['x', ctx.code`readonly [${joinNodes(ctx, tuple)}]`])
    const index = new Map(resolvers.map((ref, position) => [ref.token, position]))
    const withResolvers = (x: GenNode | undefined): Helpers =>
      x === undefined ? helpers : { ...helpers, resolvers: { x, index } }
    return invokeArrow(ctx, params, route, (c, http, x) => [c, http, withResolvers(x)])
  }
  return invokeArrow(ctx, params, route, (c, http) => [c, http, helpers])
}

/** The provider classes resolving custom parameters, in order of first use (`x[i]`). */
function paramResolvers(route: HttpRouteData): ClassRef[] {
  const found = new Map<string, ClassRef>()
  for (const param of route.params) {
    const resolver = param.custom?.resolver
    if (resolver !== undefined && !found.has(resolver.token)) {
      found.set(resolver.token, resolver)
    }
  }
  return [...found.values()]
}

/** `a, b, c`. */
function joinNodes(ctx: Context, nodes: readonly GenNode[]): GenNode {
  return nodes.slice(1).reduce((joined, node) => ctx.code`${joined}, ${node}`, nodes[0] as GenNode)
}

/** The arrow of {@link invokeNode}; `bind` maps the arrow parameters to the controller, the context and the helpers. */
function invokeArrow(
  ctx: Context,
  params: readonly [string, GenNode][],
  route: HttpRouteData,
  bind: (...params: GenNode[]) => readonly [GenNode, GenNode | undefined, Helpers],
): GenNode {
  // arguments in evaluation order (handler parameter order); a hole is passed as `undefined`
  const slots: (HttpParamData | undefined)[] = []
  for (const param of route.params) {
    slots[param.index] = param
  }
  const bodySchema = route.bodySchema
  if (bodySchema !== undefined) {
    return ctx.arrow(
      params,
      (...bound) => {
        const [c, http, helpers] = bind(...bound)
        const call = handlerCall(
          ctx,
          c,
          route,
          Array.from(slots, param => awaitedArgument(ctx, helpers, http as GenNode, param)),
        )
        // @Validate(S) without @Body() parameter: the body is validated (and discarded)
        const body = ctx.code`await ${ctx.call(ctx.member(http as GenNode, 'parseBody'))}`
        const check = ctx.code`await ${validation(ctx, helpers, bodySchema, body, 'body')}`
        return ctx.code`{ ${check}; return ${call} }`
      },
      { async: true },
    )
  }
  const last = slots.findLastIndex(param => param !== undefined && isDeferred(param))
  return ctx.arrow(params, (...bound) => {
    const [c, http, helpers] = bind(...bound)
    return last === -1
      ? handlerCall(
          ctx,
          c,
          route,
          Array.from(slots, param => plainArgument(ctx, helpers, http as GenNode, param)),
        )
      : validatingBlock(ctx, helpers, route, slots, last, c, http as GenNode)
  })
}

/**
 * `true` for an argument whose expression may return a thenable: a validation with a schema, or a
 * custom parameter (its resolver may return a promise).
 */
function isDeferred(param: HttpParamData): boolean {
  return param.schema !== undefined || param.custom !== undefined
}

/** `c.handler(args)`. */
function handlerCall(ctx: Context, c: GenNode, route: HttpRouteData, args: readonly GenNode[]): GenNode {
  return ctx.call(ctx.member(c, route.handler), args)
}

/**
 * The body of the `invoke` of a route validating arguments with schemas: the arguments up to the
 * last validated one are evaluated in order into `const`s (`a<index>`), the handler is called with
 * them. `validate()` returns the value when the schema validates synchronously (Zod, Valibot and
 * ArkType without async refinements), so the request needs no promise; when one returns a
 * thenable, the rest runs in an `async` arrow that awaits it, then evaluates the remaining arguments
 * (`await`ing their validations) and calls the handler: the order of evaluation, the error reported
 * when several arguments are invalid and the value received by the handler are those of an `async`
 * `invoke` awaiting every `validate()`.
 *
 * ```ts
 * (c: UserController, ctx: HttpContext) => {
 *   const a0 = coerce.number(ctx.params['id'], 'param "id"')
 *   const a1 = validate(UpdateUser, ctx.body, 'body')
 *   if (isThenable(a1)) return (async () => c.update(a0, await a1, ctx))()
 *   return c.update(a0, a1, ctx)
 * }
 * ```
 */
function validatingBlock(
  ctx: Context,
  helpers: Helpers,
  route: HttpRouteData,
  slots: readonly (HttpParamData | undefined)[],
  last: number,
  c: GenNode,
  http: GenNode,
): GenNode {
  // `@Ctx()` and holes are inlined: nothing to evaluate
  const bound: number[] = []
  for (let index = 0; index <= last; index++) {
    const param = slots[index]
    if (param !== undefined && param.source !== 'context') {
      bound.push(index)
    }
  }
  return ctx.block(
    bound.map(index => `a${index}`),
    (...locals) => {
      const local = new Map(bound.map((index, position) => [index, locals[position] as GenNode]))
      // the value of an argument evaluated before the current statement
      const evaluated = (index: number): GenNode => local.get(index) ?? plainArgument(ctx, helpers, http, slots[index])
      const statements: GenNode[] = []
      for (const index of bound) {
        const param = slots[index] as HttpParamData
        const name = local.get(index) as GenNode
        statements.push(ctx.code`const ${name} = ${plainArgument(ctx, helpers, http, param)}`)
        if (isDeferred(param)) {
          const rest = Array.from(slots, (other, position) => {
            if (position < index) {
              return evaluated(position)
            }
            return position === index ? ctx.code`await ${name}` : awaitedArgument(ctx, helpers, http, other)
          })
          const resume = ctx.arrow([], () => handlerCall(ctx, c, route, rest), { async: true })
          statements.push(ctx.code`if (${ctx.call(helpers.isThenable(), [name])}) return (${resume})()`)
        }
      }
      const args = Array.from(slots, (param, position) =>
        position <= last ? evaluated(position) : plainArgument(ctx, helpers, http, param),
      )
      statements.push(ctx.code`return ${handlerCall(ctx, c, route, args)}`)
      return statements
    },
  )
}

/** An argument evaluated in an `async` arrow: its validation, if any, is `await`ed. */
function awaitedArgument(ctx: Context, helpers: Helpers, http: GenNode, param: HttpParamData | undefined): GenNode {
  const node = plainArgument(ctx, helpers, http, param)
  return param === undefined || !isDeferred(param) ? node : ctx.code`await ${node}`
}

/** An argument as an expression (`validate()` not awaited); `undefined` for a hole. */
function plainArgument(ctx: Context, helpers: Helpers, http: GenNode, param: HttpParamData | undefined): GenNode {
  return param === undefined ? ctx.lit(undefined) : argumentNode(ctx, helpers, http, param)
}

/** The expression passed to the handler for one parameter. */
function argumentNode(ctx: Context, helpers: Helpers, http: GenNode, param: HttpParamData): GenNode {
  switch (param.source) {
    case 'context':
      return http
    case 'request':
      return ctx.code`${ctx.member(http, 'request')} as never`
    case 'response':
      return ctx.code`${ctx.member(http, 'response')} as never`
    case 'body': {
      const body = ctx.member(http, 'body')
      return param.schema === undefined
        ? ctx.code`${body} as never`
        : validation(ctx, helpers, param.schema, body, 'body')
    }
    case 'file':
    case 'files': {
      const upload = param.upload as UploadData
      const helper = UPLOAD_HELPERS[upload.multiple ? 'files' : 'file'][upload.required ? 'required' : 'optional']
      const call = ctx.call(ctx.member(helpers.uploads(), helper), [http, ctx.lit(upload.field)])
      return upload.cast ? ctx.code`${call} as never` : call
    }
    case 'headers':
    case 'param':
    case 'query': {
      const record = ctx.member(http, param.source === 'param' ? 'params' : param.source)
      if (param.key === undefined) {
        const location = param.source === 'param' ? 'params' : param.source
        return param.schema === undefined
          ? ctx.code`${record} as never`
          : validation(ctx, helpers, param.schema, record, location)
      }
      const value = ctx.code`${record}[${param.key}]`
      const label = `${param.source === 'headers' ? 'header' : param.source} "${param.key}"`
      if (param.schema !== undefined) {
        return validation(ctx, helpers, param.schema, value, label)
      }
      return coercion(ctx, helpers, param.coercion ?? { plan: { kind: 'raw' }, cast: false }, value, label)
    }
    case 'cookie':
    case 'signedCookie': {
      if (param.key === undefined) {
        // @Cookie() / @Cookie(S): every cookie
        const cookies = ctx.member(http, 'cookies')
        return param.schema === undefined
          ? ctx.code`${cookies} as never`
          : validation(ctx, helpers, param.schema, cookies, 'cookies')
      }
      const value =
        param.source === 'cookie'
          ? ctx.code`${ctx.member(http, 'cookies')}[${param.key}]`
          : ctx.call(ctx.member(http, 'signedCookie'), [param.key])
      const label = `cookie "${param.key}"`
      if (param.schema !== undefined) {
        return validation(ctx, helpers, param.schema, value, label)
      }
      return coercion(ctx, helpers, param.coercion ?? { plan: { kind: 'raw' }, cast: false }, value, label)
    }
    case 'custom':
      return customArgument(ctx, helpers, http, param.custom as CustomParamData)
  }
}

/**
 * A custom parameter (RFC 0010): `(D.resolvers.http as ParamFunctionOf<typeof D, 'http'>)(ctx, data)`
 * for a function resolver, `x[i].resolve(ctx, data)` for a class resolver; cast with `as never` when
 * the value type could not be checked against the parameter.
 */
function customArgument(ctx: Context, helpers: Helpers, http: GenNode, custom: CustomParamData): GenNode {
  const data = custom.data === undefined ? ctx.lit(undefined) : dataNode(ctx, custom.data.value)
  let call: GenNode
  if (custom.resolver === undefined) {
    const decorator = ctx.importValue(custom.identity)
    const callee = ctx.code`${ctx.member(decorator, 'resolvers', 'http')} as ${helpers.paramFunctionOf()}<typeof ${decorator}, 'http'>`
    call = ctx.call(callee, [http, data])
  } else {
    const resolvers = helpers.resolvers as NonNullable<Helpers['resolvers']>
    const index = resolvers.index.get(custom.resolver.token) as number
    if (custom.arity === undefined) {
      // a `resolve` the compiler cannot read (inherited from a mixin...): the instance is cast to a
      // method taking both arguments (method parameters are bivariant), the value with `as never`
      return ctx.code`(${resolvers.x}[${index}] as { resolve(ctx: unknown, data: unknown): unknown }).resolve(${http}, ${data}) as never`
    }
    // a `resolve(ctx)` that ignores the data gets no data argument (TypeScript checks the arity)
    const args = [http, data].slice(0, custom.arity)
    call = ctx.code`${resolvers.x}[${index}].resolve(${args.length === 0 ? ctx.code`` : joinNodes(ctx, args)})`
  }
  return custom.cast ? ctx.code`${call} as never` : call
}

/** The data argument of a custom parameter: a literal (references imported) or a reference. */
function dataNode(ctx: Context, value: StaticValue): GenNode {
  return isValueRef(value) ? ctx.ref(value) : ctx.lit(value as Parameters<Context['lit']>[0])
}

/** `validate(schema, value, location)` (the value, or a promise when the schema validates asynchronously). */
function validation(ctx: Context, helpers: Helpers, schema: ValueRef, value: GenNode, location: string): GenNode {
  return ctx.call(helpers.validate(), [ctx.ref(schema), value, location])
}

/** `coerce.X(value, label, ...)`, cast with `as never` when the result does not have the declared type. */
function coercion(ctx: Context, helpers: Helpers, coercion: ParamCoercion, value: GenNode, label: string): GenNode {
  const node = coerceCall(ctx, helpers, coercion.plan, value, label)
  return coercion.cast ? ctx.code`${node} as never` : node
}

function coerceCall(ctx: Context, helpers: Helpers, plan: CoercionPlan, value: GenNode, label: GenInput): GenNode {
  const helper = (name: string): GenNode => ctx.member(helpers.coerce(), name)
  switch (plan.kind) {
    case 'raw':
      return ctx.code`${value} as never`
    case 'enum':
      return ctx.call(helper('enum'), [value, label, ctx.lit(plan.values)])
    case 'array':
    case 'optional':
      return ctx.call(helper(plan.kind), [value, label, itemCoercer(ctx, helpers, plan.item)])
    default:
      return ctx.call(helper(plan.kind), [value, label])
  }
}

/** A `Coercer` value: `coerce.number`, or `(v, l) => coerce.enum(v, l, [...])`. */
function itemCoercer(ctx: Context, helpers: Helpers, plan: CoercionPlan): GenNode {
  switch (plan.kind) {
    case 'enum':
    case 'array':
    case 'optional':
      return ctx.arrow(['v', 'l'], (v, l) => coerceCall(ctx, helpers, plan, v, l))
    case 'raw':
      return ctx.arrow(['v'], v => v)
    default:
      return ctx.member(helpers.coerce(), plan.kind)
  }
}
