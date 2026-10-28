import type { JsonSchema, SchemaConverter } from '@znight/openapi'

import { valibotConverter } from '@znight/openapi'

/*
 * Extra Standard Schema → JSON Schema converters, tried before the built-in ones (the default export
 * below). Converters run when the document is assembled: at boot (`OpenApiPlugin`, src/http.ts) and
 * at build time (`openapi()` in vite.config.ts, `znight openapi --converters` in package.json).
 * Every one of them must get this module, or the committed `openapi.json` and the served document
 * would differ (the tests compare them byte for byte).
 *
 * Zod converts its own schemas (Standard JSON Schema) and Valibot goes through the built-in
 * `valibotConverter` (`@valibot/to-json-schema`). A converter is needed for two reasons:
 *
 * - a schema library that does neither, such as Effect Schema:
 *
 *   ```ts
 *   import { JSONSchema, Schema } from 'effect'
 *
 *   const effect: SchemaConverter = {
 *     name: 'effect',
 *     convert(schema, { io }) {
 *       if (!Schema.isSchema(schema)) return undefined // not ours: the next converter is tried
 *       return JSONSchema.make(io === 'input' ? Schema.encodedSchema(schema) : Schema.typeSchema(schema))
 *     },
 *   }
 *   ```
 *
 * - output that a library writes in a way OpenAPI tools understand less well, such as the
 *   discriminated unions below.
 */

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Component names keep `[A-Za-z0-9._-]` (OpenAPI). */
const COMPONENT_NAME = /^[A-Za-z0-9._-]+$/

/**
 * The property telling the options of a `oneOf` apart: required by every option, with a distinct
 * `const` value in each (`method: 'card'`, `method: 'transfer'`).
 */
function discriminatorOf(options: readonly Json[]): { property: string; values: string[] } | undefined {
  const [first] = options
  const candidates = Array.isArray(first?.required) ? (first.required as unknown[]) : []
  for (const property of candidates) {
    if (typeof property !== 'string') continue
    const values = options.map(option => {
      const required = Array.isArray(option.required) && option.required.includes(property)
      const value = isObject(option.properties) ? (option.properties[property] as Json | undefined)?.const : undefined
      return required && (typeof value === 'string' || typeof value === 'number') ? String(value) : undefined
    })
    if (values.every(value => value !== undefined) && new Set(values).size === values.length) {
      return { property, values: values as string[] }
    }
  }
  return undefined
}

/**
 * Rewrites every `oneOf` whose options are objects named with a `title` (`v.title('CardPaymentInput')`)
 * and told apart by a `const` property: each option moves to `$defs` under its title (the document
 * hoists `$defs` into `components.schemas`, keeping their names) and is replaced with a `$ref`, then
 * a `discriminator` with a complete `mapping` is added. Generated clients get a tagged union, and
 * the API reference shows one tab per payment method.
 *
 * The mapping targets the final component names: `#/$defs/X` references are rewritten by the
 * document assembly, mapping values are not. That holds for request bodies such as `PlaceOrder`
 * (an `XInput` suffix only appears when one schema is used in requests and responses and differs).
 */
function withDiscriminators(schema: JsonSchema): JsonSchema {
  const defs: Json = {}
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!isObject(value)) return value
    const node: Json = {}
    for (const [key, item] of Object.entries(value)) node[key] = visit(item)
    const options = node.oneOf
    if (!Array.isArray(options) || options.length < 2 || node.discriminator !== undefined) return node
    const named = options.filter(
      (option): option is Json & { title: string } =>
        isObject(option) && typeof option.title === 'string' && COMPONENT_NAME.test(option.title),
    )
    const discriminator = named.length === options.length ? discriminatorOf(named) : undefined
    if (discriminator === undefined) return node
    const mapping: Record<string, string> = {}
    named.forEach((option, index) => {
      defs[option.title] = option
      mapping[discriminator.values[index] as string] = `#/components/schemas/${option.title}`
    })
    node.oneOf = named.map(option => ({ $ref: `#/$defs/${option.title}` }))
    node.discriminator = { propertyName: discriminator.property, mapping }
    return node
  }
  const result = visit(schema) as Json
  if (Object.keys(defs).length > 0) {
    result.$defs = { ...(isObject(result.$defs) ? result.$defs : {}), ...defs }
  }
  // still the JSON values of the library, moved around
  return result as JsonSchema
}

/**
 * Valibot schemas, converted by the built-in `valibotConverter`, with their discriminated unions
 * (`v.variant()`) documented as `oneOf` + `discriminator`. Other schemas are left to the built-in
 * converters (`undefined`).
 */
export const valibotDiscriminators: SchemaConverter = {
  name: 'valibot-discriminators',
  async convert(schema, context) {
    const converted = await valibotConverter.convert(schema, context) // `undefined`: not a Valibot schema
    return converted === undefined ? undefined : withDiscriminators(converted)
  },
}

const converters: readonly SchemaConverter[] = [valibotDiscriminators]

export default converters
