import type {
  InferSchemaOutput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
} from './standard-schema.ts'

import { ValidationException } from './exceptions.ts'
import { isThenable } from './utils.ts'

/**
 * Whether `value` is a promise-like object (has a callable `then`). Called by the generated
 * `invoke` functions on the result of {@link validate} (README, "Compiler contract").
 */
export { isThenable } from './utils.ts'

/**
 * Validates `value` with a [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType...)
 * and returns the schema **output** (defaults applied, transforms run, unknown keys stripped when
 * the schema strips them).
 *
 * Returns synchronously when the schema validates synchronously, a promise otherwise (async
 * refinements): generated code calls the handler directly with the value, and `await`s the value
 * when it is a thenable (`isThenable`).
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
  // `~standard` is read once (the same checks as `isStandardSchema`)
  const props =
    schema !== null && (typeof schema === 'object' || typeof schema === 'function')
      ? (schema as { readonly '~standard'?: unknown })['~standard']
      : undefined
  if (
    props === null ||
    typeof props !== 'object' ||
    (props as { readonly version?: unknown }).version !== 1 ||
    typeof (props as { readonly validate?: unknown }).validate !== 'function'
  ) {
    throw new TypeError(`The schema of ${location} is not a Standard Schema v1 (missing "~standard.validate")`)
  }
  const result = (props as StandardSchemaV1Props<unknown, InferSchemaOutput<S>>).validate(value)
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
