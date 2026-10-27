/**
 * Standard Schema → JSON Schema converters (§7.3 of RFC 0002). The library that defines a schema is
 * the only one that knows its JSON Schema: Zod, ArkType and the libraries implementing Standard
 * JSON Schema convert their own schemas; Valibot goes through `@valibot/to-json-schema`.
 */
import type { StandardSchemaV1 } from '@znight/http'
import type { JsonSchema } from './types.ts'

/** What a converter receives next to the schema. */
export interface SchemaConverterContext {
  /** `input` for requests (what clients send), `output` for responses (what the server sends). */
  readonly io: 'input' | 'output'
  readonly target: 'draft-2020-12'
  /** Retry after a failure with `unrepresentable: 'warn'`: approximate instead of throwing. */
  readonly lenient: boolean
}

/** Converts Standard Schemas of one library to JSON Schema 2020-12. */
export interface SchemaConverter {
  readonly name: string
  /** `undefined`: not supported, the next converter is tried. Throwing reports ZNIGHT037. */
  convert(
    schema: StandardSchemaV1,
    context: SchemaConverterContext,
  ): JsonSchema | undefined | Promise<JsonSchema | undefined>
}

/** The Standard JSON Schema interface (`~standard.jsonSchema`). */
interface StandardJsonSchemaProps {
  readonly vendor?: unknown
  readonly jsonSchema?: {
    readonly input?: (options: { target: string; libraryOptions?: Record<string, unknown> }) => unknown
    readonly output?: (options: { target: string; libraryOptions?: Record<string, unknown> }) => unknown
  }
}

function propsOf(schema: StandardSchemaV1): StandardJsonSchemaProps | undefined {
  const props = (schema as unknown as { '~standard'?: unknown })['~standard']
  return typeof props === 'object' && props !== null ? (props as StandardJsonSchemaProps) : undefined
}

/** `vendor` of a Standard Schema (`zod`, `valibot`, `arktype`...). */
export function vendorOf(schema: StandardSchemaV1): string {
  const vendor = propsOf(schema)?.vendor
  return typeof vendor === 'string' ? vendor : 'unknown'
}

/**
 * Zod dates are serialised with `Date.prototype.toJSON`: in responses they are ISO strings. Other
 * unrepresentable parts throw (or become `{}` when lenient).
 */
function zodOptions(context: SchemaConverterContext): Record<string, unknown> {
  return {
    unrepresentable: (site: { zodSchema?: { _zod?: { def?: { type?: unknown } } } }) => {
      if (context.io === 'output' && site.zodSchema?._zod?.def?.type === 'date') {
        return { type: 'string', format: 'date-time' }
      }
      return context.lenient ? 'any' : 'throw'
    },
  }
}

function callStandard(
  props: StandardJsonSchemaProps | undefined,
  context: SchemaConverterContext,
  libraryOptions?: Record<string, unknown>,
): unknown {
  const convert = props?.jsonSchema?.[context.io]
  if (typeof convert !== 'function') return undefined
  return convert.call(props?.jsonSchema, {
    target: context.target,
    ...(libraryOptions === undefined ? {} : { libraryOptions }),
  })
}

/**
 * Standard JSON Schema (`schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' })`): Zod ≥ 4.2,
 * ArkType ≥ 2.1.28 and every library implementing the interface.
 */
export const standardJsonSchemaConverter: SchemaConverter = Object.freeze({
  name: 'standard-json-schema',
  convert(schema: StandardSchemaV1, context: SchemaConverterContext): JsonSchema | undefined {
    const props = propsOf(schema)
    if (typeof props?.jsonSchema?.[context.io] !== 'function') return undefined
    const result = callStandard(props, context, props.vendor === 'zod' ? zodOptions(context) : undefined)
    return result as JsonSchema | undefined
  },
})

/** Valibot schemas (no `~standard.jsonSchema`) through `toStandardJsonSchema()` of `@valibot/to-json-schema`. */
export const valibotConverter: SchemaConverter = Object.freeze({
  name: 'valibot',
  async convert(schema: StandardSchemaV1, context: SchemaConverterContext): Promise<JsonSchema | undefined> {
    const props = propsOf(schema)
    if (props?.vendor !== 'valibot' || props.jsonSchema !== undefined) return undefined
    let module: { toStandardJsonSchema?: (schema: unknown, config?: unknown) => unknown }
    try {
      module = (await import('@valibot/to-json-schema')) as typeof module
    } catch (error) {
      throw new Error(
        'Valibot schemas need the optional peer @valibot/to-json-schema (npm install @valibot/to-json-schema)',
        {
          cause: error,
        },
      )
    }
    if (typeof module.toStandardJsonSchema !== 'function') {
      throw new Error('@valibot/to-json-schema has no toStandardJsonSchema(): install version 1.5 or later')
    }
    const standard = module.toStandardJsonSchema(schema, context.lenient ? { errorMode: 'ignore' } : undefined)
    return callStandard(propsOf(standard as StandardSchemaV1), context) as JsonSchema | undefined
  },
})

/** Built-in converters, tried after the user's. */
export const BUILT_IN_CONVERTERS: readonly SchemaConverter[] = Object.freeze([
  standardJsonSchemaConverter,
  valibotConverter,
])
