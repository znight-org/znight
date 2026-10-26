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
import type { HttpControllerData, HttpParamData, HttpRouteData, ParamCoercion } from './model.ts'

import { joinPaths, normalizePath } from '../path.ts'
import { isRaw, parameterType, planCoercion } from './coercion.ts'
import { Codes, Ids, PARAM_SOURCES, ROUTE_METHODS } from './model.ts'
import { isRouteMetaDecorator, isValueRef, routeMeta } from './route-decorators.ts'

/** Name of the extension (owner of the decorators in `DecoratorInfo.owner`). */
export const EXTENSION_NAME = 'http'

type Context = AnalyzeContext<HttpControllerData>
type Scope = 'singleton' | 'request' | 'transient'

const SCOPES: readonly Scope[] = ['singleton', 'request', 'transient']
/** RFC 9110 token (header names). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
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
  const meta = routeMeta(ctx, cls, cls.decorators)
  const routes: HttpRouteData[] = []
  for (const method of cls.methods) {
    routes.push(...analyzeMethod(ctx, cls, method, basePath))
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

/** HTTP decorators on a class that is not a controller have no effect. */
function reportOutsideController(cls: ClassInfo, ctx: Context): void {
  const hint = [`Add @Controller() to ${cls.displayName} (routes are not inherited from base classes)`]
  const decorators: DecoratorInfo[] = [...cls.decorators]
  for (const method of cls.methods) {
    decorators.push(...method.decorators)
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

// -------------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------------

function analyzeMethod(ctx: Context, cls: ClassInfo, method: MethodInfo, basePath: string): HttpRouteData[] {
  const where = `${cls.displayName}.${method.name}`
  const routeDecorators = method.decorators.filter(decorator => ROUTE_METHODS.has(decorator.identity ?? ''))
  if (routeDecorators.length === 0) {
    reportNotARoute(ctx, method, where)
    return []
  }
  if (!checkHandler(ctx, method, where, routeDecorators[0] as DecoratorInfo)) {
    return []
  }
  const decorators = method.decorators
  const bodyValidation = validateSchema(ctx, decorators)
  const { params, complete } = analyzeParams(ctx, cls, method, where, bodyValidation)
  const status = httpCode(ctx, decorators)
  const headers = responseHeaders(ctx, decorators)
  const guards = classRefs(ctx, cls, decorators, Ids.UseGuard, 'guard')
  const interceptors = classRefs(ctx, cls, decorators, Ids.UseInterceptor, 'interceptor')
  const meta = routeMeta(ctx, cls, decorators)
  const bodySchema =
    bodyValidation !== undefined && !params.some(param => param.source === 'body') ? bodyValidation.schema : undefined
  const rawResponse = params.some(param => param.source === 'response')

  const routes: HttpRouteData[] = []
  for (const decorator of routeDecorators) {
    const httpMethod = ROUTE_METHODS.get(decorator.identity ?? '') as HttpMethod
    const [arg] = decorator.args
    let rawPath = ''
    if (arg !== undefined) {
      if (!arg.evaluated) {
        continue // not evaluable: already reported
      }
      if (typeof arg.value !== 'string') {
        error(ctx, arg.location, `@${decorator.name} expects a path (string), got ${describe(arg.value)}`, [
          `@${decorator.name}('/:id')`,
        ])
        continue
      }
      rawPath = arg.value
    }
    const path = normalizePath(rawPath)
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
      rawResponse,
      location: decorator.location,
      pathLocation: arg?.location ?? decorator.location,
    })
  }
  return routes
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
    if (decorator === undefined) {
      error(ctx, param.location, `Parameter '${param.name}' of ${where} has no HTTP decorator`, [
        'Decorate it with @Param(), @Query(), @Body(), @Headers(), @Ctx(), @Req() or @Res()',
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
  const base: Omit<HttpParamData, 'key' | 'schema' | 'coercion' | 'optional'> = {
    index: param.index,
    name: param.name,
    source,
    type: undefined,
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
  }
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
  source: 'param' | 'query' | 'headers',
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
  what: 'body' | 'query',
): void {
  if (type !== undefined && acceptedWithoutSchema(ctx, type, what)) {
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
      `Validate it with a Standard Schema: @${decorator.name}(${decorator.name === 'Body' ? '' : "'name', "}Schema)${decorator.name === 'Body' ? ' or @Validate(Schema)' : ''}`,
      'Or type the parameter as unknown and check it yourself',
    ],
  })
}

function acceptedWithoutSchema(ctx: Context, type: TypeInfo, what: 'body' | 'query'): boolean {
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
      // Record<string, string | string[]> (the shape of ctx.query / ctx.params)
      return (
        what === 'query' &&
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
