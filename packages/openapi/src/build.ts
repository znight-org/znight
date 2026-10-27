/**
 * `buildOpenApiDocument` (§7.3 of RFC 0002, normative): assembles the OpenAPI document from
 * `metadata.extensions.openapi`. The same pure function runs at boot (`OpenApiPlugin`), at build time
 * (`znight openapi`, `znight build --openapi`, the `openapi()` Vite plugin) and in tests, so the
 * served document and the emitted file are byte-identical.
 */
import type { ZnightMetadata } from '@znight/core'
import type { StandardSchemaV1 } from '@znight/http'
import type { SchemaConverter } from './converters.ts'
import type { OpenApiMetadata, OpenApiSchemaSlot } from './metadata.ts'
import type {
  InfoObject,
  JsonSchema,
  JsonValue,
  OpenApiMethod,
  OpenApiObject,
  ServerObject,
  TagObject,
} from './types.ts'

import { displayName, ErrorCode, ZnightError } from '@znight/core'

import { BUILT_IN_CONVERTERS, vendorOf } from './converters.ts'
import { OPENAPI_METADATA_VERSION } from './metadata.ts'
import { compareStrings, ERROR_COMPONENTS, ERROR_RESPONSES, jsonEquals, reasonPhrase, schemaRef } from './shared.ts'

/** A static view of an operation (no schema conversion), used by `filter` and `OpenApi.operations`. */
export interface OpenApiOperationView {
  readonly method: OpenApiMethod
  /** Path template without the HTTP prefix (`/books/{id}`). */
  readonly path: string
  readonly operationId: string
  readonly tags: readonly string[]
  /** Controller display name. */
  readonly controller: string
  readonly handler: string
  /** Effective route metadata (`createRouteDecorator` values, the nearest decision of each group). */
  readonly meta: Readonly<Record<string, unknown>>
}

/** Options of {@link buildOpenApiDocument}. */
export interface BuildOpenApiOptions {
  /** The HTTP prefix: `servers` defaults to `[{ url: prefix }]` when nothing declares servers. */
  readonly prefix?: string
  /** Merged over the static `info`. */
  readonly info?: Partial<InfoObject>
  /** Replaces the declared `servers`. */
  readonly servers?: readonly ServerObject[]
  /** Hides operations; unreferenced components are pruned. */
  readonly filter?: (operation: OpenApiOperationView) => boolean
  /** Last-resort escape hatch, applied before freezing. */
  readonly transform?: (document: OpenApiObject) => OpenApiObject
  /** Extra converters, tried before the built-in ones. */
  readonly converters?: readonly SchemaConverter[]
  /** `'warn'`: a schema that cannot be converted becomes `{}` with a ZNIGHT037 warning. Default `'error'`. */
  readonly unrepresentable?: 'error' | 'warn'
}

/** A warning of the assembly. */
export interface OpenApiWarning {
  readonly code: ErrorCode
  readonly message: string
  readonly hints: readonly string[]
}

/** Result of {@link buildOpenApiDocument}. */
export interface OpenApiBuildResult {
  /** The document, deep-frozen. */
  readonly document: OpenApiObject
  /** `JSON.stringify(document, null, 2)` and a final newline. */
  readonly json: string
  readonly warnings: readonly OpenApiWarning[]
  readonly stats: { readonly operations: number; readonly schemas: number; readonly durationMs: number }
}

type Json = Record<string, unknown>

/** Reads and checks `metadata.extensions.openapi` (ZNIGHT030 when missing, ZNIGHT018 for another version). */
export function openApiSection(metadata: ZnightMetadata): OpenApiMetadata {
  const section = (metadata?.extensions as { openapi?: unknown } | undefined)?.openapi
  if (section === undefined || section === null || typeof section !== 'object') {
    throw new ZnightError(
      ErrorCode.InvalidOpenApiDefinition,
      'The metadata has no OpenAPI section (metadata.extensions.openapi)',
      {
        hints: [
          'Import @znight/openapi in a scanned file (src/main.ts imports OpenApiPlugin) and regenerate the container (znight generate)',
        ],
      },
    )
  }
  const version = (section as { version?: unknown }).version
  if (version !== OPENAPI_METADATA_VERSION) {
    throw new ZnightError(
      ErrorCode.VersionMismatch,
      `Unsupported metadata.extensions.openapi version ${JSON.stringify(version)} (this @znight/openapi reads version ${OPENAPI_METADATA_VERSION})`,
      { hints: ['Use the same version of @znight/compiler and @znight/openapi, then regenerate the container'] },
    )
  }
  const value = section as OpenApiMetadata
  if (!Array.isArray(value.operations) || !Array.isArray(value.schemas) || typeof value.document !== 'object') {
    throw new ZnightError(ErrorCode.InvalidOpenApiDefinition, 'Malformed metadata.extensions.openapi', {
      hints: ['Regenerate the container (znight generate)'],
    })
  }
  return value
}

/**
 * Assembles the OpenAPI 3.1 document of an application from its generated metadata: converts the
 * Standard Schemas (user converters, Standard JSON Schema, Valibot), hoists their `$defs`, names
 * the components, fills the placeholders of the compiler, applies `filter`, prunes the unused
 * components, applies `transform`, deep-freezes and serialises once.
 *
 * @throws ZnightError ZNIGHT030 (no OpenAPI section), ZNIGHT018 (another format version), ZNIGHT034
 *   (component name conflict), ZNIGHT037 (schema conversion, unless `unrepresentable: 'warn'`).
 */
export async function buildOpenApiDocument(
  metadata: ZnightMetadata,
  options: BuildOpenApiOptions = {},
): Promise<OpenApiBuildResult> {
  const started = performance.now()
  const section = openApiSection(metadata)
  const warnings: OpenApiWarning[] = []
  const lenient = options.unrepresentable === 'warn'
  const converters = [...(options.converters ?? []), ...BUILT_IN_CONVERTERS]

  // 1. conversion of the Standard Schemas
  const failures: string[] = []
  const converted = new Map<string, { input?: JsonSchema; output?: JsonSchema }>()
  for (const slot of section.schemas) {
    const entry: { input?: JsonSchema; output?: JsonSchema } = {}
    for (const io of [...slot.io].sort()) {
      const result = await convertSlot(slot, io, converters, false)
      if (result.schema !== undefined) {
        entry[io] = result.schema
        continue
      }
      if (!lenient) {
        failures.push(result.message)
        continue
      }
      const retried = await convertSlot(slot, io, converters, true)
      entry[io] = retried.schema ?? {}
      warnings.push({
        code: ErrorCode.SchemaConversionFailed,
        message: `${result.message}; documented as ${retried.schema === undefined ? 'any value ({})' : 'an approximation'}`,
        hints: [],
      })
    }
    converted.set(slot.name, entry)
  }
  if (failures.length > 0) {
    throw new ZnightError(
      ErrorCode.SchemaConversionFailed,
      `Cannot convert ${failures.length === 1 ? 'a schema' : `${failures.length} schemas`} to JSON Schema:\n${failures.map(line => `  - ${line}`).join('\n')}`,
      {
        hints: [
          'Add a converter (OpenApiPlugin.configure({ converters }), --converters), or document the schema with unrepresentable: "warn"',
        ],
      },
    )
  }

  // 2. names of the converted schemas
  const schemas = new Map<string, JsonSchema>()
  const owners = new Map<string, string>()
  const define = (name: string, schema: JsonSchema, owner: string): void => {
    const existing = schemas.get(name)
    if (existing === undefined) {
      schemas.set(name, schema)
      owners.set(name, owner)
      return
    }
    if (jsonEquals(existing, schema)) return
    throw new ZnightError(
      ErrorCode.SchemaNameConflict,
      `Two different schemas are named "${name}" in the OpenAPI document (${owners.get(name)} and ${owner})`,
      { hints: ['Rename one of them (exported schema names and ids of hoisted definitions name the components)'] },
    )
  }
  for (const [name, schema] of Object.entries(section.components ?? {}))
    define(name, schema as JsonSchema, 'a TypeScript declaration')
  const slotNames = new Map<string, { input?: string; output?: string }>()
  const pending: { name: string; schema: JsonSchema; owner: string }[] = []
  for (const slot of section.schemas) {
    const entry = converted.get(slot.name) ?? {}
    const input = entry.input === undefined ? undefined : clean(entry.input)
    const output = entry.output === undefined ? undefined : clean(entry.output)
    const names: { input?: string; output?: string } = {}
    if (input !== undefined && output !== undefined && !jsonEquals(input, output)) {
      names.output = slot.name
      names.input = `${slot.name}Input`
    } else {
      if (input !== undefined) names.input = slot.name
      if (output !== undefined) names.output = slot.name
    }
    slotNames.set(slot.name, names)
    for (const io of ['output', 'input'] as const) {
      const schema = io === 'input' ? input : output
      const name = names[io]
      if (schema === undefined || name === undefined) continue
      if (io === 'input' && name === names.output) continue
      const hoisted = hoist(schema, name)
      pending.push({ name, schema: hoisted.schema, owner: `the schema ${slot.name}` })
      for (const [defName, defSchema] of hoisted.defs)
        pending.push({ name: defName, schema: defSchema, owner: `a definition of ${slot.name}` })
    }
  }
  for (const item of pending) define(item.name, item.schema, item.owner)

  // 3. standard errors
  const errors = section.errors
  const responses: Json = {}
  if (errors !== undefined) {
    let body: string
    let validation: string
    if (errors.schema === undefined) {
      define(ERROR_COMPONENTS.body, HTTP_ERROR_BODY, 'the standard errors')
      define(ERROR_COMPONENTS.validation, VALIDATION_ERROR_BODY, 'the standard errors')
      body = ERROR_COMPONENTS.body
      validation = ERROR_COMPONENTS.validation
    } else {
      body = slotNames.get(errors.schema)?.output ?? errors.schema
      validation = body
    }
    const response = (status: string, name: string): Json => ({
      description: reasonPhrase(status),
      content: { [errors.contentType]: { schema: { $ref: schemaRef(name) } } },
    })
    responses[ERROR_RESPONSES.badRequest] = response('400', validation)
    responses[ERROR_RESPONSES.payloadTooLarge] = response('413', body)
    responses[ERROR_RESPONSES.unsupportedMediaType] = response('415', body)
  }

  // 4. placeholders
  const resolve = (value: unknown): unknown => replacePlaceholders(value, slotNames, schemas)
  for (const [name, schema] of schemas) schemas.set(name, resolve(schema) as JsonSchema)

  // 5. operations, filter
  const views = operationViews(metadata, section)
  const paths: Record<string, Json> = {}
  let operations = 0
  section.operations.forEach((definition, index) => {
    const view = views[index] as OpenApiOperationView
    if (options.filter !== undefined && !options.filter(view)) return
    let item = paths[definition.path]
    if (item === undefined) {
      item = {}
      paths[definition.path] = item
    }
    item[definition.method] = resolve(definition.operation)
    operations++
  })

  // 6. document
  const template = section.document
  const document: Json = { openapi: template.openapi }
  document['info'] = options.info === undefined ? template.info : { ...template.info, ...options.info }
  const servers =
    options.servers ??
    template.servers ??
    (options.prefix !== undefined && options.prefix !== '' && options.prefix !== '/'
      ? [{ url: options.prefix }]
      : undefined)
  if (servers !== undefined) document['servers'] = servers
  if (template.security !== undefined) document['security'] = template.security
  const tags = tagsOf(template.tags ?? [], paths, section.tagDescriptions ?? {})
  if (tags.length > 0) document['tags'] = tags
  if (template.externalDocs !== undefined) document['externalDocs'] = template.externalDocs
  document['paths'] = paths
  const components = prune(document, {
    schemas: Object.fromEntries([...schemas].sort(([a], [b]) => compareStrings(a, b))),
    responses,
    securitySchemes: section.securitySchemes ?? {},
  })
  if (Object.keys(components).length > 0) document['components'] = components
  for (const [key, value] of Object.entries(template)) {
    if (key.startsWith('x-') && value !== undefined) document[key] = value
  }
  document['x-znight-fingerprint'] = section.fingerprint

  // 7. output
  const transformed =
    options.transform === undefined
      ? (document as unknown as OpenApiObject)
      : options.transform(document as unknown as OpenApiObject)
  const json = `${JSON.stringify(transformed, null, 2)}\n`
  const frozen = deepFreeze(JSON.parse(json) as OpenApiObject)
  const componentCount = Object.keys((frozen.components?.schemas ?? {}) as object).length
  return {
    document: frozen,
    json,
    warnings,
    stats: { operations, schemas: componentCount, durationMs: performance.now() - started },
  }
}

async function convertSlot(
  slot: OpenApiSchemaSlot,
  io: 'input' | 'output',
  converters: readonly SchemaConverter[],
  lenient: boolean,
): Promise<{ schema: JsonSchema | undefined; message: string }> {
  const where = slot.source === undefined ? '' : ` (${slot.source.file}:${slot.source.line}:${slot.source.column})`
  const label = `${slot.name}${where}, ${vendorOf(slot.schema)} schema, ${io}`
  for (const converter of converters) {
    let result: unknown
    try {
      result = await converter.convert(slot.schema as StandardSchemaV1, { io, target: 'draft-2020-12', lenient })
    } catch (error) {
      return {
        schema: undefined,
        message: `${label}: the converter "${converter.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (result === undefined) continue
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      return {
        schema: undefined,
        message: `${label}: the converter "${converter.name}" returned ${Array.isArray(result) ? 'an array' : typeof result} instead of a JSON Schema object`,
      }
    }
    return { schema: result as JsonSchema, message: '' }
  }
  return {
    schema: undefined,
    message: `${label}: no converter supports it (the library implements no Standard JSON Schema)`,
  }
}

/** Drops `$schema` and `$id` (top level). */
function clean(schema: JsonSchema): JsonSchema {
  const { $schema: _schema, $id: _id, ...rest } = schema
  return JSON.parse(JSON.stringify(rest)) as JsonSchema
}

/**
 * Hoists `$defs` / `definitions` into components and rewrites the references: inside an OpenAPI
 * document `#` is the document, not the schema (`#/$defs/X` → `#/components/schemas/X`,
 * `#` → `#/components/schemas/<name>`).
 */
function hoist(schema: JsonSchema, name: string): { schema: JsonSchema; defs: Map<string, JsonSchema> } {
  const defs = new Map<string, JsonSchema>()
  const collect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    for (const key of ['$defs', 'definitions']) {
      const block = (value as Json)[key]
      if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
        for (const [defName, def] of Object.entries(block)) defs.set(defName, def as JsonSchema)
      }
    }
    for (const [key, item] of Object.entries(value)) if (key !== '$defs' && key !== 'definitions') collect(item)
  }
  collect(schema)
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (typeof value !== 'object' || value === null) return value
    const result: Json = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === '$defs' || key === 'definitions') continue
      if (key === '$ref' && typeof item === 'string') result[key] = rewriteRef(item, name)
      else result[key] = rewrite(item)
    }
    return result
  }
  const hoisted = new Map<string, JsonSchema>()
  for (const [defName, def] of defs) hoisted.set(defName, rewrite(def) as JsonSchema)
  return { schema: rewrite(schema) as JsonSchema, defs: hoisted }
}

function rewriteRef(ref: string, self: string): string {
  for (const prefix of ['#/$defs/', '#/definitions/']) {
    if (ref.startsWith(prefix)) return `#/components/schemas/${ref.slice(prefix.length)}`
  }
  if (ref === '#') return schemaRef(self)
  if (ref.startsWith('#/')) return `${schemaRef(self)}${ref.slice(1)}`
  return ref
}

function isPlaceholder(
  value: unknown,
): value is { $znight: string; name: string; io: 'input' | 'output'; in?: string } {
  return typeof value === 'object' && value !== null && typeof (value as { $znight?: unknown }).$znight === 'string'
}

function replacePlaceholders(
  value: unknown,
  names: ReadonlyMap<string, { input?: string; output?: string }>,
  schemas: ReadonlyMap<string, JsonSchema>,
): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value) {
      if (isPlaceholder(item) && item.$znight === 'parameters') result.push(...expandParameters(item, names, schemas))
      else result.push(replacePlaceholders(item, names, schemas))
    }
    return result
  }
  if (typeof value !== 'object' || value === null) return value
  if (isPlaceholder(value) && value.$znight === 'schema') {
    const name = names.get(value.name)?.[value.io] ?? value.name
    return { $ref: schemaRef(name) }
  }
  const result: Json = {}
  for (const [key, item] of Object.entries(value)) result[key] = replacePlaceholders(item, names, schemas)
  return result
}

/** One parameter per property of the (input) object schema of a slot. */
function expandParameters(
  placeholder: { name: string; in?: string },
  names: ReadonlyMap<string, { input?: string; output?: string }>,
  schemas: ReadonlyMap<string, JsonSchema>,
): Json[] {
  const name = names.get(placeholder.name)?.input ?? placeholder.name
  let schema = schemas.get(name)
  for (let depth = 0; depth < 8 && typeof schema?.['$ref'] === 'string'; depth++) {
    schema = schemas.get(String(schema['$ref']).slice('#/components/schemas/'.length))
  }
  const properties = schema?.['properties']
  if (schema === undefined || typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new ZnightError(
      ErrorCode.SchemaConversionFailed,
      `The ${placeholder.in ?? 'query'} schema ${placeholder.name} is not an object schema: its properties cannot become parameters`,
      { hints: [`Validate the whole ${placeholder.in ?? 'query'} object with an object schema (z.object({...}))`] },
    )
  }
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])
  return Object.entries(properties).map(([property, propertySchema]) => {
    const { description, ...rest } = propertySchema as Json
    const parameter: Json = { name: property, in: placeholder.in ?? 'query' }
    if (typeof description === 'string') parameter['description'] = description
    if (placeholder.in === 'path' || required.has(property)) parameter['required'] = true
    parameter['schema'] = rest
    if ((rest['type'] === 'array' || Array.isArray(rest['items'])) && placeholder.in === 'query') {
      parameter['style'] = 'form'
      parameter['explode'] = true
    }
    return parameter
  })
}

/** Declared tags first (in order), then the used tags, sorted. */
function tagsOf(
  declared: readonly TagObject[],
  paths: Readonly<Record<string, Json>>,
  descriptions: Readonly<Record<string, string>>,
): TagObject[] {
  const tags: TagObject[] = [...declared]
  const known = new Set(declared.map(tag => tag.name))
  const used = new Set<string>()
  for (const item of Object.values(paths)) {
    for (const operation of Object.values(item)) {
      for (const tag of ((operation as { tags?: unknown }).tags ?? []) as string[]) used.add(tag)
    }
  }
  for (const tag of [...used].sort(compareStrings)) {
    if (known.has(tag)) continue
    const description = descriptions[tag]
    tags.push(description === undefined ? { name: tag } : { name: tag, description })
  }
  return tags
}

/** Components referenced by the document (paths, security), transitively. */
function prune(document: Json, components: { schemas: Json; responses: Json; securitySchemes: Json }): Json {
  const used = { schemas: new Set<string>(), responses: new Set<string>(), securitySchemes: new Set<string>() }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') {
        const match = /^#\/components\/(schemas|responses)\/([^/]+)/.exec(item)
        const kind = match?.[1] as 'schemas' | 'responses' | undefined
        const name =
          match?.[2] === undefined
            ? undefined
            : decodeURIComponent(match[2].replaceAll('~1', '/').replaceAll('~0', '~'))
        if (kind !== undefined && name !== undefined && !used[kind].has(name)) {
          used[kind].add(name)
          visit(components[kind][name])
        }
      } else if (key === 'security' && Array.isArray(item)) {
        for (const requirement of item)
          for (const scheme of Object.keys(requirement as object)) used.securitySchemes.add(scheme)
      } else {
        visit(item)
      }
    }
  }
  visit(document)
  const result: Json = {}
  for (const kind of ['schemas', 'responses', 'securitySchemes'] as const) {
    const kept: Json = {}
    for (const name of Object.keys(components[kind]).sort(compareStrings)) {
      if (used[kind].has(name)) kept[name] = components[kind][name]
    }
    if (Object.keys(kept).length > 0) result[kind] = kept
  }
  return result
}

/** Views of the operations of the section (effective route metadata from `extensions.http`). */
export function operationViews(
  metadata: ZnightMetadata,
  section: OpenApiMetadata = openApiSection(metadata),
): OpenApiOperationView[] {
  const http = (metadata.extensions as { http?: HttpSectionLike } | undefined)?.http
  const groups = new Map<string, string>()
  for (const [group, definition] of Object.entries(http?.groups ?? {})) {
    for (const key of definition.keys ?? []) groups.set(key, group)
  }
  const groupOf = (key: string): string => groups.get(key) ?? key
  return section.operations.map(definition => {
    const controller = http?.controllers?.find(candidate => candidate.token === definition.controller)
    const route = controller?.routes?.find(
      candidate => candidate.handler === definition.handler && candidate.method === definition.route,
    )
    const routeMeta = route?.meta ?? {}
    const decided = new Set(Object.keys(routeMeta).map(groupOf))
    const meta: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(controller?.meta ?? {})) if (!decided.has(groupOf(key))) meta[key] = value
    Object.assign(meta, routeMeta)
    const operation = definition.operation as { operationId?: string; tags?: readonly string[] }
    return Object.freeze({
      method: definition.method,
      path: definition.path,
      operationId: operation.operationId ?? '',
      tags: Object.freeze([...(operation.tags ?? [])]),
      controller: displayName(definition.controller),
      handler: definition.handler,
      meta: Object.freeze(meta),
    })
  })
}

/** The parts of `metadata.extensions.http` read for the effective metadata. */
interface HttpSectionLike {
  readonly controllers?: readonly {
    readonly token: string
    readonly meta?: Readonly<Record<string, unknown>>
    readonly routes?: readonly {
      readonly method: string
      readonly handler: string
      readonly meta?: Readonly<Record<string, unknown>>
    }[]
  }[]
  readonly groups?: Readonly<Record<string, { readonly keys?: readonly string[] }>>
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

/** `HttpErrorBody` (the body of every Znight error response). */
const HTTP_ERROR_BODY: JsonSchema = {
  type: 'object',
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    message: { type: 'string' },
    details: {},
  },
  required: ['statusCode', 'error', 'message'],
}

/** `ValidationErrorBody`: a 400 body; validation failures list their issues in `details`. */
const VALIDATION_ERROR_BODY: JsonSchema = {
  allOf: [
    { $ref: schemaRef(ERROR_COMPONENTS.body) },
    {
      type: 'object',
      properties: {
        details: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, message: { type: 'string' } },
            required: ['path', 'message'],
          },
        },
      },
    },
  ],
} satisfies Record<string, JsonValue>
