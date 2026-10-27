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
import {
  compareStrings,
  componentName,
  ERROR_COMPONENTS,
  ERROR_RESPONSES,
  jsonEquals,
  reasonPhrase,
  schemaRef,
} from './shared.ts'

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
  const named = nameConverted(section.schemas, converted)
  for (const item of named.components) define(item.name, item.schema, item.owner)
  const slotNames = named.slots

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
  const duplicates: string[] = []
  const resolve = (value: unknown, where = ''): unknown =>
    replacePlaceholders(value, slotNames, schemas, (parameter, slot) =>
      duplicates.push(`${where}: the ${parameter.in} parameter "${parameter.name}" of the schema ${slot}`),
    )
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
    item[definition.method] = resolve(definition.operation, `${definition.method.toUpperCase()} ${definition.path}`)
    operations++
  })
  if (duplicates.length > 0) {
    warnings.push({
      code: ErrorCode.InconsistentOperation,
      message: `${duplicates.length === 1 ? 'A parameter expanded from a whole-object schema is' : 'Parameters expanded from whole-object schemas are'} already documented (OpenAPI forbids two parameters with one name and location), the duplicate is dropped:\n${duplicates.map(line => `  - ${line}`).join('\n')}`,
      hints: ["Remove the property from the schema, or the @Query('name') / @ApiQuery('name') that reads it again"],
    })
  }

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

/** Root keys of a document, in the order {@link buildOpenApiDocument} writes them. */
const ROOT_ORDER = ['openapi', 'info', 'servers', 'security', 'tags', 'externalDocs', 'paths', 'components']

/**
 * Applies the runtime options of {@link buildOpenApiDocument} to a prebuilt document (`OpenApiPlugin`
 * with `document: { file }`), so that a file and a build serve the same document: `filter` (the
 * operations are matched by path and method, unreferenced components and unused tags are pruned),
 * `info`, `servers`, else the `prefix` rule when the file declares no servers, then `transform`.
 * `undefined` when there is nothing to apply (the file is served as is).
 */
export function applyDocumentOptions(
  text: string,
  metadata: ZnightMetadata,
  options: Pick<BuildOpenApiOptions, 'filter' | 'info' | 'servers' | 'transform' | 'prefix'>,
): { document: OpenApiObject; json: string } | undefined {
  const document = JSON.parse(text) as Json
  const prefixed =
    document['servers'] === undefined && options.prefix !== undefined && options.prefix !== '' && options.prefix !== '/'
  if (
    options.filter === undefined &&
    options.info === undefined &&
    options.servers === undefined &&
    options.transform === undefined &&
    !prefixed
  ) {
    return undefined
  }
  if (options.filter !== undefined) filterDocument(document, metadata, options.filter)
  if (options.info !== undefined) document['info'] = { ...(document['info'] as Json), ...options.info }
  if (options.servers !== undefined) document['servers'] = options.servers
  else if (prefixed) document['servers'] = [{ url: options.prefix }]
  const ordered: Json = {}
  for (const key of ROOT_ORDER) if (document[key] !== undefined) ordered[key] = document[key]
  for (const [key, value] of Object.entries(document)) if (!(key in ordered)) ordered[key] = value
  const transformed =
    options.transform === undefined
      ? (ordered as unknown as OpenApiObject)
      : options.transform(ordered as unknown as OpenApiObject)
  const json = `${JSON.stringify(transformed, null, 2)}\n`
  return { document: deepFreeze(JSON.parse(json) as OpenApiObject), json }
}

/** Removes the operations `filter` rejects, the paths left empty, the unused tags and components. */
function filterDocument(
  document: Json,
  metadata: ZnightMetadata,
  filter: (operation: OpenApiOperationView) => boolean,
): void {
  const section = openApiSection(metadata)
  const views = new Map<string, OpenApiOperationView>()
  for (const view of operationViews(metadata, section)) views.set(`${view.method} ${view.path}`, view)
  const paths: Record<string, Json> = {}
  for (const [path, item] of Object.entries((document['paths'] ?? {}) as Record<string, Json>)) {
    const kept: Json = {}
    let methods = 0
    for (const [key, value] of Object.entries(item)) {
      if (METHODS.has(key)) {
        // an operation unknown to this build (stale file) is kept: the filter cannot judge it
        const view = views.get(`${key} ${path}`)
        if (view !== undefined && !filter(view)) continue
        methods++
      }
      kept[key] = value
    }
    if (methods > 0) paths[path] = kept
  }
  document['paths'] = paths
  if (Array.isArray(document['tags'])) {
    const declared = new Set((section.document.tags ?? []).map(tag => tag.name))
    const used = new Set(tagsOf([], paths, {}).map(tag => tag.name))
    const tags = (document['tags'] as TagObject[]).filter(tag => declared.has(tag.name) || used.has(tag.name))
    if (tags.length > 0) document['tags'] = tags
    else delete document['tags']
  }
  const components = (document['components'] ?? {}) as Json
  delete document['components']
  const pruned = prune(document, {
    schemas: (components['schemas'] ?? {}) as Json,
    responses: (components['responses'] ?? {}) as Json,
    securitySchemes: (components['securitySchemes'] ?? {}) as Json,
  })
  const result: Json = {}
  for (const [kind, value] of Object.entries(components)) {
    if (kind !== 'schemas' && kind !== 'responses' && kind !== 'securitySchemes') result[kind] = value
    else if (pruned[kind] !== undefined) result[kind] = pruned[kind]
  }
  if (Object.keys(result).length > 0) document['components'] = result
}

const METHODS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

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
 * Definition names a library generates for anonymous sub-schemas (Zod: `__schema0` for a recursive
 * schema without id). They are local to one conversion, so they are scoped to their slot.
 */
const ANONYMOUS_DEFINITION = /^__schema(\d+)$/

/** Marks the references between definitions until the final names are known (`\0<name>\0<rest>`). */
const MARK = '\u0000'

/** A JSON Schema of one slot and one io, split into its root and its local definitions. */
interface ConvertedUnit {
  readonly slot: string
  readonly io: 'input' | 'output'
  /** Global names of the bodies (the root is the slot name), references marked. */
  readonly bodies: { readonly name: string; readonly body: unknown; readonly owner: string }[]
}

/**
 * Names the converted schemas (steps 3 and 4 of §7.3): hoists `$defs` / `definitions` into
 * components, scopes anonymous definitions to their slot (`Tree_schema0`), takes the definition as
 * the slot component when the root only references it (`.meta({ id })` equal to the export name),
 * and gives `<Name>Input` to the input variant of every schema — slot or definition — whose input
 * and output JSON Schemas differ (directly or through the definitions it references). Two different
 * schemas of one io under one name are ZNIGHT034.
 */
function nameConverted(
  slots: readonly OpenApiSchemaSlot[],
  converted: ReadonlyMap<string, { input?: JsonSchema; output?: JsonSchema }>,
): {
  components: { name: string; schema: JsonSchema; owner: string }[]
  slots: Map<string, { input?: string; output?: string }>
} {
  const units: ConvertedUnit[] = []
  for (const slot of slots) {
    const entry = converted.get(slot.name) ?? {}
    for (const io of ['output', 'input'] as const) {
      const schema = entry[io]
      if (schema !== undefined) units.push(splitUnit(slot.name, io, clean(schema)))
    }
  }
  // variants of every global name, by io
  const variants = new Map<string, { input?: unknown; output?: unknown; owners: Partial<Record<string, string>> }>()
  for (const unit of units) {
    for (const { name, body, owner } of unit.bodies) {
      let entry = variants.get(name)
      if (entry === undefined) {
        entry = { owners: {} }
        variants.set(name, entry)
      }
      const existing = entry[unit.io]
      if (existing === undefined) {
        entry[unit.io] = body
        entry.owners[unit.io] = owner
      } else if (!jsonEquals(existing, body)) {
        throw new ZnightError(
          ErrorCode.SchemaNameConflict,
          `Two different schemas are named "${name}" in the OpenAPI document (${entry.owners[unit.io]} and ${owner})`,
          { hints: ['Rename one of them (exported schema names and ids of hoisted definitions name the components)'] },
        )
      }
    }
  }
  // `<Name>Input` when the input variant differs, directly or through a definition it references
  const split = new Set<string>()
  for (const [name, entry] of variants) {
    if (entry.input !== undefined && entry.output !== undefined && !jsonEquals(entry.input, entry.output)) {
      split.add(name)
    }
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, entry] of variants) {
      if (split.has(name) || entry.input === undefined || entry.output === undefined) continue
      if ([...referencedNames(entry.input)].some(target => split.has(target))) {
        split.add(name)
        changed = true
      }
    }
  }
  const nameFor = (name: string, io: 'input' | 'output'): string =>
    io === 'input' && split.has(name) ? `${name}Input` : name
  const components: { name: string; schema: JsonSchema; owner: string }[] = []
  for (const [name, entry] of variants) {
    if (entry.output !== undefined) {
      components.push({
        name,
        schema: resolveMarks(entry.output, 'output', nameFor) as JsonSchema,
        owner: entry.owners['output'] as string,
      })
    }
    if (entry.input !== undefined && (entry.output === undefined || split.has(name))) {
      components.push({
        name: nameFor(name, 'input'),
        schema: resolveMarks(entry.input, 'input', nameFor) as JsonSchema,
        owner: entry.owners['input'] as string,
      })
    }
  }
  const names = new Map<string, { input?: string; output?: string }>()
  for (const slot of slots) {
    const entry = converted.get(slot.name) ?? {}
    const result: { input?: string; output?: string } = {}
    if (entry.output !== undefined) result.output = nameFor(slot.name, 'output')
    if (entry.input !== undefined) result.input = nameFor(slot.name, 'input')
    names.set(slot.name, result)
  }
  return { components, slots: names }
}

/**
 * Splits a converted schema into its root and its `$defs` / `definitions` (at every level), with
 * global names: the slot name for the root, `<slot>_schemaN` for anonymous definitions, the
 * definition name (a library id) otherwise. Inside an OpenAPI document `#` is the document, not the
 * schema, so every local reference is rewritten (`#/$defs/X`, `#`, `#/properties/...`).
 */
function splitUnit(slot: string, io: 'input' | 'output', schema: JsonSchema): ConvertedUnit {
  const defs = new Map<string, unknown>()
  const collect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    for (const key of ['$defs', 'definitions']) {
      const block = (value as Json)[key]
      if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
        for (const [defName, def] of Object.entries(block)) defs.set(defName, def)
      }
    }
    for (const [key, item] of Object.entries(value)) if (key !== '$defs' && key !== 'definitions') collect(item)
  }
  collect(schema)
  const globals = new Map<string, string>()
  for (const local of defs.keys()) {
    const anonymous = ANONYMOUS_DEFINITION.exec(local)
    globals.set(local, anonymous === null ? componentName(local) : componentName(`${slot}_schema${anonymous[1]}`))
  }
  let root: unknown = schema
  // `{ $ref: '#/$defs/X', $defs: { X } }` (Zod `.meta({ id })` on the root): X is the slot itself
  const keys = Object.keys(schema).filter(key => key !== '$defs' && key !== 'definitions')
  const target = keys.length === 1 && typeof schema['$ref'] === 'string' ? localTarget(schema['$ref']) : undefined
  if (target !== undefined && target.rest === '' && defs.has(target.local)) {
    const global = globals.get(target.local) as string
    if (global === slot || ANONYMOUS_DEFINITION.test(target.local)) {
      root = defs.get(target.local)
      defs.delete(target.local)
      globals.set(target.local, slot)
    }
  }
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (typeof value !== 'object' || value === null) return value
    const result: Json = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === '$defs' || key === 'definitions') continue
      if (key === '$ref' && typeof item === 'string') result[key] = markRef(item, slot, globals)
      else result[key] = rewrite(item)
    }
    return result
  }
  const bodies = [{ name: slot, body: rewrite(root), owner: `the schema ${slot}` }]
  for (const [local, def] of defs) {
    bodies.push({ name: globals.get(local) as string, body: rewrite(def), owner: `a definition of ${slot}` })
  }
  return { slot, io, bodies }
}

/** The local definition a reference points to (`#/$defs/X/rest`), JSON pointer and URI escapes decoded. */
function localTarget(ref: string): { local: string; rest: string } | undefined {
  for (const prefix of ['#/$defs/', '#/definitions/']) {
    if (!ref.startsWith(prefix)) continue
    const tail = ref.slice(prefix.length)
    const slash = tail.indexOf('/')
    const segment = slash === -1 ? tail : tail.slice(0, slash)
    let local: string
    try {
      local = decodeURIComponent(segment)
    } catch {
      local = segment
    }
    return { local: local.replaceAll('~1', '/').replaceAll('~0', '~'), rest: slash === -1 ? '' : tail.slice(slash) }
  }
  return undefined
}

function markRef(ref: string, slot: string, globals: ReadonlyMap<string, string>): string {
  const target = localTarget(ref)
  if (target !== undefined) {
    return `${MARK}${globals.get(target.local) ?? componentName(target.local)}${MARK}${target.rest}`
  }
  if (ref === '#') return `${MARK}${slot}${MARK}`
  if (ref.startsWith('#/')) return `${MARK}${slot}${MARK}${ref.slice(1)}`
  return ref
}

function parseMark(ref: string): { name: string; rest: string } | undefined {
  if (!ref.startsWith(MARK)) return undefined
  const end = ref.indexOf(MARK, 1)
  return end === -1 ? undefined : { name: ref.slice(1, end), rest: ref.slice(end + 1) }
}

/** Global names referenced by a marked body. */
function referencedNames(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) referencedNames(item, found)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const mark = key === '$ref' && typeof item === 'string' ? parseMark(item) : undefined
      if (mark === undefined) referencedNames(item, found)
      else found.add(mark.name)
    }
  }
  return found
}

/** Replaces the marked references with `#/components/schemas/<final name>`. */
function resolveMarks(
  value: unknown,
  io: 'input' | 'output',
  nameFor: (name: string, io: 'input' | 'output') => string,
): unknown {
  if (Array.isArray(value)) return value.map(item => resolveMarks(item, io, nameFor))
  if (typeof value !== 'object' || value === null) return value
  const result: Json = {}
  for (const [key, item] of Object.entries(value)) {
    const mark = key === '$ref' && typeof item === 'string' ? parseMark(item) : undefined
    result[key] =
      mark === undefined ? resolveMarks(item, io, nameFor) : `${schemaRef(nameFor(mark.name, io))}${mark.rest}`
  }
  return result
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
  duplicate: (parameter: { in: string; name: string }, slot: string) => void,
): unknown {
  if (Array.isArray(value)) {
    if (!value.some(item => isPlaceholder(item) && item.$znight === 'parameters')) {
      return value.map(item => replacePlaceholders(item, names, schemas, duplicate))
    }
    // a parameters array: OpenAPI forbids two parameters with one name and location, explicit ones win
    const explicit = new Set<string>()
    for (const item of value) {
      const key = isPlaceholder(item) ? undefined : parameterKey(item)
      if (key !== undefined) explicit.add(key)
    }
    const expanded = new Set<string>()
    const result: unknown[] = []
    for (const item of value) {
      if (!isPlaceholder(item) || item.$znight !== 'parameters') {
        result.push(replacePlaceholders(item, names, schemas, duplicate))
        continue
      }
      for (const parameter of expandParameters(item, names, schemas)) {
        const key = parameterKey(parameter) as string
        if (explicit.has(key) || expanded.has(key)) {
          duplicate(parameter as { in: string; name: string }, item.name)
          continue
        }
        expanded.add(key)
        result.push(parameter)
      }
    }
    return result
  }
  if (typeof value !== 'object' || value === null) return value
  if (isPlaceholder(value) && value.$znight === 'schema') {
    const name = names.get(value.name)?.[value.io] ?? value.name
    return { $ref: schemaRef(name) }
  }
  const result: Json = {}
  for (const [key, item] of Object.entries(value)) result[key] = replacePlaceholders(item, names, schemas, duplicate)
  return result
}

/** `in name` of a Parameter Object (header names are case-insensitive), `undefined` for a `$ref`. */
function parameterKey(parameter: unknown): string | undefined {
  if (typeof parameter !== 'object' || parameter === null) return undefined
  const { in: location, name } = parameter as { in?: unknown; name?: unknown }
  if (typeof location !== 'string' || typeof name !== 'string') return undefined
  return `${location} ${location === 'header' ? name.toLowerCase() : name}`
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
