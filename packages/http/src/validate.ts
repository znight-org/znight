import { ValidationException } from './exceptions.ts'
import {
  type InferSchemaOutput,
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
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
 *   `param "id"`, `headers`, `cookie "sid"`, `cookies`...
 * @throws ValidationException (400, `details: [{ path, message }]`) when the value is invalid. For
 *   cookies (`cookie "name"`, `cookies`) the issue messages are replaced with `Invalid value`: some
 *   libraries quote the received value in them (Valibot, ArkType), and cookies often carry tokens.
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
  if (result.issues !== undefined) {
    throw new ValidationException(location, isCookieLocation(location) ? result.issues.map(redact) : result.issues)
  }
  return result.value
}

/** The message of a redacted issue (cookie values are never echoed). */
const REDACTED = 'Invalid value'

function isCookieLocation(location: string): boolean {
  return location === 'cookies' || location.startsWith('cookie ')
}

/**
 * The issue with the keys of its path only: its message may quote the value (`Received "eyJ..."`),
 * and so may the path segments of some libraries (Valibot keeps `input` and `value` there).
 */
function redact(issue: StandardSchemaV1Issue): StandardSchemaV1Issue {
  if (issue.path === undefined) return { message: REDACTED }
  const path = issue.path.map(segment =>
    typeof segment === 'object' && segment !== null ? { key: segment.key } : segment,
  )
  return { message: REDACTED, path }
}
