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
  createRouteDecorator: '@znight/http#createRouteDecorator',
  RouteDecorator: '@znight/http#RouteDecorator',
})

/** Route method decorators → HTTP method. */
export const ROUTE_METHODS: ReadonlyMap<string, HttpMethod> = new Map<string, HttpMethod>([
  ['@znight/http#Get', 'GET'],
  ['@znight/http#Post', 'POST'],
  ['@znight/http#Put', 'PUT'],
  ['@znight/http#Patch', 'PATCH'],
  ['@znight/http#Delete', 'DELETE'],
  ['@znight/http#Head', 'HEAD'],
  ['@znight/http#Options', 'OPTIONS'],
  ['@znight/http#All', 'ALL'],
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
])

/** Error codes used by the extension (see `ErrorCode` in `@znight/core`). */
export const Codes: {
  readonly MissingProvider: 'ZNIGHT001'
  readonly InvalidDecorator: 'ZNIGHT005'
  readonly InvalidRoute: 'ZNIGHT007'
  readonly UnvalidatedInput: 'ZNIGHT017'
} = Object.freeze({
  MissingProvider: 'ZNIGHT001',
  InvalidDecorator: 'ZNIGHT005',
  InvalidRoute: 'ZNIGHT007',
  UnvalidatedInput: 'ZNIGHT017',
})

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

/** A handler parameter. */
export interface HttpParamData {
  /** Position in the handler signature. */
  readonly index: number
  /** Parameter name (messages). */
  readonly name: string
  readonly source: HttpParamSource
  /** Route parameter name, query key or lower-case header name; `undefined` for the whole object. */
  readonly key: string | undefined
  /** Declared (or inferred) type, formatted for humans. */
  readonly type: string | undefined
  /** The parameter accepts `undefined` (`?`, `| undefined`, default value). */
  readonly optional: boolean
  /** Standard Schema validating the value (its output is injected). */
  readonly schema: ValueRef | undefined
  /** Coercion of a named value without schema. */
  readonly coercion: ParamCoercion | undefined
  /** Location of the parameter decorator. */
  readonly location: Location
}

/** A `createRouteDecorator` value (`route.meta[key]`). */
export interface MetaEntry {
  readonly key: string
  /** Statically evaluated value; may be or contain references to exported bindings. */
  readonly value: StaticValue
  readonly location: Location
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
  readonly rawResponse: boolean
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
