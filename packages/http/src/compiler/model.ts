/**
 * Data model of the `@znight/http` compiler extension: canonical identities of the decorators and
 * the data stored during analysis (`ctx.store()`), read back by `validate()` and `generate()`.
 *
 * This module is pure (types and constants only) so that the compiler entry stays free of runtime
 * dependencies.
 */
import type { ClassRef, Location, StaticValue, ValueRef } from '@znight/compiler'
import type { HttpMethod, HttpParamSource } from '../metadata.ts'

/** Package name (prefix of every decorator identity). */
export const HTTP_PACKAGE = '@znight/http'

/** Canonical identities of the decorators of `@znight/http`. */
export const Ids: {
  readonly Controller: string
  readonly Param: string
  readonly Query: string
  readonly Body: string
  readonly Headers: string
  readonly Req: string
  readonly Res: string
  readonly Ctx: string
  readonly HttpCode: string
  readonly Header: string
  readonly UseGuard: string
  readonly UseInterceptor: string
  readonly Validate: string
  readonly UploadedFile: string
  readonly UploadedFiles: string
  readonly BodyLimit: string
  readonly Cookie: string
  readonly SignedCookie: string
  readonly Sse: string
  readonly createRouteDecorator: string
  readonly RouteDecorator: string
} = Object.freeze({
  Controller: '@znight/http#Controller',
  Param: '@znight/http#Param',
  Query: '@znight/http#Query',
  Body: '@znight/http#Body',
  Headers: '@znight/http#Headers',
  Req: '@znight/http#Req',
  Res: '@znight/http#Res',
  Ctx: '@znight/http#Ctx',
  HttpCode: '@znight/http#HttpCode',
  Header: '@znight/http#Header',
  UseGuard: '@znight/http#UseGuard',
  UseInterceptor: '@znight/http#UseInterceptor',
  Validate: '@znight/http#Validate',
  UploadedFile: '@znight/http#UploadedFile',
  UploadedFiles: '@znight/http#UploadedFiles',
  BodyLimit: '@znight/http#BodyLimit',
  Cookie: '@znight/http#Cookie',
  SignedCookie: '@znight/http#SignedCookie',
  Sse: '@znight/http#Sse',
  createRouteDecorator: '@znight/http#createRouteDecorator',
  RouteDecorator: '@znight/http#RouteDecorator',
})

/** Route method decorators → HTTP method (`@Sse` declares a `GET` route). */
export const ROUTE_METHODS: ReadonlyMap<string, HttpMethod> = new Map<string, HttpMethod>([
  ['@znight/http#Get', 'GET'],
  ['@znight/http#Post', 'POST'],
  ['@znight/http#Put', 'PUT'],
  ['@znight/http#Patch', 'PATCH'],
  ['@znight/http#Delete', 'DELETE'],
  ['@znight/http#Head', 'HEAD'],
  ['@znight/http#Options', 'OPTIONS'],
  ['@znight/http#All', 'ALL'],
  ['@znight/http#Sse', 'GET'],
])

/** Parameter decorators → parameter source. */
export const PARAM_SOURCES: ReadonlyMap<string, HttpParamSource> = new Map<string, HttpParamSource>([
  [Ids.Param, 'param'],
  [Ids.Query, 'query'],
  [Ids.Body, 'body'],
  [Ids.Headers, 'headers'],
  [Ids.Req, 'request'],
  [Ids.Res, 'response'],
  [Ids.Ctx, 'context'],
  [Ids.UploadedFile, 'file'],
  [Ids.UploadedFiles, 'files'],
  [Ids.Cookie, 'cookie'],
  [Ids.SignedCookie, 'signedCookie'],
])

/** Error codes used by the extension (see `ErrorCode` in `@znight/core`). */
export const Codes: {
  readonly MissingProvider: 'ZNIGHT001'
  readonly InvalidDecorator: 'ZNIGHT005'
  readonly InvalidRoute: 'ZNIGHT007'
  readonly UnvalidatedInput: 'ZNIGHT017'
  readonly MissingRouteDecision: 'ZNIGHT023'
} = Object.freeze({
  MissingProvider: 'ZNIGHT001',
  InvalidDecorator: 'ZNIGHT005',
  InvalidRoute: 'ZNIGHT007',
  UnvalidatedInput: 'ZNIGHT017',
  MissingRouteDecision: 'ZNIGHT023',
})

/**
 * Grammar of an explicit route decorator group name (same as the runtime `createRouteDecorator`).
 * A decorator without `group` is its own group, named after its key (any non-empty key).
 */
export const GROUP_NAME: RegExp = /^[A-Za-z][\w.-]*$/

/** Primitive coercions (`coerce.<kind>`). */
export type ScalarCoercion = 'string' | 'number' | 'integer' | 'boolean' | 'bigint' | 'date'

/**
 * How a raw value (route parameter, query value, header) is converted to the declared type of a
 * handler parameter.
 */
export type CoercionPlan =
  | { readonly kind: ScalarCoercion }
  | { readonly kind: 'enum'; readonly values: readonly (string | number | boolean)[] }
  | { readonly kind: 'array'; readonly item: CoercionPlan }
  | { readonly kind: 'optional'; readonly item: CoercionPlan }
  /** No conversion: the raw value is passed as is (`unknown` / `any` parameters). */
  | { readonly kind: 'raw' }

/** The coercion of a handler parameter. */
export interface ParamCoercion {
  readonly plan: CoercionPlan
  /**
   * The coerced value does not have the declared type (branded primitives, enums, `null` without
   * `undefined`): the generated expression is cast with `as never`.
   */
  readonly cast: boolean
}

/** An upload parameter (`@UploadedFile` / `@UploadedFiles`). */
export interface UploadData {
  /** Multipart field; `undefined`: any field. */
  readonly field: string | undefined
  /** `@UploadedFiles`. */
  readonly multiple: boolean
  /** A file must be sent (`required` option, else the parameter is not optional). */
  readonly required: boolean
  /** `maxSize` in bytes (`Infinity` allowed). */
  readonly maxSize: number | undefined
  /** `maxFiles` (`@UploadedFiles` only). */
  readonly maxFiles: number | undefined
  /** `mimeTypes` patterns, as written. */
  readonly mimeTypes: readonly string[] | undefined
  /** The injected value does not have the declared type (`node:buffer` File, `File | null`): `as never`. */
  readonly cast: boolean
}

/** A handler parameter. */
export interface HttpParamData {
  /** Position in the handler signature. */
  readonly index: number
  /** Parameter name (messages). */
  readonly name: string
  readonly source: HttpParamSource
  /** Route parameter name, query key, lower-case header name or cookie name; `undefined` for the whole object. */
  readonly key: string | undefined
  /** Declared (or inferred) type, formatted for humans. */
  readonly type: string | undefined
  /** The parameter accepts `undefined` (`?`, `| undefined`, default value). */
  readonly optional: boolean
  /** Standard Schema validating the value (its output is injected). */
  readonly schema: ValueRef | undefined
  /** Coercion of a named value without schema. */
  readonly coercion: ParamCoercion | undefined
  /** Upload parameter (`source` `file` / `files`). */
  readonly upload?: UploadData
  /**
   * The default value of the handler parameter (`@Query('page') page = 1` → `1`), when it is
   * statically evaluable (literals, `const` references; references to exported bindings are left
   * out). Informational (documentation): the handler applies its own default.
   */
  readonly defaultValue?: StaticValue
  /** Location of the parameter decorator. */
  readonly location: Location
}

/** A `createRouteDecorator` value (`route.meta[key]`) and the definition of its decorator. */
export interface MetaEntry {
  readonly key: string
  /** Statically evaluated value; may be or contain references to exported bindings. */
  readonly value: StaticValue
  /** Location of the decorator usage. */
  readonly location: Location
  /** Decision group (`options.group ?? key`). */
  readonly group: string
  /** The group is required (`options.required`). */
  readonly required: boolean
  /** Display name of the decorator (`Roles`). */
  readonly decorator: string
  /** Canonical identity of the decorator `const` (`src/auth/access.ts#Roles`). */
  readonly identity: string
  /** Location of the decorator definition (`export const Roles = createRouteDecorator(...)`). */
  readonly definition: Location
}

/** Options of an `@Sse` route (`HttpRouteDefinition.sse`). */
export interface SseRouteData {
  /** Heartbeat in ms; `0` disables it (`heartbeat: false`). Absent: the plugin default. */
  readonly heartbeat?: number
  readonly retry?: number
  readonly maxDuration?: number
}

/** A route: one route decorator of a handler. */
export interface HttpRouteData {
  readonly method: HttpMethod
  /** Path of the route decorator as written (`undefined` when absent). */
  readonly rawPath: string
  /** `normalizePath(rawPath)`. */
  readonly path: string
  /** `joinPaths(controller base path, path)`. */
  readonly fullPath: string
  readonly handler: string
  readonly status: number | undefined
  /** `@Header` entries, lower-case names, in source order. */
  readonly headers: readonly (readonly [string, string])[]
  readonly meta: readonly MetaEntry[]
  readonly guards: readonly ClassRef[]
  readonly interceptors: readonly ClassRef[]
  readonly params: readonly HttpParamData[]
  /** `false` when a parameter could not be analysed (an error was reported; it is missing from `params`). */
  readonly complete: boolean
  /** `@Validate(S)` on a handler without `@Body()` parameter: the body is validated and discarded. */
  readonly bodySchema: ValueRef | undefined
  /** `@BodyLimit` of the method (or of the controller), in bytes. */
  readonly bodyLimit: number | undefined
  readonly rawResponse: boolean
  /** `@Sse` route: its options (`{}` without options). */
  readonly sse?: SseRouteData
  /** Location of the route decorator. */
  readonly location: Location
  /** Location of the path argument (the decorator when absent). */
  readonly pathLocation: Location
}

/** A controller (data stored by `analyzeClass`). */
export interface HttpControllerData {
  /** Provider token of the controller. */
  readonly token: string
  /** Canonical identity of the class (imported as a type by `invoke`). */
  readonly identity: string
  readonly displayName: string
  /** Base path as written. */
  readonly rawBasePath: string
  /** `normalizePath(rawBasePath)`. */
  readonly basePath: string
  readonly guards: readonly ClassRef[]
  readonly interceptors: readonly ClassRef[]
  readonly meta: readonly MetaEntry[]
  readonly routes: readonly HttpRouteData[]
  /** Location of `@Controller`. */
  readonly location: Location
  /** Location of the base path argument (the decorator when absent). */
  readonly pathLocation: Location
}
