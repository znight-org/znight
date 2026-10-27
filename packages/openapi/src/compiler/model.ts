/**
 * Identities, codes and the data model of the `@znight/openapi` compiler extension. Pure: types and
 * constants only.
 */
import type { Location, ValueRef } from '@znight/compiler'

/** Name of the extension (key of `metadata.extensions`). */
export const EXTENSION_NAME = 'openapi'

/** Canonical identities of the decorators and functions of `@znight/openapi`. */
export const Ids: {
  readonly OpenApiDocument: string
  readonly ApiOperation: string
  readonly ApiTags: string
  readonly ApiResponse: string
  readonly ApiBody: string
  readonly ApiQuery: string
  readonly ApiHeader: string
  readonly ApiSecurity: string
  readonly ApiExclude: string
  readonly securityScheme: string
} = Object.freeze({
  OpenApiDocument: '@znight/openapi#OpenApiDocument',
  ApiOperation: '@znight/openapi#ApiOperation',
  ApiTags: '@znight/openapi#ApiTags',
  ApiResponse: '@znight/openapi#ApiResponse',
  ApiBody: '@znight/openapi#ApiBody',
  ApiQuery: '@znight/openapi#ApiQuery',
  ApiHeader: '@znight/openapi#ApiHeader',
  ApiSecurity: '@znight/openapi#ApiSecurity',
  ApiExclude: '@znight/openapi#ApiExclude',
  securityScheme: '@znight/openapi#securityScheme',
})

/** Identities of `@znight/http` read by the extension. */
export const HttpIds: {
  readonly Controller: string
  readonly createRouteDecorator: string
  readonly HttpResponse: string
  readonly FileBody: string
  readonly SseEvent: string
} = Object.freeze({
  Controller: '@znight/http#Controller',
  createRouteDecorator: '@znight/http#createRouteDecorator',
  HttpResponse: '@znight/http#HttpResponse',
  FileBody: '@znight/http#FileBody',
  SseEvent: '@znight/http#SseEvent',
})

/** Route method decorators of `@znight/http` (a method carrying one is a route handler). */
export const ROUTE_DECORATORS: ReadonlySet<string> = new Set([
  '@znight/http#Get',
  '@znight/http#Post',
  '@znight/http#Put',
  '@znight/http#Patch',
  '@znight/http#Delete',
  '@znight/http#Head',
  '@znight/http#Options',
  '@znight/http#All',
  '@znight/http#Sse',
])

/** Error codes used by the extension (see `ErrorCode` in `@znight/core`). */
export const Codes: {
  readonly InvalidDecorator: 'ZNIGHT005'
  readonly InvalidOpenApiDefinition: 'ZNIGHT030'
  readonly UndocumentedResponse: 'ZNIGHT031'
  readonly UnrepresentableType: 'ZNIGHT032'
  readonly DuplicateOperationId: 'ZNIGHT033'
  readonly SchemaNameConflict: 'ZNIGHT034'
  readonly InconsistentOperation: 'ZNIGHT035'
  readonly InvalidSecurityRequirement: 'ZNIGHT036'
} = Object.freeze({
  InvalidDecorator: 'ZNIGHT005',
  InvalidOpenApiDefinition: 'ZNIGHT030',
  UndocumentedResponse: 'ZNIGHT031',
  UnrepresentableType: 'ZNIGHT032',
  DuplicateOperationId: 'ZNIGHT033',
  SchemaNameConflict: 'ZNIGHT034',
  InconsistentOperation: 'ZNIGHT035',
  InvalidSecurityRequirement: 'ZNIGHT036',
})

/** Generic aliases meaning "the Standard Schema S" (`z.output<typeof S>`), checked against the installed libraries. */
export const SCHEMA_ALIASES: Readonly<Record<string, 'input' | 'output'>> = Object.freeze({
  'zod#output': 'output',
  'zod#infer': 'output',
  'zod#input': 'input',
  'zod/v4#output': 'output',
  'zod/v4#infer': 'output',
  'zod/v4#input': 'input',
  'valibot#InferOutput': 'output',
  'valibot#InferInput': 'input',
  '@znight/http#InferSchemaOutput': 'output',
  '@znight/http#InferSchemaInput': 'input',
  '@standard-schema/spec#StandardSchemaV1.InferOutput': 'output',
  '@standard-schema/spec#StandardSchemaV1.InferInput': 'input',
})

/** ArkType: `typeof S.infer` / `typeof S.inferIn`. */
export const SCHEMA_MEMBERS: Readonly<Record<string, 'input' | 'output'>> = Object.freeze({
  infer: 'output',
  inferIn: 'input',
})

/** Types kept as references by the shape resolver (bodies of special responses). */
export const KEEP: readonly string[] = Object.freeze([
  HttpIds.HttpResponse,
  HttpIds.FileBody,
  HttpIds.SseEvent,
  'globalThis#AsyncIterable',
  'globalThis#AsyncIterableIterator',
  'globalThis#AsyncGenerator',
  'globalThis#Response',
])

/** Data stored by `analyzeClass`. */
export type OpenApiStored =
  | {
      readonly kind: 'document'
      readonly identity: string
      readonly displayName: string
      readonly location: Location
    }
  | {
      readonly kind: 'controller'
      readonly identity: string
      readonly displayName: string
    }

/** A Standard Schema to convert at assembly. */
export interface SlotData {
  readonly name: string
  readonly ref: ValueRef
  readonly io: Set<'input' | 'output'>
  /** The declaration of the schema (the reference when it cannot be found). */
  readonly location: Location
}
