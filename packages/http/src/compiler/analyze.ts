/**
 * `analyzeClass` of the `@znight/http` compiler extension: controllers, routes, parameters,
 * guards, interceptors, statuses, headers and route metadata. Everything is checked here except
 * what needs the whole application (paths and duplicate routes, see `validate.ts`).
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
import type { HttpMethod } from '../metadata.ts'
import type {
  HttpControllerData,
  HttpParamData,
  HttpRouteData,
  ParamCoercion,
  SseRouteData,
  UploadData,
} from './model.ts'

import { isMediaTypePattern } from '../mime.ts'
import { joinPaths, normalizePath } from '../path.ts'
import { parseByteSize } from '../size.ts'
import { acceptsUndefined, isRaw, parameterType, planCoercion } from './coercion.ts'
import { Codes, HTTP_PACKAGE, Ids, PARAM_SOURCES, ROUTE_METHODS } from './model.ts'
import { isRouteMetaDecorator, isValueRef, routeMeta } from './route-decorators.ts'

/** Name of the extension (owner of the decorators in `DecoratorInfo.owner`). */
export const EXTENSION_NAME = 'http'

type Context = AnalyzeContext<HttpControllerData>
type Scope = 'singleton' | 'request' | 'transient'

const SCOPES: readonly Scope[] = ['singleton', 'request', 'transient']
/** RFC 9110 token (header names). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Types an upload parameter may have (`File`, `Blob`, arrays of them for `@UploadedFiles`); `true`: cast needed. */
const FILE_TYPES: ReadonlyMap<string, boolean> = new Map([
  ['globalThis#File', false],
  ['globalThis#Blob', false],
  ['node:buffer#File', true],
  ['node:buffer#Blob', true],
])
/** Methods whose requests usually have no body (upload parameters there are a warning). */
const BODYLESS_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['GET', 'HEAD', 'DELETE', 'OPTIONS'])
const UPLOAD_OPTIONS = ['required', 'maxSize', 'maxFiles', 'mimeTypes']
/** Smallest `@Sse` heartbeat and `maxDuration` (ms). */
const MIN_SSE_INTERVAL_MS = 1_000
/** Primitive return types an `@Sse` handler cannot return (`any`, `unknown`, `object`, `never` are accepted). */
const NOT_SSE_SOURCES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'undefined',
  'null',
  'void',
])
/** Values that are fine without schema (`@Body() body: string`, `@Body() bytes: Uint8Array`...). */
const UNVALIDATED_REFERENCES = new Set([
  'globalThis#Uint8Array',
  'globalThis#ArrayBuffer',
  'globalThis#Buffer',
  'globalThis#Blob',
  'globalThis#FormData',
  'node:buffer#Buffer',
  '@znight/http#QueryRecord',
])

/** Analyses a class carrying at least one `@znight/http` decorator. */
export function analyzeHttpClass(cls: ClassInfo, ctx: Context): void {
  const controllers = cls.decorators.filter(decorator => decorator.identity === Ids.Controller)
  const [controller] = controllers
  if (controller === undefined) {
    reportOutsideController(cls, ctx)
    return
  }
  for (const duplicate of controllers.slice(1)) {
    error(ctx, duplicate.location, `@Controller is applied several times to ${cls.displayName}`, [
      'Keep a single @Controller()',
    ])
  }
  const options = controllerOptions(ctx, controller)
  const token = ctx.registerProvider(cls, { scope: options.scope })
  const basePath = normalizePath(options.path)
  const guards = classRefs(ctx, cls, cls.decorators, Ids.UseGuard, 'guard')
  const interceptors = classRefs(ctx, cls, cls.decorators, Ids.UseInterceptor, 'interceptor')
  const meta = routeMeta(ctx, cls, cls.decorators, cls.displayName)
  const bodyLimit = bodyLimitOf(ctx, cls.decorators)
  const routes: HttpRouteData[] = []
  for (const method of cls.methods) {
    routes.push(...analyzeMethod(ctx, cls, method, basePath, bodyLimit))
  }
  ctx.store({
    token,
    identity: cls.identity,
    displayName: cls.displayName,
    rawBasePath: options.path,
    basePath,
    guards,
    interceptors,
    meta,
    routes,
    location: controller.location,
    pathLocation: options.pathLocation,
  })
}

// -------------------------------------------------------------------------------------------------
// Controller
// -------------------------------------------------------------------------------------------------

interface ControllerOptions {
  readonly path: string
  readonly pathLocation: Location
  readonly scope: Scope
}

function controllerOptions(ctx: Context, decorator: DecoratorInfo): ControllerOptions {
  const [arg] = decorator.args
  const defaults: ControllerOptions = { path: '', pathLocation: decorator.location, scope: 'singleton' }
  if (arg === undefined || !arg.evaluated) {
    // missing, or not evaluable (already reported)
    return defaults
  }
  const value = arg.value
  if (typeof value === 'string') {
    return { ...defaults, path: value, pathLocation: arg.location }
  }
  if (!isPlainObject(value)) {
    error(ctx, arg.location, `@Controller expects a path or { path?, scope? }, got ${describe(value)}`, [
      "@Controller('/users') or @Controller({ path: '/users', scope: 'request' })",
    ])
    return defaults
  }
  let { path, scope } = defaults
  for (const [key, option] of Object.entries(value)) {
    if (key === 'path') {
      if (typeof option === 'string') {
        path = option
      } else if (option !== undefined) {
        error(ctx, arg.location, `@Controller: "path" must be a string, got ${describe(option)}`)
      }
    } else if (key === 'scope') {
      if (SCOPES.includes(option as Scope)) {
        scope = option as Scope
      } else if (option !== undefined) {
        error(ctx, arg.location, `@Controller: invalid scope ${describe(option)}`, [
          `Use one of ${SCOPES.map(candidate => `'${candidate}'`).join(', ')}`,
        ])
      }
    } else {
      error(ctx, arg.location, `@Controller: unknown option "${key}"`, ['Options: { path?, scope? }'])
    }
  }
  return { path, pathLocation: arg.location, scope }
}

/**
 * HTTP decorators on a class that is not a controller have no effect. On a class another extension
 * owns (a `@Consumer` of `@znight/messaging`...), adding `@Controller()` is no fix: a class is the
 * provider of a single extension.
 */
function reportOutsideController(cls: ClassInfo, ctx: Context): void {
  const owner = foreignOwner(cls)
  const hint =
    owner === undefined
      ? [`Add @Controller() to ${cls.displayName} (routes are not inherited from base classes)`]
      : [
          `${cls.displayName} is a @${owner.name} class of '${owner.module}': HTTP decorators only apply to @Controller() classes`,
        ]
  const decorators: DecoratorInfo[] = [...cls.decorators]
  for (const method of cls.methods) {
    decorators.push(...method.decorators)
    const handler =
      owner === undefined ? undefined : method.decorators.find(decorator => decorator.owner === owner.decorator.owner)
    if (owner !== undefined && handler !== undefined) {
      reportHandlerParams(ctx, cls, method, owner, handler)
      continue
    }
    for (const param of method.params) {
      decorators.push(...unique(param.decorators))
    }
  }
  for (const decorator of decorators) {
    if (decorator.owner === EXTENSION_NAME && validTarget(decorator)) {
      error(ctx, decorator.location, `@${decorator.name} has no effect: ${cls.displayName} is not a controller`, hint)
    }
  }
}

/**
 * HTTP decorators on the parameters of a handler of the extension owning the class (an `@OnMessage`
 * handler...). That extension reads its handlers' parameters and reports those it cannot read
 * (`Headers` imported from `@znight/http` instead of `@znight/messaging`...): an HTTP decorator is
 * only reported here when the parameter is read through a decorator of that extension, or is
 * optional (left undefined without a word).
 */
function reportHandlerParams(
  ctx: Context,
  cls: ClassInfo,
  method: MethodInfo,
  owner: QualifiedDecorator,
  handler: DecoratorInfo,
): void {
  for (const param of method.params) {
    const read = param.decorators.some(decorator => decorator.owner === owner.decorator.owner)
    if (!read && !param.optional && !param.hasDefault && !param.rest) {
      continue
    }
    for (const decorator of unique(param.decorators)) {
      if (decorator.owner === EXTENSION_NAME && validTarget(decorator)) {
        error(
          ctx,
          decorator.location,
          `@${decorator.name} has no effect on parameter '${param.name}' of ${cls.displayName}.${method.name}: it is an @${handler.name} handler of '${owner.module}'`,
          [`Use the parameter decorators of '${owner.module}', or remove it`],
        )
      }
    }
  }
}

/** A decorator with the module and the export name of its identity (`'@znight/messaging#Consumer'`). */
interface QualifiedDecorator {
  readonly decorator: DecoratorInfo
  readonly module: string
  readonly name: string
}

function qualify(decorator: DecoratorInfo): QualifiedDecorator | undefined {
  const identity = decorator.identity
  const separator = identity?.lastIndexOf('#') ?? -1
  if (identity === undefined || separator <= 0) {
    return undefined
  }
  return { decorator, module: identity.slice(0, separator), name: identity.slice(separator + 1) }
}

/** The class decorator through which another extension owns the class (`@Consumer`...). */
function foreignOwner(cls: ClassInfo): QualifiedDecorator | undefined {
  for (const decorator of cls.decorators) {
    const owner = decorator.owner
    if (owner === undefined || owner === EXTENSION_NAME || owner === 'core' || owner === 'manifest') {
      continue
    }
    const qualified = qualify(decorator)
    if (qualified !== undefined) {
      return qualified
    }
  }
  return undefined
}

/**
 * A parameter decorator named like an HTTP one but imported from another package (`Headers` and
 * `Ctx` of `@znight/messaging`, typically auto-imported).
 */
function foreignParameterDecorator(param: ParameterInfo): QualifiedDecorator | undefined {
  for (const decorator of unique(param.decorators)) {
    const qualified = qualify(decorator)
    if (
      qualified !== undefined &&
      qualified.module !== HTTP_PACKAGE &&
      PARAM_SOURCES.has(`${HTTP_PACKAGE}#${qualified.name}`)
    ) {
      return qualified
    }
  }
  return undefined
}

// -------------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------------

function analyzeMethod(
  ctx: Context,
  cls: ClassInfo,
  method: MethodInfo,
  basePath: string,
  controllerBodyLimit: number | undefined,
): HttpRouteData[] {
  const where = `${cls.displayName}.${method.name}`
  let routeDecorators = method.decorators.filter(decorator => ROUTE_METHODS.has(decorator.identity ?? ''))
  if (routeDecorators.length === 0) {
    reportNotARoute(ctx, method, where)
    return []
  }
  if (!checkHandler(ctx, method, where, routeDecorators[0] as DecoratorInfo)) {
    return []
  }
  const sseDecorator = routeDecorators.find(decorator => decorator.identity === Ids.Sse)
  if (sseDecorator !== undefined) {
    // one handler per event stream: the other route decorators are reported and ignored
    for (const other of routeDecorators) {
      if (other === sseDecorator) {
        continue
      }
      error(
        ctx,
        other.location,
        other.identity === Ids.Sse
          ? `@Sse is applied several times to ${where}`
          : `@${other.name} cannot be combined with @Sse on ${where}`,
        [
          'One handler per event stream: declare other routes on other methods (HttpResponse.sse() serves an event stream from any route)',
        ],
      )
    }
    routeDecorators = [sseDecorator]
  }
  const decorators = method.decorators
  const bodyValidation = validateSchema(ctx, decorators)
  const { params, complete } = analyzeParams(ctx, cls, method, where, bodyValidation)
  let status = httpCode(ctx, decorators)
  let headers = responseHeaders(ctx, decorators)
  const guards = classRefs(ctx, cls, decorators, Ids.UseGuard, 'guard')
  const interceptors = classRefs(ctx, cls, decorators, Ids.UseInterceptor, 'interceptor')
  const meta = routeMeta(ctx, cls, decorators, where)
  const bodySchema =
    bodyValidation !== undefined && !params.some(param => param.source === 'body') ? bodyValidation.schema : undefined
  let rawResponse = params.some(param => param.source === 'response')
  const bodyLimit = bodyLimitOf(ctx, decorators) ?? controllerBodyLimit
  const uploads = checkUploads(ctx, params, where)
  if (sseDecorator !== undefined) {
    checkSseHandler(ctx, method, params, where, bodyValidation)
    status = undefined
    headers = headers.filter(([name]) => name !== 'content-type')
    rawResponse = false
  }

  const routes: HttpRouteData[] = []
  for (const decorator of routeDecorators) {
    const httpMethod = ROUTE_METHODS.get(decorator.identity ?? '') as HttpMethod
    const target = decorator === sseDecorator ? sseArgs(ctx, decorator) : routePath(ctx, decorator)
    if (target === undefined) {
      continue
    }
    const { rawPath, arg } = target
    const path = normalizePath(rawPath)
    if (uploads && BODYLESS_METHODS.has(httpMethod)) {
      ctx.report({
        code: Codes.InvalidDecorator,
        severity: 'warning',
        message: `${where} reads uploaded files but is a ${httpMethod} route: ${httpMethod} requests usually have no body`,
        location: decorator.location,
        hints: ['Upload files with @Post(), @Put() or @Patch()'],
      })
    }
    routes.push({
      method: httpMethod,
      rawPath,
      path,
      fullPath: joinPaths(basePath, path),
      handler: method.name,
      status,
      headers,
      meta,
      guards,
      interceptors,
      params,
      complete,
      bodySchema,
      bodyLimit,
      rawResponse,
      ...(target.sse === undefined ? {} : { sse: target.sse }),
      location: decorator.location,
      pathLocation: arg?.location ?? decorator.location,
    })
  }
  return routes
}

/** The path of a route decorator, its argument and, for `@Sse`, its options. */
interface RouteTarget {
  readonly rawPath: string
  readonly arg: ArgInfo | undefined
  readonly sse?: SseRouteData
}

/** The path argument of a route decorator (`undefined` after an error). */
function routePath(ctx: Context, decorator: DecoratorInfo): RouteTarget | undefined {
  const [arg] = decorator.args
  if (arg === undefined) {
    return { rawPath: '', arg }
  }
  if (!arg.evaluated) {
    return undefined // not evaluable: already reported
  }
  if (typeof arg.value !== 'string') {
    error(ctx, arg.location, `@${decorator.name} expects a path (string), got ${describe(arg.value)}`, [
      `@${decorator.name}('/:id')`,
    ])
    return undefined
  }
  return { rawPath: arg.value, arg }
}

/** `@Sse(path?, options?)` / `@Sse(options)`: the path and the options (`undefined` after an error). */
function sseArgs(ctx: Context, decorator: DecoratorInfo): RouteTarget | undefined {
  const [first, second] = decorator.args
  let pathArg: ArgInfo | undefined
  let options: ArgInfo | undefined
  if (first !== undefined) {
    if (!first.evaluated) {
      return undefined // already reported
    }
    if (typeof first.value === 'string') {
      pathArg = first
      options = second
    } else if (first.value === undefined) {
      options = second
    } else if (isPlainObject(first.value)) {
      if (second !== undefined) {
        error(ctx, second.location, '@Sse(options) takes a single argument', [
          "Put the path first: @Sse('/events', { retry: 5000 })",
        ])
        return undefined
      }
      options = first
    } else {
      error(ctx, first.location, `@Sse expects a path (string) or options, got ${describe(first.value)}`, [
        "@Sse('/events'), @Sse('/events', { heartbeat: 15_000 }) or @Sse({ retry: 5000 })",
      ])
      return undefined
    }
  }
  const sse = sseOptions(ctx, options)
  if (sse === undefined) {
    return undefined
  }
  return { rawPath: typeof pathArg?.value === 'string' ? pathArg.value : '', arg: pathArg, sse }
}

/** The static `{ heartbeat?, retry?, maxDuration? }` of `@Sse` (`undefined` after an error). */
function sseOptions(ctx: Context, arg: ArgInfo | undefined): SseRouteData | undefined {
  if (arg === undefined) {
    return {}
  }
  if (!arg.evaluated) {
    return undefined
  }
  const shape = '{ heartbeat?: number | false, retry?: number, maxDuration?: number }'
  if (arg.value === undefined) {
    return {}
  }
  if (!isPlainObject(arg.value)) {
    error(ctx, arg.location, `@Sse options must be an object ${shape}, got ${describe(arg.value)}`)
    return undefined
  }
  const result: { heartbeat?: number; retry?: number; maxDuration?: number } = {}
  let ok = true
  const invalid = (message: string, hints: readonly string[] = []): void => {
    ok = false
    error(ctx, arg.location, `@Sse: ${message}`, hints)
  }
  const integer = (value: StaticValue, min: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min
  for (const [key, value] of Object.entries(arg.value)) {
    if (value === undefined) {
      continue
    }
    switch (key) {
      case 'heartbeat':
        if (value === false) {
          result.heartbeat = 0
        } else if (integer(value, MIN_SSE_INTERVAL_MS)) {
          result.heartbeat = value
        } else {
          invalid(
            `"heartbeat" must be an integer number of ms ≥ ${MIN_SSE_INTERVAL_MS}, or false, got ${describe(value)}`,
            ['Keep it below the idle timeouts of the proxies and of Bun.serve() (10 s): the default is 8 000'],
          )
        }
        break
      case 'retry':
        if (integer(value, 0)) {
          result.retry = value
        } else {
          invalid(`"retry" must be an integer number of ms ≥ 0, got ${describe(value)}`)
        }
        break
      case 'maxDuration':
        if (integer(value, MIN_SSE_INTERVAL_MS)) {
          result.maxDuration = value
        } else {
          invalid(`"maxDuration" must be an integer number of ms ≥ ${MIN_SSE_INTERVAL_MS}, got ${describe(value)}`)
        }
        break
      default:
        invalid(`unknown option "${key}"`, [`Options: ${shape}`])
    }
  }
  return ok ? result : undefined
}

/**
 * `@Sse` handlers: the plugin writes the stream with status 200 and its own content type, so
 * `@HttpCode`, `@Header('content-type')` and `@Res()` are errors; a body is a warning (EventSource
 * sends `GET` without body); a primitive return type is an error.
 */
function checkSseHandler(
  ctx: Context,
  method: MethodInfo,
  params: readonly HttpParamData[],
  where: string,
  bodyValidation: BodyValidation | undefined,
): void {
  for (const decorator of method.decorators) {
    if (decorator.identity === Ids.HttpCode) {
      error(ctx, decorator.location, `@HttpCode has no effect on @Sse route ${where}: an event stream answers 200`, [
        'Throw an HttpException or return an HttpResponse from the handler for other statuses',
      ])
    } else if (decorator.identity === Ids.Header) {
      const [name] = decorator.args
      if (name?.evaluated === true && typeof name.value === 'string' && name.value.toLowerCase() === 'content-type') {
        error(ctx, decorator.location, `@Header('content-type') has no effect on @Sse route ${where}`, [
          'An event stream is always sent as text/event-stream; charset=utf-8',
        ])
      }
    }
  }
  for (const param of params) {
    if (param.source === 'response') {
      error(ctx, param.location, `@Res() cannot be used on @Sse route ${where}: the plugin writes the event stream`, [
        'Return an AsyncIterable of SseEvent, or use a plain route to write the response yourself',
      ])
    }
  }
  const body = params.find(param => param.source === 'body' || param.upload !== undefined)
  const bodyLocation = body?.location ?? bodyValidation?.decorator.location
  if (bodyLocation !== undefined) {
    ctx.report({
      code: Codes.InvalidDecorator,
      severity: 'warning',
      message: `@Sse route ${where} reads a request body: EventSource sends GET requests without body`,
      location: bodyLocation,
      hints: ['For fetch() clients streaming a POST, use @Post() and return HttpResponse.sse(source)'],
    })
  }
  const returned = method.returnType === undefined ? undefined : ctx.types.awaited(method.returnType)
  if (returned !== undefined && !method.generator) {
    const members = returned.kind === 'union' ? returned.types : [returned]
    const invalid = members.some(
      member => member.kind === 'literal' || (member.kind === 'primitive' && NOT_SSE_SOURCES.has(member.name)),
    )
    if (invalid) {
      error(
        ctx,
        method.location,
        `@Sse handler ${where} returns ${ctx.types.format(returned)}: return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (or an HttpResponse)`,
        ['async events(): Promise<AsyncIterable<SseEvent<T>>> { ...; return channel }'],
      )
    }
  }
}

/** `@BodyLimit(size)` of a class or method, in bytes. */
function bodyLimitOf(ctx: Context, decorators: readonly DecoratorInfo[]): number | undefined {
  const [decorator, ...duplicates] = decorators.filter(candidate => candidate.identity === Ids.BodyLimit)
  for (const duplicate of duplicates) {
    error(ctx, duplicate.location, '@BodyLimit is applied several times', ['Keep a single @BodyLimit(size)'])
  }
  if (decorator === undefined) {
    return undefined
  }
  const [arg] = decorator.args
  if (arg === undefined) {
    error(ctx, decorator.location, '@BodyLimit requires a size', ["@BodyLimit('10mb') or @BodyLimit(10_485_760)"])
    return undefined
  }
  if (!arg.evaluated) {
    return undefined
  }
  const size = parseByteSize(arg.value)
  if (size === undefined) {
    error(ctx, arg.location, `@BodyLimit expects a size in bytes, got ${describe(arg.value)}`, [
      "A non-negative integer (10_485_760), a size with a unit ('10mb', '512kb'; kb = 1024 bytes) or Infinity",
    ])
  }
  return size
}

/**
 * Checks the upload parameters of a handler together (one parameter per field; a parameter without
 * field takes every file and stands alone). Returns whether the handler reads uploaded files.
 */
function checkUploads(ctx: Context, params: readonly HttpParamData[], where: string): boolean {
  const uploads = params.filter(param => param.upload !== undefined)
  uploads.forEach((param, index) => {
    const field = param.upload?.field
    const previous = uploads
      .slice(0, index)
      .find(other => field === undefined || other.upload?.field === undefined || other.upload.field === field)
    if (previous === undefined) {
      return
    }
    ctx.report({
      code: Codes.InvalidDecorator,
      severity: 'error',
      message:
        field !== undefined && previous.upload?.field === field
          ? `The field "${field}" of ${where} is read by several upload parameters`
          : `${where}: an upload parameter without field receives every file of the body and cannot be combined with other upload parameters`,
      location: param.location,
      hints: ['Give each @UploadedFile / @UploadedFiles parameter its own field'],
      related: [{ message: 'Other upload parameter', location: previous.location }],
    })
  })
  return uploads.length > 0
}

/** HTTP method decorators (and parameter decorators) on a method without route decorator. */
function reportNotARoute(ctx: Context, method: MethodInfo, where: string): void {
  const hint = [`Add a route decorator to ${where}: @Get(), @Post(), @Put(), @Patch(), @Delete()...`]
  for (const decorator of method.decorators) {
    if (decorator.owner === EXTENSION_NAME && validTarget(decorator)) {
      error(ctx, decorator.location, `@${decorator.name} has no effect: ${where} is not a route`, hint)
    } else if (isRouteMetaDecorator(ctx, decorator)) {
      ctx.report({
        code: Codes.InvalidDecorator,
        severity: 'warning',
        message: `@${decorator.name} has no effect: ${where} is not a route`,
        location: decorator.location,
        hints: hint,
      })
    }
  }
  for (const param of method.params) {
    for (const decorator of unique(param.decorators)) {
      if (decorator.owner === EXTENSION_NAME && validTarget(decorator)) {
        error(ctx, decorator.location, `@${decorator.name} has no effect: ${where} is not a route`, hint)
      }
    }
  }
}

/** A route handler must be a public, non-static method with a plain name. */
function checkHandler(ctx: Context, method: MethodInfo, where: string, decorator: DecoratorInfo): boolean {
  let problem: string | undefined
  let hint = 'Route handlers are public instance methods'
  if (method.static) {
    problem = `Static method ${where} cannot be a route handler`
  } else if (method.privateName) {
    problem = `#private method ${where} cannot be a route handler`
    hint = 'Use a public method (the generated code calls it from outside the class)'
  } else if (method.visibility !== 'public') {
    problem = `${method.visibility === 'protected' ? 'Protected' : 'Private'} method ${where} cannot be a route handler`
    hint = 'Make the method public (the generated code calls it from outside the class)'
  } else if (method.kind !== 'method') {
    problem = `Accessor ${where} cannot be a route handler`
  } else if (method.computed) {
    problem = `${where} cannot be a route handler: handlers need a plain name (no computed key)`
  }
  if (problem !== undefined) {
    error(ctx, decorator.location, problem, [hint])
    return false
  }
  return true
}

function httpCode(ctx: Context, decorators: readonly DecoratorInfo[]): number | undefined {
  const [decorator, ...duplicates] = decorators.filter(candidate => candidate.identity === Ids.HttpCode)
  for (const duplicate of duplicates) {
    error(ctx, duplicate.location, '@HttpCode is applied several times', ['Keep a single @HttpCode(status)'])
  }
  if (decorator === undefined) {
    return undefined
  }
  const [arg] = decorator.args
  if (arg === undefined) {
    error(ctx, decorator.location, '@HttpCode requires a status', ['@HttpCode(202)'])
    return undefined
  }
  if (!arg.evaluated) {
    return undefined
  }
  const status = arg.value
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    error(ctx, arg.location, `@HttpCode expects an integer status between 100 and 599, got ${describe(status)}`)
    return undefined
  }
  return status
}

function responseHeaders(ctx: Context, decorators: readonly DecoratorInfo[]): (readonly [string, string])[] {
  const headers: (readonly [string, string])[] = []
  const seen = new Map<string, Location>()
  for (const decorator of decorators) {
    if (decorator.identity !== Ids.Header) {
      continue
    }
    const [name, value] = decorator.args
    if (name === undefined || value === undefined) {
      error(ctx, decorator.location, '@Header requires a name and a value', ["@Header('cache-control', 'no-store')"])
      continue
    }
    if (!name.evaluated || !value.evaluated) {
      continue
    }
    if (typeof name.value !== 'string' || !TOKEN.test(name.value)) {
      error(ctx, name.location, `@Header: invalid header name ${describe(name.value)}`, [
        "Header names are tokens: letters, digits and ! # $ % & ' * + - . ^ _ ` | ~",
      ])
      continue
    }
    if (typeof value.value !== 'string' || /[\r\n\0]/.test(value.value)) {
      error(ctx, value.location, `@Header: the value of "${name.value}" must be a string without line breaks`)
      continue
    }
    const lower = name.value.toLowerCase()
    const previous = seen.get(lower)
    if (previous) {
      ctx.report({
        code: Codes.InvalidDecorator,
        severity: 'error',
        message: `@Header: "${lower}" is set several times`,
        location: decorator.location,
        hints: ['Set each response header once (or use ctx.appendHeader() in the handler)'],
        related: [{ message: 'First set here', location: previous }],
      })
      continue
    }
    seen.set(lower, decorator.location)
    headers.push([lower, value.value])
  }
  return headers
}

interface BodyValidation {
  readonly schema: ValueRef
  readonly decorator: DecoratorInfo
}

/** `@Validate(schema)` of a handler. */
function validateSchema(ctx: Context, decorators: readonly DecoratorInfo[]): BodyValidation | undefined {
  const [decorator, ...duplicates] = decorators.filter(candidate => candidate.identity === Ids.Validate)
  for (const duplicate of duplicates) {
    error(ctx, duplicate.location, '@Validate is applied several times', [
      'Keep a single @Validate(schema): compose the validation in the schema',
    ])
  }
  if (decorator === undefined) {
    return undefined
  }
  const [arg] = decorator.args
  if (arg === undefined) {
    error(ctx, decorator.location, '@Validate requires a schema', ['@Validate(CreateUser)'])
    return undefined
  }
  const schema = schemaRef(ctx, arg, '@Validate')
  return schema ? { schema, decorator } : undefined
}

/** Guard / interceptor references of a class or method, bound to provider tokens (in order). */
function classRefs(
  ctx: Context,
  cls: ClassInfo,
  decorators: readonly DecoratorInfo[],
  identity: string,
  role: string,
): ClassRef[] {
  const refs: ClassRef[] = []
  for (const decorator of decorators) {
    if (decorator.identity !== identity) {
      continue
    }
    if (decorator.called && decorator.args.length === 0) {
      error(ctx, decorator.location, `@${decorator.name} requires at least one ${role}`, [
        `@${decorator.name}(My${role === 'guard' ? 'Guard' : 'Interceptor'})`,
      ])
    }
    for (const arg of decorator.args) {
      // binds the class (auto-registered as a singleton when it is not a provider) and declares the
      // controller → guard edge (ZNIGHT003, ZNIGHT019)
      const ref = ctx.resolveClassRef(arg, { from: cls, role })
      if (ref) {
        refs.push(ref)
      }
    }
  }
  return refs
}

// -------------------------------------------------------------------------------------------------
// Parameters
// -------------------------------------------------------------------------------------------------

function analyzeParams(
  ctx: Context,
  cls: ClassInfo,
  method: MethodInfo,
  where: string,
  bodyValidation: BodyValidation | undefined,
): { readonly params: HttpParamData[]; readonly complete: boolean } {
  const params: HttpParamData[] = []
  let complete = true
  for (const param of method.params) {
    const decorators = unique(param.decorators).filter(
      decorator => decorator.owner === EXTENSION_NAME && PARAM_SOURCES.has(decorator.identity ?? ''),
    )
    const [decorator, ...extra] = decorators
    const foreign = decorator === undefined ? foreignParameterDecorator(param) : undefined
    if (foreign !== undefined) {
      error(
        ctx,
        foreign.decorator.location,
        `@${foreign.decorator.name} on parameter '${param.name}' of ${where} is imported from '${foreign.module}': route parameters use ${foreign.name} from '${HTTP_PACKAGE}'`,
        [`Import it from '${HTTP_PACKAGE}': import { ${foreign.name} } from '${HTTP_PACKAGE}'`],
      )
      complete = false
      continue
    }
    if (decorator === undefined) {
      error(ctx, param.location, `Parameter '${param.name}' of ${where} has no HTTP decorator`, [
        'Decorate it with @Param(), @Query(), @Body(), @Headers(), @Cookie(), @SignedCookie(), @UploadedFile(), @UploadedFiles(), @Ctx(), @Req() or @Res()',
      ])
      complete = false
      continue
    }
    for (const other of extra) {
      error(ctx, other.location, `Parameter '${param.name}' of ${where} has several HTTP decorators`, [
        'Keep a single parameter decorator',
      ])
    }
    if (param.rest) {
      error(ctx, decorator.location, `Rest parameter '${param.name}' of ${where} cannot be injected`)
      complete = false
      continue
    }
    const data = analyzeParam(ctx, cls, method, param, decorator, where, bodyValidation)
    if (data) {
      params.push(data)
    } else {
      complete = false
    }
  }
  return { params, complete }
}

function analyzeParam(
  ctx: Context,
  cls: ClassInfo,
  method: MethodInfo,
  param: ParameterInfo,
  decorator: DecoratorInfo,
  where: string,
  bodyValidation: BodyValidation | undefined,
): HttpParamData | undefined {
  const source = PARAM_SOURCES.get(decorator.identity ?? '')
  if (source === undefined) {
    return undefined
  }
  const declared = parameterType(ctx, cls, method, param)
  const defaultValue = staticDefault(param)
  const base: Omit<HttpParamData, 'key' | 'schema' | 'coercion' | 'optional'> = {
    index: param.index,
    name: param.name,
    source,
    type: undefined,
    ...(defaultValue === undefined ? {} : { defaultValue: defaultValue.value }),
    location: decorator.location,
  }
  // the declared type is recorded for coerced values (informational, `params[i].type`)
  const type = declared.type === undefined ? undefined : ctx.types.format(declared.type)
  const plain = (): HttpParamData => ({
    ...base,
    key: undefined,
    optional: false,
    schema: undefined,
    coercion: undefined,
  })

  switch (source) {
    case 'request':
    case 'context':
      return plain()
    case 'response':
      ctx.report({
        code: Codes.InvalidDecorator,
        severity: 'warning',
        message: `@Res() makes ${where} adapter-specific: the handler writes the native response itself`,
        location: decorator.location,
        hints: ['Prefer returning a value, an HttpResponse or a Web Response (portable across adapters)'],
      })
      return plain()
    case 'body': {
      const [arg] = decorator.args
      let schema: ValueRef | undefined
      if (arg !== undefined) {
        schema = schemaRef(ctx, arg, '@Body')
        if (schema === undefined) {
          return undefined
        }
      }
      if (bodyValidation !== undefined) {
        if (schema !== undefined) {
          ctx.report({
            code: Codes.InvalidDecorator,
            severity: 'error',
            message: `The body of ${where} is validated twice: @Validate(${bodyValidation.schema.text}) and @Body(${schema.text})`,
            location: bodyValidation.decorator.location,
            hints: ['Keep one of them: @Validate(S) on the method is the same as @Body(S) on the parameter'],
            related: [{ message: '@Body schema', location: decorator.location }],
          })
          return undefined
        }
        schema = bodyValidation.schema
      }
      if (schema === undefined) {
        checkUnvalidated(ctx, declared.type, decorator, param, where, 'body')
      }
      return { ...base, key: undefined, optional: declared.optional, schema, coercion: undefined }
    }
    case 'file':
    case 'files': {
      const upload = uploadOf(ctx, decorator, param, declared, where, source === 'files')
      return upload === undefined
        ? undefined
        : {
            ...base,
            key: upload.field,
            optional: !upload.required,
            schema: undefined,
            coercion: undefined,
            upload,
          }
    }
    case 'headers': {
      const [arg] = decorator.args
      if (arg === undefined) {
        return plain()
      }
      if (!arg.evaluated) {
        return undefined
      }
      if (typeof arg.value !== 'string' || !TOKEN.test(arg.value)) {
        error(ctx, arg.location, `@Headers: invalid header name ${describe(arg.value)}`, [
          "@Headers('x-api-key'), or @Headers() for every header",
        ])
        return undefined
      }
      const key = arg.value.toLowerCase()
      const coercion = coercionOf(ctx, declared, param, decorator, where, 'headers', key)
      return coercion ? { ...base, key, type, optional: declared.optional, schema: undefined, coercion } : undefined
    }
    case 'param':
    case 'query': {
      const parsed = nameAndSchema(ctx, decorator)
      if (!parsed.ok) {
        return undefined
      }
      const { key, schema } = parsed
      const optional = source === 'query' && declared.optional
      if (schema !== undefined) {
        return { ...base, key, optional, schema, coercion: undefined }
      }
      if (key === undefined) {
        if (source === 'query') {
          checkUnvalidated(ctx, declared.type, decorator, param, where, 'query')
        }
        return { ...base, key, optional: false, schema: undefined, coercion: undefined }
      }
      const coercion = coercionOf(ctx, declared, param, decorator, where, source, key)
      return coercion ? { ...base, key, type, optional, schema: undefined, coercion } : undefined
    }
    case 'cookie':
    case 'signedCookie':
      return cookieParam(ctx, param, decorator, declared, where, base, type)
  }
}

/** `@Cookie(name?, schema?)` / `@SignedCookie(name, schema?)`. */
function cookieParam(
  ctx: Context,
  param: ParameterInfo,
  decorator: DecoratorInfo,
  declared: ReturnType<typeof parameterType>,
  where: string,
  base: Omit<HttpParamData, 'key' | 'schema' | 'coercion' | 'optional'>,
  type: string | undefined,
): HttpParamData | undefined {
  const parsed = nameAndSchema(ctx, decorator)
  if (!parsed.ok) {
    return undefined
  }
  const { key, schema } = parsed
  const name = `@${decorator.name}`
  if (key !== undefined && !TOKEN.test(key)) {
    error(ctx, decorator.args[0]?.location ?? decorator.location, `${name}: invalid cookie name ${describe(key)}`, [
      `Cookie names are tokens (letters, digits and ! # $ % & ' * + - . ^ _ \` | ~): ${name}('session_id')`,
    ])
    return undefined
  }
  if (decorator.identity === Ids.SignedCookie && key === undefined) {
    error(ctx, decorator.location, '@SignedCookie requires a cookie name', ["@SignedCookie('session_id')"])
    return undefined
  }
  const optional = declared.optional
  if (schema !== undefined) {
    return { ...base, key, optional, schema, coercion: undefined }
  }
  if (key === undefined) {
    checkUnvalidated(ctx, declared.type, decorator, param, where, 'cookies')
    return { ...base, key, optional: false, schema: undefined, coercion: undefined }
  }
  const coercion = coercionOf(ctx, declared, param, decorator, where, 'cookie', key)
  return coercion ? { ...base, key, type, optional, schema: undefined, coercion } : undefined
}

/**
 * The statically evaluable default value of a parameter (`page = 1`), without references to
 * exported bindings. `ParameterInfo.initializer` is read defensively (compilers before RFC 0002 C4
 * do not provide it).
 */
function staticDefault(param: ParameterInfo): { readonly value: StaticValue } | undefined {
  const initializer = (param as { readonly initializer?: ArgInfo | undefined }).initializer
  if (initializer === undefined || !initializer.evaluated || initializer.ref !== undefined) {
    return undefined
  }
  const value = initializer.value
  if (value === undefined || hasRef(value)) {
    return undefined
  }
  return { value }
}

function hasRef(value: StaticValue): boolean {
  if (isValueRef(value)) {
    return true
  }
  if (Array.isArray(value)) {
    return value.some(hasRef)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(hasRef)
  }
  return false
}

/** `@UploadedFile(field?, options?)` / `@UploadedFiles(field?, options?)`: field, options and type. */
function uploadOf(
  ctx: Context,
  decorator: DecoratorInfo,
  param: ParameterInfo,
  declared: ReturnType<typeof parameterType>,
  where: string,
  multiple: boolean,
): UploadData | undefined {
  const name = `@${decorator.name}`
  const [first, second] = decorator.args
  let field: string | undefined
  let options: ArgInfo | undefined
  if (first !== undefined) {
    if (!first.evaluated) {
      return undefined // already reported
    }
    if (typeof first.value === 'string') {
      if (first.value === '') {
        error(ctx, first.location, `${name} expects a non-empty field name`, [`${name}('avatar')`])
        return undefined
      }
      field = first.value
      options = second
    } else if (first.value === undefined) {
      options = second
    } else if (isPlainObject(first.value)) {
      if (second !== undefined) {
        error(ctx, second.location, `${name}(options) takes a single argument`, [
          `Put the field first: ${name}('field', { ... })`,
        ])
        return undefined
      }
      options = first
    } else {
      error(ctx, first.location, `${name} expects a field name (string) or options, got ${describe(first.value)}`, [
        `${name}('avatar'), ${name}('avatar', { maxSize: '5mb' }) or ${name}({ maxSize: '5mb' })`,
      ])
      return undefined
    }
  }
  const parsed = uploadOptions(ctx, name, options, multiple)
  if (parsed === undefined) {
    return undefined
  }
  const type = uploadType(ctx, declared.type, multiple)
  if (!type.ok) {
    error(
      ctx,
      param.typeLocation,
      `${name} parameter '${param.name}' of ${where} must be typed ${multiple ? 'File[]' : 'File'}, got ${type.got}`,
      [multiple ? `${param.name}: File[]` : `${param.name}: File (or ${param.name}?: File when optional)`],
    )
    return undefined
  }
  const required = parsed.required ?? !declared.optional
  let cast = type.cast
  if (!multiple && !required) {
    const acceptsMissing =
      declared.type === undefined ||
      param.optional ||
      param.hasDefault ||
      acceptsUndefined(declared.type) ||
      isRaw(ctx.types.stripNullish(declared.type).type)
    if (!acceptsMissing && !declared.optional) {
      error(
        ctx,
        options?.location ?? decorator.location,
        `${name}: '${param.name}' of ${where} is optional ({ required: false }) but typed ${ctx.types.format(declared.type as TypeInfo)}`,
        [`Type it ${param.name}?: File (undefined when no file is sent)`],
      )
      return undefined
    }
    // `File | null` receives undefined
    cast ||= !acceptsMissing
  }
  return {
    field,
    multiple,
    required,
    maxSize: parsed.maxSize,
    maxFiles: parsed.maxFiles,
    mimeTypes: parsed.mimeTypes,
    cast,
  }
}

interface ParsedUploadOptions {
  readonly required: boolean | undefined
  readonly maxSize: number | undefined
  readonly maxFiles: number | undefined
  readonly mimeTypes: readonly string[] | undefined
}

/** The options object of an upload decorator (`undefined` after an error). */
function uploadOptions(
  ctx: Context,
  name: string,
  arg: ArgInfo | undefined,
  multiple: boolean,
): ParsedUploadOptions | undefined {
  const result: { -readonly [K in keyof ParsedUploadOptions]: ParsedUploadOptions[K] } = {
    required: undefined,
    maxSize: undefined,
    maxFiles: undefined,
    mimeTypes: undefined,
  }
  if (arg === undefined) {
    return result
  }
  if (!arg.evaluated) {
    return undefined
  }
  if (arg.value === undefined) {
    return result
  }
  const allowed = multiple ? UPLOAD_OPTIONS : UPLOAD_OPTIONS.filter(option => option !== 'maxFiles')
  const shape = `{ ${allowed.map(option => `${option}?`).join(', ')} }`
  if (!isPlainObject(arg.value)) {
    error(ctx, arg.location, `${name} options must be an object ${shape}, got ${describe(arg.value)}`)
    return undefined
  }
  let ok = true
  const invalid = (message: string, hints: readonly string[] = []): void => {
    ok = false
    error(ctx, arg.location, `${name}: ${message}`, hints)
  }
  for (const [key, value] of Object.entries(arg.value)) {
    if (value === undefined) {
      continue
    }
    switch (key) {
      case 'required':
        if (typeof value === 'boolean') {
          result.required = value
        } else {
          invalid(`"required" must be a boolean, got ${describe(value)}`)
        }
        break
      case 'maxSize': {
        const size = parseByteSize(value)
        if (size === undefined) {
          invalid(`"maxSize" must be a size in bytes, got ${describe(value)}`, [
            "A non-negative integer (5_242_880), a size with a unit ('5mb', '512kb'; kb = 1024 bytes) or Infinity",
          ])
        } else {
          result.maxSize = size
        }
        break
      }
      case 'maxFiles':
        if (!multiple) {
          invalid('"maxFiles" only applies to @UploadedFiles (a single file is expected here)', [
            'Use @UploadedFiles() to receive several files',
          ])
        } else if (value === Number.POSITIVE_INFINITY || (Number.isSafeInteger(value) && (value as number) >= 1)) {
          result.maxFiles = value as number
        } else {
          invalid(`"maxFiles" must be a positive integer, got ${describe(value)}`)
        }
        break
      case 'mimeTypes': {
        const patterns = Array.isArray(value) ? value : undefined
        const wrong = patterns?.filter(pattern => typeof pattern !== 'string' || !isMediaTypePattern(pattern)) ?? []
        if (patterns === undefined || patterns.length === 0) {
          invalid(`"mimeTypes" must be a non-empty array of media types, got ${describe(value)}`, [
            "mimeTypes: ['image/png', 'image/*']",
          ])
        } else if (wrong.length > 0) {
          invalid(`invalid media type ${wrong.map(describe).join(', ')} in "mimeTypes"`, [
            "Use type/subtype, type/* or */* without parameters: 'image/png', 'image/*'",
          ])
        } else {
          result.mimeTypes = patterns as string[]
        }
        break
      }
      default:
        invalid(`unknown option "${key}"`, [`Options: ${shape}`])
    }
  }
  return ok ? result : undefined
}

/** Whether a parameter type can receive uploaded files (and whether the value must be cast). */
function uploadType(
  ctx: Context,
  type: TypeInfo | undefined,
  multiple: boolean,
): { readonly ok: true; readonly cast: boolean } | { readonly ok: false; readonly got: string } {
  if (type === undefined) {
    return { ok: true, cast: false }
  }
  const { type: base } = ctx.types.stripNullish(type)
  if (isRaw(base)) {
    return { ok: true, cast: false }
  }
  let target: TypeInfo | undefined = base
  if (multiple) {
    target = base.kind === 'array' ? base.element : undefined
  }
  if (target !== undefined && isRaw(target)) {
    return { ok: true, cast: false }
  }
  const cast = target?.kind === 'reference' ? FILE_TYPES.get(target.identity) : undefined
  return cast === undefined ? { ok: false, got: ctx.types.format(type) } : { ok: true, cast }
}

/** Name and/or schema of `@Param(name?, schema?)` / `@Query(name?, schema?)`. */
function nameAndSchema(
  ctx: Context,
  decorator: DecoratorInfo,
):
  | { readonly ok: true; readonly key: string | undefined; readonly schema: ValueRef | undefined }
  | { readonly ok: false } {
  const [first, second] = decorator.args
  if (first === undefined) {
    return { ok: true, key: undefined, schema: undefined }
  }
  if (first.error !== undefined) {
    return { ok: false }
  }
  if (first.ref !== undefined) {
    if (second !== undefined) {
      error(ctx, second.location, `@${decorator.name}(schema) takes a single argument`, [
        `Put the name first: @${decorator.name}('name', Schema)`,
      ])
      return { ok: false }
    }
    return { ok: true, key: undefined, schema: first.ref }
  }
  if (typeof first.value !== 'string' || first.value === '') {
    error(
      ctx,
      first.location,
      `@${decorator.name} expects a name (non-empty string) or a schema, got ${describe(first.value)}`,
      [`@${decorator.name}('id'), @${decorator.name}('id', Schema) or @${decorator.name}(Schema)`],
    )
    return { ok: false }
  }
  if (second === undefined) {
    return { ok: true, key: first.value, schema: undefined }
  }
  const schema = schemaRef(ctx, second, `@${decorator.name}`)
  return schema ? { ok: true, key: first.value, schema } : { ok: false }
}

/** A schema argument: a reference to an exported binding. */
function schemaRef(ctx: Context, arg: ArgInfo, what: string): ValueRef | undefined {
  if (arg.error !== undefined) {
    return undefined // already reported
  }
  if (arg.ref === undefined) {
    error(ctx, arg.location, `${what} expects a Standard Schema, got ${describe(arg.value)}`, [
      'Pass a schema declared with `export const Schema = z.object({ ... })` (Zod, Valibot, ArkType...)',
    ])
    return undefined
  }
  const symbol = arg.ref.symbol
  if (symbol.kind === 'declaration' && symbol.declaration.kind === 'class' && !hasStandardSchema(ctx, arg.ref)) {
    ctx.report({
      code: Codes.InvalidDecorator,
      severity: 'warning',
      message: `${what}(${arg.ref.text}): ${arg.ref.name} is a class, not a Standard Schema; the validation fails at runtime`,
      location: arg.location,
      hints: ['Pass a Standard Schema object (Zod, Valibot, ArkType...): classes are not validators'],
    })
  }
  return arg.ref
}

function hasStandardSchema(ctx: Context, ref: ValueRef): boolean {
  const info = ref.identity === undefined ? undefined : ctx.classInfo(ref.identity)
  return (
    info === undefined ||
    info.superClass !== undefined ||
    info.properties.some(property => property.static && property.name === '~standard') ||
    info.methods.some(member => member.static && member.name === '~standard')
  )
}

/** Coercion of a named parameter / query value / header without schema. */
function coercionOf(
  ctx: Context,
  declared: ReturnType<typeof parameterType>,
  param: ParameterInfo,
  decorator: DecoratorInfo,
  where: string,
  source: 'param' | 'query' | 'headers' | 'cookie',
  key: string,
): ParamCoercion | undefined {
  const result = planCoercion(ctx, declared, param, source === 'param')
  const label = `${source === 'headers' ? 'header' : source} "${key}"`
  if (result.ok) {
    if (source === 'query' && declared.type !== undefined && isAny(declared.type)) {
      unvalidated(ctx, decorator, `${label} of ${where} is typed any`)
    }
    return result.coercion
  }
  if (source === 'query') {
    // unvalidated input: the raw value is passed as is
    unvalidated(ctx, decorator, `${label} of ${where}: ${result.reason}`, result.hints)
    return { plan: { kind: 'raw' }, cast: false }
  }
  ctx.report({
    code: Codes.InvalidRoute,
    severity: 'error',
    message: `Invalid ${label} of ${where}: ${result.reason}`,
    location: param.typeLocation,
    hints: [...result.hints],
  })
  return undefined
}

/** ZNIGHT017 for a non-primitive `@Body()` / `@Query()` without schema. */
function checkUnvalidated(
  ctx: Context,
  type: TypeInfo | undefined,
  decorator: DecoratorInfo,
  param: ParameterInfo,
  where: string,
  what: 'body' | 'query' | 'cookies',
): void {
  if (type !== undefined && acceptedWithoutSchema(ctx, type)) {
    return
  }
  const described = type === undefined ? 'untyped' : `typed ${ctx.types.format(type)}`
  unvalidated(ctx, decorator, `the ${what} of ${where} ('${param.name}', ${described}) has no schema`)
}

function unvalidated(ctx: Context, decorator: DecoratorInfo, detail: string, extraHints: readonly string[] = []): void {
  ctx.report({
    code: Codes.UnvalidatedInput,
    severity: ctx.options.strictValidation ? 'error' : 'warning',
    message: `Unvalidated input: ${detail}`,
    location: decorator.location,
    hints: [
      ...extraHints.filter(hint => !hint.startsWith('Or validate')),
      `Validate it with a Standard Schema: ${schemaHint(decorator.name)}`,
      'Or type the parameter as unknown and check it yourself',
    ],
  })
}

function schemaHint(decorator: string): string {
  if (decorator === 'Body') {
    return '@Body(Schema) or @Validate(Schema)'
  }
  if (decorator === 'Cookie') {
    return "@Cookie(Schema) for every cookie, or @Cookie('name', Schema)"
  }
  return `@${decorator}('name', Schema)`
}

function acceptedWithoutSchema(ctx: Context, type: TypeInfo): boolean {
  const { type: base } = ctx.types.stripNullish(type)
  switch (base.kind) {
    case 'primitive':
      return base.name !== 'any' && base.name !== 'object' && base.name !== 'never' && base.name !== 'symbol'
    case 'literal':
      return true
    case 'reference':
      if (UNVALIDATED_REFERENCES.has(base.identity)) {
        return true
      }
      // Record<string, string | string[]> (the shape of ctx.query and of form bodies)
      return (
        base.identity === 'globalThis#Record' &&
        base.typeArgs.length === 2 &&
        isStringLike(base.typeArgs[1] as TypeInfo)
      )
    default:
      return false
  }
}

function isStringLike(type: TypeInfo): boolean {
  switch (type.kind) {
    case 'primitive':
      return type.name === 'string' || type.name === 'undefined' || type.name === 'unknown'
    case 'array':
      return type.element.kind === 'primitive' && type.element.name === 'string'
    case 'union':
      return type.types.every(isStringLike)
    default:
      return false
  }
}

function isAny(type: TypeInfo): boolean {
  return isRaw(type) && type.kind === 'primitive' && type.name === 'any'
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

/**
 * Decorators of a parameter without duplicates (a parameter with a default value may list its
 * decorators twice).
 */
function unique(decorators: readonly DecoratorInfo[]): DecoratorInfo[] {
  const seen = new Set<number>()
  return decorators.filter(decorator => {
    if (seen.has(decorator.location.start)) {
      return false
    }
    seen.add(decorator.location.start)
    return true
  })
}

/** `false` when the decorator is applied to a target it does not support (reported by the core). */
function validTarget(decorator: DecoratorInfo): boolean {
  const identity = decorator.identity ?? ''
  if (ROUTE_METHODS.has(identity)) {
    return decorator.target === 'method'
  }
  if (PARAM_SOURCES.has(identity)) {
    return decorator.target === 'parameter'
  }
  switch (identity) {
    case Ids.Controller:
      return decorator.target === 'class'
    case Ids.UseGuard:
    case Ids.UseInterceptor:
    case Ids.BodyLimit:
      return decorator.target === 'class' || decorator.target === 'method'
    default:
      return decorator.target === 'method'
  }
}

function isPlainObject(value: StaticValue): value is { readonly [key: string]: StaticValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isValueRef(value)
}

function describe(value: StaticValue): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  if (isValueRef(value)) {
    return `a reference to '${value.text}'`
  }
  if (typeof value === 'object') {
    return 'an object'
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  return typeof value === 'bigint' ? `${value}n` : String(value)
}

function error(ctx: Context, location: Location, message: string, hints?: readonly string[]): void {
  ctx.report({ code: Codes.InvalidDecorator, severity: 'error', message, location, ...(hints ? { hints } : {}) })
}
