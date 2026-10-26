import { ValidationException } from './exceptions.ts'
import {
  type InferSchemaOutput,
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1Result,
} from './standard-schema.ts'
import { isThenable } from './utils.ts'

/**
 * Validates `value` with a [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType...)
 * and returns the schema **output** (defaults applied, transforms run, unknown keys stripped when
 * the schema strips them).
 *
 * Returns synchronously when the schema validates synchronously, a promise otherwise (async
 * refinements): generated code always `await`s it.
 *
 * @param location what is validated, used in the error message: `body`, `query`, `query "page"`,
 *   `param "id"`, `headers`...
 * @throws ValidationException (400, `details: [{ path, message }]`) when the value is invalid.
 * @throws TypeError when `schema` is not a Standard Schema v1 (a programming error → 500).
 */
export function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  location: string,
): InferSchemaOutput<S> | Promise<InferSchemaOutput<S>> {
  if (!isStandardSchema(schema)) {
    throw new TypeError(`The schema of ${location} is not a Standard Schema v1 (missing "~standard.validate")`)
  }
  const result = schema['~standard'].validate(value) as
    | StandardSchemaV1Result<InferSchemaOutput<S>>
    | Promise<StandardSchemaV1Result<InferSchemaOutput<S>>>
  if (isThenable(result)) return Promise.resolve(result).then(settled => unwrap(settled, location))
  return unwrap(result, location)
}

function unwrap<T>(result: StandardSchemaV1Result<T>, location: string): T {
  if (result.issues !== undefined) throw new ValidationException(location, result.issues)
  return result.value
}
