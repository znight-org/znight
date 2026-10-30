/**
 * Decorators of `@znight/openapi`. Like every Znight decorator they do nothing at runtime: the
 * compiler extension (`@znight/openapi/compiler`) reads them, type arguments included
 * (`@ApiResponse<Book[]>(200)`), and the Vite plugin strips them from the bundle.
 */
import type { ClassMarker, MethodMarker } from '@znight/core'
import type { RouteDecorator, StandardSchemaV1 } from '@znight/http'
import type {
  ExternalDocumentationObject,
  HeaderObject,
  InfoObject,
  JsonValue,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from './types.ts'

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const classMarker: ClassMarker = marker
const methodMarker: MethodMarker = marker
const classOrMethodMarker: ClassMarker & MethodMarker = marker

/** A security scheme declared with {@link securityScheme}. */
export interface SecurityScheme {
  /** Key of the scheme in `components.securitySchemes`. */
  readonly name: string
  readonly definition: SecuritySchemeObject
}

/** One scheme, several schemes that all apply (AND), or a scheme with scopes. */
export type SecurityRequirementInput =
  | SecurityScheme
  | readonly SecurityScheme[]
  | { readonly scheme: SecurityScheme; readonly scopes: readonly string[] }

/** Security of the routes carrying a route decorator (§5.5 of RFC 0002). */
export interface SecurityDecision {
  /** A route decorator (`createRouteDecorator`) found in the route's effective metadata. */
  // biome-ignore lint/suspicious/noExplicitAny: any route decorator value type is accepted
  readonly when: RouteDecorator<any>
  /** Requirements of the matching routes; `[]` means public. */
  readonly security: readonly SecurityRequirementInput[]
  /** `'value'`: the decorator value (a static string array) becomes the scopes of every requirement. */
  readonly scopes?: 'value'
}

/** Style of the default operation ids. */
export type OperationIdStyle = 'controller.handler' | 'handler' | 'Controller_handler'

/** Options of {@link OpenApiDocument}. */
export interface OpenApiDocumentOptions {
  /** Title, version, description... (defaults: the JSDoc of the class, then `package.json`). */
  readonly info?: Partial<InfoObject>
  readonly servers?: readonly ServerObject[]
  /** Declared tags first, in this order; used tags are added, sorted. */
  readonly tags?: readonly TagObject[]
  readonly externalDocs?: ExternalDocumentationObject
  /** Default requirements of every operation: entries are alternatives (OR). Default: none. */
  readonly security?: readonly SecurityRequirementInput[]
  /** Security derived from route decorators; the first matching entry wins. */
  readonly decisions?: readonly SecurityDecision[]
  /** Ids of operations without `@ApiOperation({ operationId })`. Default `'controller.handler'`. */
  readonly operationIds?: OperationIdStyle
  /** Standard error responses (400, 413, 415, declared 4XX/5XX). Default `true`. */
  readonly errors?: boolean | { readonly schema: StandardSchemaV1; readonly contentType?: string }
  /** ZNIGHT031 and ZNIGHT032 become errors. Default `false`. */
  readonly strict?: boolean
  /** Read the JSDoc of controllers, handlers and types. Default `true`. */
  readonly jsdoc?: boolean
  /** `x-*` fields of the root object. */
  readonly extensions?: Readonly<Record<`x-${string}`, JsonValue>>
}

/**
 * Options of the document (one per application, optional). The class is never instantiated nor
 * registered as a provider; its JSDoc gives the title (first line) and the description (the rest).
 *
 * ```ts
 * /** Bookshelf API *\/
 * @OpenApiDocument({ servers: [{ url: '/api' }], security: [ApiKey], decisions: [{ when: Public, security: [] }] })
 * export class BookshelfApi {}
 * ```
 */
export function OpenApiDocument(_options?: OpenApiDocumentOptions): ClassMarker {
  return classMarker
}

/**
 * Declares a security scheme, read statically by the compiler. At runtime it returns a frozen
 * `{ name, definition }`.
 *
 * ```ts
 * export const ApiKey = securityScheme('apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' })
 * ```
 */
export function securityScheme(name: string, definition: SecuritySchemeObject): SecurityScheme {
  return Object.freeze({ name, definition })
}

/** Options of {@link ApiOperation}. */
export interface ApiOperationOptions {
  readonly summary?: string
  readonly description?: string
  readonly operationId?: string
  readonly deprecated?: boolean
  readonly externalDocs?: ExternalDocumentationObject
  readonly extensions?: Readonly<Record<`x-${string}`, JsonValue>>
}

/** Overrides the JSDoc and the defaults of an operation. */
export function ApiOperation(_options: ApiOperationOptions): MethodMarker {
  return methodMarker
}

/** Tags of the operations (class and method tags are merged, class tags first). */
export function ApiTags(..._names: [string, ...string[]]): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/** A response status: a code, `'2XX'`-like ranges, or `'default'`. */
export type ApiResponseStatus = number | `${1 | 2 | 3 | 4 | 5}XX` | 'default'

/** Options of {@link ApiResponse}. */
export interface ApiResponseOptions {
  readonly description?: string
  /** Body schema (a Standard Schema, documented with its output JSON Schema). */
  readonly schema?: StandardSchemaV1
  /** Media type(s) of the body. Default `application/json` (when the body has a schema). */
  readonly contentType?: string | readonly string[]
  readonly headers?: Readonly<Record<string, Partial<HeaderObject>>>
  readonly example?: JsonValue
}

/**
 * Declares or overrides a response (repeatable). The body type comes from `T`
 * (`@ApiResponse<Book>(200)`) or from a Standard Schema in `schema`.
 */
export function ApiResponse<_T = never>(_status: ApiResponseStatus, _options?: ApiResponseOptions): MethodMarker {
  return methodMarker
}

/** Options of {@link ApiBody}. */
export interface ApiBodyOptions {
  readonly description?: string
  readonly required?: boolean
  readonly contentType?: string | readonly string[]
  readonly schema?: StandardSchemaV1
}

/** The body of a route that reads it itself (`ctx.parseBody()`, `ctx.bodyStream()`). */
export function ApiBody<_T = never>(_options?: ApiBodyOptions): MethodMarker {
  return methodMarker
}

/** Options of {@link ApiQuery} and {@link ApiHeader}. */
export interface ApiParameterOptions {
  readonly description?: string
  readonly required?: boolean
  readonly deprecated?: boolean
  readonly example?: JsonValue
}

/** A query parameter read outside the signature (`ctx.query`); its type is `T` (default `string`). */
export function ApiQuery<_T = string>(_name: string, _options?: ApiParameterOptions): MethodMarker {
  return methodMarker
}

/** A header read by a guard or an interceptor (`x-tenant`); its type is `T` (default `string`). */
export function ApiHeader<_T = string>(_name: string, _options?: ApiParameterOptions): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/**
 * Security of the operations: the route's wins over the class's. Several arguments are
 * alternatives (OR); no argument means public (`security: []`).
 */
export function ApiSecurity(..._requirements: SecurityRequirementInput[]): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/** The controller or route is not documented. */
export function ApiExclude(): ClassMarker & MethodMarker {
  return classOrMethodMarker
}
