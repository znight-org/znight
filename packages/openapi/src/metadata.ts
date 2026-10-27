/**
 * `metadata.extensions.openapi` (format 1): the contract between the compiler extension
 * (`@znight/openapi/compiler`) and the runtime (`buildOpenApiDocument`, `OpenApiPlugin`).
 *
 * Everything is JSON-compatible, except the `schema` values of {@link OpenApiSchemaSlot}s (Standard
 * Schemas imported by the generated module). Where a schema is expected, the compiler writes JSON
 * Schema or a {@link SchemaPlaceholder} that the assembly replaces.
 */
import type { Token } from '@znight/core'
import type { StandardSchemaV1 } from '@znight/http'
import type {
  ExternalDocumentationObject,
  InfoObject,
  JsonSchema,
  JsonValue,
  OpenApiMethod,
  OperationObjectOf,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  TagObject,
} from './types.ts'

/** Format version of {@link OpenApiMetadata}. */
export const OPENAPI_METADATA_VERSION = 1

/** A Standard Schema converted at assembly: `{ $ref }` to its component once replaced. */
export interface SchemaPlaceholder {
  readonly $znight: 'schema'
  /** Slot name ({@link OpenApiSchemaSlot.name}). */
  readonly name: string
  readonly io: 'input' | 'output'
}

/**
 * In `parameters` arrays: one parameter per property of the (input) object schema of a slot
 * (`@Query(SearchQuery)`), `required` from its `required` list.
 */
export interface ParametersPlaceholder {
  readonly $znight: 'parameters'
  readonly in: 'path' | 'query' | 'header' | 'cookie'
  /** Slot name. */
  readonly name: string
  readonly io: 'input'
}

/** JSON Schema, or a placeholder of a Standard Schema. */
export type SchemaTemplate = JsonSchema | SchemaPlaceholder

/** An Operation Object whose schemas are {@link SchemaTemplate}s and whose parameters may be {@link ParametersPlaceholder}s. */
export type OperationTemplate = OperationObjectOf<SchemaTemplate, ParametersPlaceholder>

/** Root fields of the document known at build time. */
export interface OpenApiDocumentTemplate {
  readonly openapi: string
  readonly info: InfoObject
  readonly servers?: readonly ServerObject[]
  readonly tags?: readonly TagObject[]
  readonly externalDocs?: ExternalDocumentationObject
  readonly security?: readonly SecurityRequirementObject[]
  readonly [extension: `x-${string}`]: JsonValue | undefined
}

/** A documented operation. */
export interface OpenApiOperationDefinition {
  /** Controller token. */
  readonly controller: Token
  readonly handler: string
  /** The compiled route method (`'ALL'` gives one definition per documented method). */
  readonly route: string
  readonly method: OpenApiMethod
  /** OpenAPI path template, without the HTTP prefix (`/books/{id}`). */
  readonly path: string
  readonly operation: OperationTemplate
}

/** A Standard Schema converted when the document is assembled. */
export interface OpenApiSchemaSlot {
  /** Component name (export name of the binding: `CreateBook`). */
  readonly name: string
  /** The imported schema value. */
  readonly schema: StandardSchemaV1
  /** The JSON Schemas needed: `input` for requests, `output` for responses. */
  readonly io: readonly ('input' | 'output')[]
  /** Where the schema is declared (relative path), for messages. */
  readonly source?: { readonly file: string; readonly line: number; readonly column: number }
}

/** `metadata.extensions.openapi`. */
export interface OpenApiMetadata {
  readonly version: 1
  /** SHA-256 (base64url) of the section, schema values replaced by their names (stale-file detection). */
  readonly fingerprint: string
  readonly document: OpenApiDocumentTemplate
  /** Sorted by path, then by method (get, put, post, delete, options, head, patch). */
  readonly operations: readonly OpenApiOperationDefinition[]
  /** JSON Schemas computed by the compiler from TypeScript declarations, by component name (sorted). */
  readonly components: Readonly<Record<string, SchemaTemplate>>
  readonly securitySchemes: Readonly<Record<string, SecuritySchemeObject>>
  /** Standard Schemas converted at assembly, sorted by name. */
  readonly schemas: readonly OpenApiSchemaSlot[]
  /** Standard error components; absent with `errors: false`. */
  readonly errors?: { readonly contentType: string; readonly schema?: string }
  /** Descriptions of the default tags (JSDoc of the controllers), by tag name; absent when empty. */
  readonly tagDescriptions?: Readonly<Record<string, string>>
}

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly openapi?: OpenApiMetadata
  }
}
