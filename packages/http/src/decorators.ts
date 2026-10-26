/**
 * Marker decorators of `@znight/http`. Like every Znight decorator they do nothing at runtime: the
 * compiler extension `@znight/http/compiler` reads them from the source code and generates the
 * routes (`metadata.extensions.http`). Arguments marked _static_ must be statically evaluable
 * (literals, `const` references); _value_ arguments (schemas, guards...) may also be references to
 * exported bindings. See docs/internals/architecture.md §4.6 and §5.
 */
import type { ClassMarker, MethodMarker, ParameterMarker, Scope } from '@znight/core'
import type { HttpContext } from './context.ts'
import type { GuardClass, HttpInterceptorClass } from './interfaces.ts'
import type { ByteSize } from './size.ts'
import type { StandardSchemaV1 } from './standard-schema.ts'
import type { UploadedFileOptions, UploadedFilesOptions } from './uploads.ts'

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const classMarker: ClassMarker = marker
const methodMarker: MethodMarker = marker
const parameterMarker: ParameterMarker = marker
const classOrMethodMarker: ClassMarker & MethodMarker = marker

/** Options of {@link Controller} (static). */
export interface ControllerOptions {
  /** Base path of every route of the controller (`/users`). Default: `/`. */
  readonly path?: string
  /** Provider scope. Default: `singleton`; `request` creates one controller per request. */
  readonly scope?: Scope
}

/**
 * Declares a controller: a provider (singleton by default) whose decorated methods are routes.
 *
 * ```ts
 * @Controller('/users')
 * export class UserController {
 *   constructor(private readonly users: UserService) {}
 *
 *   @Get('/:id')
 *   find(@Param('id') id: number) {
 *     return this.users.findById(id)
 *   }
 * }
 * ```
 *
 * @param pathOrOptions static: base path, or `{ path?, scope? }`.
 */
export function Controller(_pathOrOptions?: string | ControllerOptions): ClassMarker {
  return classMarker
}

/** `GET` route. `path` (static) is relative to the controller path; default: the controller path. */
export function Get(_path?: string): MethodMarker {
  return methodMarker
}

/** `POST` route (default status 201). */
export function Post(_path?: string): MethodMarker {
  return methodMarker
}

/** `PUT` route. */
export function Put(_path?: string): MethodMarker {
  return methodMarker
}

/** `PATCH` route. */
export function Patch(_path?: string): MethodMarker {
  return methodMarker
}

/** `DELETE` route. */
export function Delete(_path?: string): MethodMarker {
  return methodMarker
}

/** `HEAD` route (`GET` routes already answer `HEAD` requests). */
export function Head(_path?: string): MethodMarker {
  return methodMarker
}

/** `OPTIONS` route (paths without one answer `OPTIONS` with `204` and an `allow` header). */
export function Options(_path?: string): MethodMarker {
  return methodMarker
}

/** Route for GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS (methods without a dedicated route on the same path). */
export function All(_path?: string): MethodMarker {
  return methodMarker
}

/**
 * Injects a route parameter, coerced to the parameter type (`string`, `number`, `boolean`,
 * `bigint`, `Date`, literal unions) or validated with `schema`. Without arguments: every parameter
 * (`Record<string, string>`).
 *
 * ```ts
 * @Get('/:id')
 * find(@Param('id') id: number) {}
 * ```
 *
 * @param name static: name of a `:param` of the route path.
 * @param schema value: a Standard Schema validating the raw string (its output is injected).
 */
export function Param(): ParameterMarker
export function Param(name: string, schema?: StandardSchemaV1): ParameterMarker
export function Param(schema: StandardSchemaV1): ParameterMarker
export function Param(_nameOrSchema?: string | StandardSchemaV1, _schema?: StandardSchemaV1): ParameterMarker {
  return parameterMarker
}

/**
 * Injects a query parameter (coerced to the parameter type; `T[]` accepts repeated and single
 * values; optional when the parameter is optional or has a default) or, without name, the whole
 * query (`Record<string, string | string[]>`), typically validated with a schema.
 *
 * ```ts
 * list(@Query('page') page = 1, @Query('tag') tags: string[] = []) {}
 * search(@Query(SearchQuery) query: SearchQuery) {}
 * ```
 *
 * @param name static: query key.
 * @param schema value: a Standard Schema (its output is injected).
 */
export function Query(): ParameterMarker
export function Query(name: string, schema?: StandardSchemaV1): ParameterMarker
export function Query(schema: StandardSchemaV1): ParameterMarker
export function Query(_nameOrSchema?: string | StandardSchemaV1, _schema?: StandardSchemaV1): ParameterMarker {
  return parameterMarker
}

/**
 * Injects the parsed request body, validated with `schema` when given (the schema output is
 * injected: defaults, transforms, stripped keys). A non-primitive body without schema is reported
 * by the compiler (ZNIGHT017).
 *
 * @param schema value: a Standard Schema (Zod, Valibot, ArkType...).
 */
export function Body(_schema?: StandardSchemaV1): ParameterMarker {
  return parameterMarker
}

/**
 * Injects a request header (case-insensitive `name`, coerced to the parameter type) or, without
 * name, every header (`Record<string, string | undefined>`).
 *
 * @param name static: header name.
 */
export function Headers(_name?: string): ParameterMarker {
  return parameterMarker
}

/**
 * Injects a file of a `multipart/form-data` body as a standard `File` (`name`, `type`, `size`,
 * `arrayBuffer()`, `text()`, `stream()`), held in memory. The route parses multipart bodies before
 * its interceptors, enforcing the options while the body is read: a file above `maxSize` answers
 * 413, a refused type 415, a second file in the field or a file in an undeclared field 400, a
 * missing required file 400, a non-multipart body 415. `@Body()` receives the text fields.
 *
 * ```ts
 * @Post('/avatar')
 * upload(@UploadedFile('avatar', { maxSize: '2mb', mimeTypes: ['image/png', 'image/jpeg'] }) avatar: File) {}
 *
 * @Post('/attachment')
 * attach(@UploadedFile('file') file?: File) {} // optional: undefined when absent
 * ```
 *
 * `File.name` and `File.type` are sent by the client: never trust them (see the README, "Files").
 *
 * @param field static: the multipart field; omitted: the single file of the body, whatever its field.
 * @param options static: `{ required?, maxSize?, mimeTypes? }`.
 */
export function UploadedFile(field?: string, options?: UploadedFileOptions): ParameterMarker
export function UploadedFile(options: UploadedFileOptions): ParameterMarker
export function UploadedFile(
  _fieldOrOptions?: string | UploadedFileOptions,
  _options?: UploadedFileOptions,
): ParameterMarker {
  return parameterMarker
}

/**
 * Injects the files of a multipart field (`File[]`, in body order), or of every field without
 * `field`. Same rules as {@link UploadedFile}; above `maxFiles` files the request answers 413. An
 * optional parameter (`files?: File[]`, `required: false`) receives an empty array when no file is
 * sent.
 *
 * ```ts
 * @Post('/documents')
 * add(@UploadedFiles('documents', { maxFiles: 5, maxSize: '20mb', mimeTypes: ['application/pdf'] }) documents: File[]) {}
 * ```
 *
 * @param field static: the multipart field; omitted: the files of every field.
 * @param options static: `{ required?, maxSize?, maxFiles?, mimeTypes? }`.
 */
export function UploadedFiles(field?: string, options?: UploadedFilesOptions): ParameterMarker
export function UploadedFiles(options: UploadedFilesOptions): ParameterMarker
export function UploadedFiles(
  _fieldOrOptions?: string | UploadedFilesOptions,
  _options?: UploadedFilesOptions,
): ParameterMarker {
  return parameterMarker
}

/**
 * Sets the maximum request body size of a route, or of every route of a controller (the route wins),
 * over the plugin `bodyLimit` (and over the limit computed for upload routes). `Infinity` disables
 * the limit, e.g. for a route streaming its body with `ctx.bodyStream()`.
 *
 * ```ts
 * @Put('/files/:name')
 * @BodyLimit('5gb')
 * async store(@Param('name') name: string, @Ctx() ctx: HttpContext) {
 *   await pipeline(Readable.fromWeb(ctx.bodyStream()), createWriteStream(join(DIR, safeName(name))))
 * }
 * ```
 *
 * @param size static: bytes (`10_485_760`) or a size with a unit (`'10mb'`, `'512kb'`; `kb` = 1024 bytes).
 */
export function BodyLimit(_size: ByteSize): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/** Injects the native request of the adapter (escape hatch; the compiler warns). */
export function Req(): ParameterMarker {
  return parameterMarker
}

/**
 * Injects the native response of the adapter (escape hatch; the compiler warns). The handler then
 * writes the response itself, and must have finished when its promise settles.
 */
export function Res(): ParameterMarker {
  return parameterMarker
}

/** Injects the {@link HttpContext} of the request. */
export function Ctx(): ParameterMarker {
  return parameterMarker
}

/**
 * Sets the status of successful responses (wins over `HttpResponse.status` and the defaults).
 *
 * @param status static: an integer between 100 and 599.
 */
export function HttpCode(_status: number): MethodMarker {
  return methodMarker
}

/**
 * Adds a header to successful responses. Repeat the decorator for several headers.
 *
 * @param name static: header name.
 * @param value static: header value.
 */
export function Header(_name: string, _value: string): MethodMarker {
  return methodMarker
}

/**
 * Protects a controller (every route) or a route with guards (providers implementing
 * {@link CanActivate}). Order: global guards → controller guards → route guards, each list in
 * declaration order.
 *
 * @param guards value: guard classes.
 */
export function UseGuard(..._guards: [GuardClass, ...GuardClass[]]): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/**
 * Wraps a controller (every route) or a route with interceptors (providers implementing
 * {@link HttpInterceptor}). Order: global → controller → route, the first one being the outermost.
 *
 * @param interceptors value: interceptor classes.
 */
export function UseInterceptor(
  ..._interceptors: [HttpInterceptorClass, ...HttpInterceptorClass[]]
): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/**
 * Validates the request body with `schema`: sugar for `@Body(schema)` on the body parameter (using
 * both is ZNIGHT005).
 *
 * @param schema value: a Standard Schema.
 */
export function Validate(_schema: StandardSchemaV1): MethodMarker {
  return methodMarker
}

/** Arguments of a route decorator: optional when `T` accepts `undefined` or is `true` (flag decorators). */
export type RouteDecoratorArgs<T> = [T] extends [true] ? [value?: T] : undefined extends T ? [value?: T] : [value: T]

/** A user-defined route metadata decorator created with {@link createRouteDecorator}. */
export interface RouteDecorator<T> {
  (...args: RouteDecoratorArgs<T>): ClassMarker & MethodMarker
  /** Key of the value in `route.meta`. */
  readonly key: string
  /** The value of the current route (route metadata wins over controller metadata), if set. */
  get(ctx: HttpContext): T | undefined
}

/**
 * Creates a metadata decorator for controllers and routes. The compiler stores its argument
 * (`value`, statically evaluated or an exported reference; `true` when omitted) in
 * `meta[key]`, read by guards and interceptors through `ctx.route.meta` or `decorator.get(ctx)`.
 *
 * ```ts
 * export const Roles = createRouteDecorator<readonly string[]>('roles')
 * export const Public = createRouteDecorator('public') // flag: @Public()
 *
 * @Roles(['admin'])
 * @Delete('/:id')
 * remove(@Param('id') id: string) {}
 *
 * // in a guard
 * if (Public.get(ctx)) return true
 * const roles = Roles.get(ctx) ?? []
 * ```
 *
 * @param key static: unique metadata key.
 */
export function createRouteDecorator<T = true>(key: string): RouteDecorator<T> {
  const decorator = (..._args: RouteDecoratorArgs<T>): ClassMarker & MethodMarker => classOrMethodMarker
  return Object.assign(decorator, {
    key,
    get: (ctx: HttpContext): T | undefined => ctx.route?.meta[key] as T | undefined,
  })
}
