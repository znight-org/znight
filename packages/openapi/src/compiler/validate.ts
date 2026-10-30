/**
 * `validate`: builds the whole OpenAPI model once per compile (document options, security schemes,
 * operations, components, Standard Schema slots), reports its diagnostics and keeps it for
 * `generate` (keyed by the application graph).
 */
import type { ApplicationGraph, Location, ValidateContext } from '@znight/compiler'
import type { JsonSchema, JsonValue, SecuritySchemeObject } from '../types.ts'
import type { OpenApiStored, SlotData } from './model.ts'
import type { OperationModel } from './operations.ts'

import { compareStrings, ERROR_COMPONENTS } from '../shared.ts'
import { documentTemplate, readDocument, SchemeRegistry } from './document.ts'
import { buildOperations } from './operations.ts'
import { Schemas, Slots } from './schemas.ts'

/** Everything `generate` emits. */
export interface OpenApiModel {
  readonly document: Record<string, JsonValue>
  readonly operations: readonly OperationModel[]
  readonly components: Readonly<Record<string, JsonSchema>>
  readonly securitySchemes: Readonly<Record<string, SecuritySchemeObject>>
  readonly slots: readonly SlotData[]
  readonly errors: { readonly contentType: string; readonly schema?: string } | undefined
  readonly tagDescriptions: Readonly<Record<string, string>>
  /** Root of the project (relative `source` locations). */
  readonly root: string
}

/**
 * Models by compile. The key is `graph.extensions`: the validate and generate contexts of one
 * compile get different graph objects (diagnostics, pruning) sharing this array.
 */
const models = new WeakMap<object, OpenApiModel>()

/** `validate` of the extension. */
export function validateOpenApi(ctx: ValidateContext<OpenApiStored>): void {
  models.set(ctx.graph.extensions, buildModel(ctx))
}

/** The model built by `validate` for the compile of `graph`. */
export function modelOf(graph: ApplicationGraph): OpenApiModel | undefined {
  return models.get(graph.extensions)
}

function buildModel(ctx: ValidateContext<OpenApiStored>): OpenApiModel {
  const schemes = new SchemeRegistry(ctx)
  const document = readDocument(ctx, schemes)
  const reserved = new Set<string>(
    document.errors === false ? [] : [ERROR_COMPONENTS.body, ERROR_COMPONENTS.validation],
  )
  const slots = new Slots(
    diagnostic => ctx.report(diagnostic),
    () => reserved,
    ref => declarationOf(ctx, ref.identity),
  )
  const schemas = new Schemas(ctx, { jsdoc: document.jsdoc, strict: document.strict, reserved }, slots)
  const errorsSlot =
    document.errors === false || document.errors.schema === undefined
      ? undefined
      : slots.use(document.errors.schema, 'output')
  const { operations, tagDescriptions } = buildOperations({ ctx, document, schemes, schemas, slots })
  schemas.settle()
  const rootSecurity = document.security === undefined ? undefined : schemes.objects(document.security)
  const securitySchemes: Record<string, SecuritySchemeObject> = {}
  for (const name of [...schemes.used.keys()].sort(compareStrings)) {
    securitySchemes[name] = schemes.used.get(name)?.definition as SecuritySchemeObject
  }
  return {
    document: documentTemplate(document, rootSecurity),
    operations,
    components: schemas.components(),
    securitySchemes,
    slots: slots.list(),
    errors: errorsOf(document.errors, errorsSlot?.name),
    tagDescriptions,
    root: ctx.options.root,
  }
}

function errorsOf(
  errors: false | { readonly contentType: string },
  schema: string | undefined,
): OpenApiModel['errors'] {
  if (errors === false) return undefined
  return schema === undefined ? { contentType: errors.contentType } : { contentType: errors.contentType, schema }
}

/** Location of the declaration of an identity (`export const CreateBook = ...`). */
function declarationOf(ctx: ValidateContext<OpenApiStored>, identity: string | undefined): Location | undefined {
  if (identity === undefined) return undefined
  const symbol = ctx.project.lookupIdentity(identity)
  if (symbol.kind !== 'declaration') return undefined
  const declaration = symbol.declarations[0]
  if (declaration === undefined) return undefined
  return ctx.project.getFile(declaration.file)?.location(declaration.span)
}

/** `{ file, line, column }` of a location, the file relative to `root`. */
export function sourceOf(location: Location, root: string): { file: string; line: number; column: number } {
  const file = location.file.startsWith(`${root}/`) ? location.file.slice(root.length + 1) : location.file
  return { file, line: location.line, column: location.column }
}
