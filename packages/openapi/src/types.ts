/**
 * OpenAPI 3.1 types (our own, no `openapi-types` dependency). They describe the documents produced
 * by `buildOpenApiDocument`: every object is read-only, optional fields are omitted when absent and
 * `x-*` specification extensions are allowed where OpenAPI allows them.
 *
 * Schemas are JSON Schema 2020-12 ({@link JsonSchema}), the dialect of OpenAPI 3.1.
 */

/** A JSON value. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** A JSON Schema 2020-12 object (keywords are not modelled one by one). */
export interface JsonSchema {
  readonly [keyword: string]: JsonValue | undefined
}

/** `x-*` fields. */
export interface SpecificationExtensions {
  readonly [extension: `x-${string}`]: JsonValue | undefined
}

/** `{ $ref }` to a component (`#/components/schemas/Book`). */
export interface ReferenceObject {
  readonly $ref: string
  readonly summary?: string
  readonly description?: string
}

export interface ContactObject extends SpecificationExtensions {
  readonly name?: string
  readonly url?: string
  readonly email?: string
}

export interface LicenseObject extends SpecificationExtensions {
  readonly name: string
  /** SPDX expression (exclusive with `url`). */
  readonly identifier?: string
  readonly url?: string
}

export interface InfoObject extends SpecificationExtensions {
  readonly title: string
  readonly version: string
  readonly summary?: string
  readonly description?: string
  readonly termsOfService?: string
  readonly contact?: ContactObject
  readonly license?: LicenseObject
}

export interface ServerVariableObject extends SpecificationExtensions {
  readonly enum?: readonly string[]
  readonly default: string
  readonly description?: string
}

export interface ServerObject extends SpecificationExtensions {
  readonly url: string
  readonly description?: string
  readonly variables?: Readonly<Record<string, ServerVariableObject>>
}

export interface ExternalDocumentationObject extends SpecificationExtensions {
  readonly url: string
  readonly description?: string
}

export interface TagObject extends SpecificationExtensions {
  readonly name: string
  readonly description?: string
  readonly externalDocs?: ExternalDocumentationObject
}

/** Parameter locations. */
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie'

export interface ExampleObject extends SpecificationExtensions {
  readonly summary?: string
  readonly description?: string
  readonly value?: JsonValue
  readonly externalValue?: string
}

export interface ParameterObjectOf<S> extends SpecificationExtensions {
  readonly name: string
  readonly in: ParameterLocation
  readonly description?: string
  readonly required?: boolean
  readonly deprecated?: boolean
  readonly allowEmptyValue?: boolean
  readonly style?: string
  readonly explode?: boolean
  readonly schema?: S
  readonly example?: JsonValue
  readonly examples?: Readonly<Record<string, ExampleObject | ReferenceObject>>
}

export interface HeaderObjectOf<S> extends SpecificationExtensions {
  readonly description?: string
  readonly required?: boolean
  readonly deprecated?: boolean
  readonly schema?: S
  readonly example?: JsonValue
}

export interface EncodingObjectOf<S> extends SpecificationExtensions {
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, HeaderObjectOf<S> | ReferenceObject>>
  readonly style?: string
  readonly explode?: boolean
}

export interface MediaTypeObjectOf<S> extends SpecificationExtensions {
  readonly schema?: S
  readonly example?: JsonValue
  readonly examples?: Readonly<Record<string, ExampleObject | ReferenceObject>>
  readonly encoding?: Readonly<Record<string, EncodingObjectOf<S>>>
}

export interface RequestBodyObjectOf<S> extends SpecificationExtensions {
  readonly description?: string
  readonly content: Readonly<Record<string, MediaTypeObjectOf<S>>>
  readonly required?: boolean
}

export interface ResponseObjectOf<S> extends SpecificationExtensions {
  readonly description: string
  readonly headers?: Readonly<Record<string, HeaderObjectOf<S> | ReferenceObject>>
  readonly content?: Readonly<Record<string, MediaTypeObjectOf<S>>>
}

/** `{ schemeName: scopes }`: every scheme of one requirement applies (AND). */
export interface SecurityRequirementObject {
  readonly [scheme: string]: readonly string[]
}

/** An OpenAPI Operation Object whose schemas are `S` and whose parameters may also be `P`. */
export interface OperationObjectOf<S, P = never> extends SpecificationExtensions {
  readonly tags?: readonly string[]
  readonly summary?: string
  readonly description?: string
  readonly externalDocs?: ExternalDocumentationObject
  readonly operationId?: string
  readonly parameters?: readonly (ParameterObjectOf<S> | ReferenceObject | P)[]
  readonly requestBody?: RequestBodyObjectOf<S> | ReferenceObject
  readonly responses?: Readonly<Record<string, ResponseObjectOf<S> | ReferenceObject>>
  readonly deprecated?: boolean
  readonly security?: readonly SecurityRequirementObject[]
  readonly servers?: readonly ServerObject[]
}

export type ParameterObject = ParameterObjectOf<JsonSchema>
export type HeaderObject = HeaderObjectOf<JsonSchema>
export type MediaTypeObject = MediaTypeObjectOf<JsonSchema>
export type RequestBodyObject = RequestBodyObjectOf<JsonSchema>
export type ResponseObject = ResponseObjectOf<JsonSchema>
export type OperationObject = OperationObjectOf<JsonSchema>

/** HTTP methods of a path item, in OpenAPI order. */
export type OpenApiMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch'

export interface PathItemObject extends SpecificationExtensions {
  readonly summary?: string
  readonly description?: string
  readonly get?: OperationObject
  readonly put?: OperationObject
  readonly post?: OperationObject
  readonly delete?: OperationObject
  readonly options?: OperationObject
  readonly head?: OperationObject
  readonly patch?: OperationObject
  readonly trace?: OperationObject
  readonly servers?: readonly ServerObject[]
  readonly parameters?: readonly (ParameterObject | ReferenceObject)[]
}

export interface OAuthFlowObject extends SpecificationExtensions {
  readonly authorizationUrl?: string
  readonly tokenUrl?: string
  readonly refreshUrl?: string
  readonly scopes: Readonly<Record<string, string>>
}

export interface OAuthFlowsObject extends SpecificationExtensions {
  readonly implicit?: OAuthFlowObject
  readonly password?: OAuthFlowObject
  readonly clientCredentials?: OAuthFlowObject
  readonly authorizationCode?: OAuthFlowObject
}

/** An OpenAPI Security Scheme Object. */
export type SecuritySchemeObject =
  | ({
      readonly type: 'apiKey'
      readonly name: string
      readonly in: 'query' | 'header' | 'cookie'
      readonly description?: string
    } & SpecificationExtensions)
  | ({
      readonly type: 'http'
      /** `bearer`, `basic`... (RFC 7235 scheme name). */
      readonly scheme: string
      readonly bearerFormat?: string
      readonly description?: string
    } & SpecificationExtensions)
  | ({
      readonly type: 'oauth2'
      readonly flows: OAuthFlowsObject
      readonly description?: string
    } & SpecificationExtensions)
  | ({
      readonly type: 'openIdConnect'
      readonly openIdConnectUrl: string
      readonly description?: string
    } & SpecificationExtensions)
  | ({ readonly type: 'mutualTLS'; readonly description?: string } & SpecificationExtensions)

export interface ComponentsObject extends SpecificationExtensions {
  readonly schemas?: Readonly<Record<string, JsonSchema>>
  readonly responses?: Readonly<Record<string, ResponseObject | ReferenceObject>>
  readonly parameters?: Readonly<Record<string, ParameterObject | ReferenceObject>>
  readonly examples?: Readonly<Record<string, ExampleObject | ReferenceObject>>
  readonly requestBodies?: Readonly<Record<string, RequestBodyObject | ReferenceObject>>
  readonly headers?: Readonly<Record<string, HeaderObject | ReferenceObject>>
  readonly securitySchemes?: Readonly<Record<string, SecuritySchemeObject>>
}

/** An OpenAPI 3.1 document. */
export interface OpenApiObject extends SpecificationExtensions {
  readonly openapi: string
  readonly info: InfoObject
  readonly jsonSchemaDialect?: string
  readonly servers?: readonly ServerObject[]
  readonly paths?: Readonly<Record<string, PathItemObject>>
  readonly components?: ComponentsObject
  readonly security?: readonly SecurityRequirementObject[]
  readonly tags?: readonly TagObject[]
  readonly externalDocs?: ExternalDocumentationObject
}
