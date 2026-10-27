/**
 * `generate`: emits `metadata.extensions.openapi` (§7.1 of RFC 0002). Every value is a JSON literal,
 * except the Standard Schema slots, imported by the generated module (once, like `invoke` does).
 */
import type { GenerateContext, GenNode, LiteralValue } from '@znight/compiler'
import type { OpenApiStored } from './model.ts'
import type { OpenApiModel } from './validate.ts'

import { createHash } from 'node:crypto'

import { canonicalJson, OPENAPI_VERSION } from '../shared.ts'
import { modelOf, sourceOf } from './validate.ts'

/** `generate` of the extension. */
export function generateOpenApi(ctx: GenerateContext<OpenApiStored>): GenNode | undefined {
  const model = modelOf(ctx.graph) ?? emptyModel(ctx.options.root)
  const operations = model.operations.map(operation => ({
    controller: operation.controller,
    handler: operation.handler,
    route: operation.route,
    method: operation.method,
    path: operation.path,
    operation: operation.operation,
  }))
  const slots = model.slots.map(slot => ({ name: slot.name, io: [...slot.io].sort() }))
  const fingerprint = fingerprintOf({
    version: 1,
    document: model.document,
    operations,
    components: model.components,
    securitySchemes: model.securitySchemes,
    schemas: slots,
    errors: model.errors,
    tagDescriptions: model.tagDescriptions,
  })
  const lit = (value: unknown): GenNode => ctx.lit(value as LiteralValue)
  const entries: [string, GenNode][] = [
    ['version', lit(1)],
    ['fingerprint', lit(fingerprint)],
    ['document', lit(model.document)],
    ['operations', lit(operations)],
    ['components', lit(model.components)],
    ['securitySchemes', lit(model.securitySchemes)],
    [
      'schemas',
      ctx.arr(
        model.slots.map(slot =>
          ctx.obj([
            ['name', slot.name],
            ['schema', ctx.importValue(slot.ref)],
            ['io', lit([...slot.io].sort())],
            ['source', lit(sourceOf(slot.location, model.root))],
          ]),
        ),
      ),
    ],
  ]
  if (model.errors !== undefined) entries.push(['errors', lit(model.errors)])
  if (Object.keys(model.tagDescriptions).length > 0) entries.push(['tagDescriptions', lit(model.tagDescriptions)])
  return ctx.obj(entries)
}

/** SHA-256 (base64url) of the canonical JSON of the section (schema values replaced by their names). */
export function fingerprintOf(section: unknown): string {
  return createHash('sha256').update(canonicalJson(section)).digest('base64url')
}

function emptyModel(root: string): OpenApiModel {
  return {
    document: { openapi: OPENAPI_VERSION, info: { title: 'API', version: '0.0.0' } },
    operations: [],
    components: {},
    securitySchemes: {},
    slots: [],
    errors: { contentType: 'application/json' },
    tagDescriptions: {},
    root,
  }
}
