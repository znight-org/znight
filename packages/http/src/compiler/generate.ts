/**
 * `generate` of the `@znight/http` compiler extension: the `metadata.extensions.http` section
 * (README, "Compiler contract"). Controllers are sorted by token, routes keep their source order and
 * every route gets an `invoke(c, ctx)` arrow extracting, coercing and validating its arguments.
 */
import type { ClassRef, GenerateContext, GenInput, GenNode, ValueRef } from '@znight/compiler'
import type {
  CoercionPlan,
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
  uploads(): GenNode
  context(): GenNode
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
  let uploads: GenNode | undefined
  let context: GenNode | undefined
  return {
    coerce: () => {
      coerce ??= ctx.importFrom(HTTP_PACKAGE, 'coerce')
      return coerce
    },
    validate: () => {
      validate ??= ctx.importFrom(HTTP_PACKAGE, 'validate')
      return validate
    },
    uploads: () => {
      uploads ??= ctx.importFrom(HTTP_PACKAGE, 'uploads')
      return uploads
    },
    context: () => {
      context ??= ctx.importFrom(HTTP_PACKAGE, 'HttpContext', { type: true })
      return context
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
  entries.push(['invoke', invokeNode(ctx, helpers, controller, route)])
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
 * `(c: Controller, ctx: HttpContext) => c.handler(...args)`: `async` (awaiting every `validate()`)
 * when the route validates something with a schema, synchronous otherwise.
 */
function invokeNode(ctx: Context, helpers: Helpers, controller: HttpControllerData, route: HttpRouteData): GenNode {
  const async = route.bodySchema !== undefined || route.params.some(param => param.schema !== undefined)
  const params: [string, GenNode][] = [['c', ctx.importType(controller.identity)]]
  // `ctx` is declared only when used (generated code type-checks with `noUnusedParameters`)
  if (route.params.length > 0 || route.bodySchema !== undefined) {
    params.push(['ctx', helpers.context()])
  }
  return ctx.arrow(
    params,
    (c, http) => {
      const args: GenNode[] = []
      for (const param of route.params) {
        args[param.index] = argumentNode(ctx, helpers, http as GenNode, param)
      }
      const call = ctx.call(
        ctx.member(c, route.handler),
        Array.from(args, arg => arg ?? ctx.lit(undefined)),
      )
      if (route.bodySchema === undefined) {
        return call
      }
      // @Validate(S) without @Body() parameter: the body is validated (and discarded)
      const body = ctx.code`await ${ctx.call(ctx.member(http as GenNode, 'parseBody'))}`
      const check = validation(ctx, helpers, route.bodySchema, body, 'body')
      return ctx.code`{ ${check}; return ${call} }`
    },
    { async },
  )
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
  }
}

/** `await validate(schema, value, location)`. */
function validation(ctx: Context, helpers: Helpers, schema: ValueRef, value: GenNode, location: string): GenNode {
  return ctx.code`await ${ctx.call(helpers.validate(), [ctx.ref(schema), value, location])}`
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
