import type {
  InferSchemaOutput,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Result,
} from './standard-schema.ts'

import { MessageValidationError, type MessageValidationIssue } from './errors.ts'
import { isStandardSchema } from './standard-schema.ts'

/**
 * Validates `value` with a Standard Schema (Zod, Valibot, ArkType...) and returns the schema
 * **output** (defaults and transforms applied). On failure it throws a {@link MessageValidationError},
 * a `NonRetryableError`: the message is dead-lettered without further attempts.
 *
 * Returns synchronously when the schema validates synchronously, a promise otherwise. Called by the
 * code generated for `@Message(schema)` parameters:
 *
 * ```ts
 * invoke: async (c, m) => c.handle(await validateMessage(OrderCreated, m.payload))
 * ```
 *
 * @param label Describes the value in the error message. Default: `'message payload'`.
 */
export function validateMessage<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  label = 'message payload',
): InferSchemaOutput<S> | Promise<InferSchemaOutput<S>> {
  if (!isStandardSchema(schema)) {
    throw new TypeError(`[znight] validateMessage(): the schema of the ${label} is not a Standard Schema v1`)
  }
  const result = schema['~standard'].validate(value) as
    | StandardSchemaV1Result<InferSchemaOutput<S>>
    | Promise<StandardSchemaV1Result<InferSchemaOutput<S>>>
  if (isPromiseLike(result)) return Promise.resolve(result).then(settled => unwrap(settled, label))
  return unwrap(result, label)
}

function unwrap<T>(result: StandardSchemaV1Result<T>, label: string): T {
  if (result.issues === undefined) return result.value
  throw new MessageValidationError(label, result.issues.map(toIssue))
}

function toIssue(issue: StandardSchemaV1Issue): MessageValidationIssue {
  return { path: formatPath(issue.path), message: String(issue.message) }
}

function formatPath(path: StandardSchemaV1Issue['path']): string {
  if (path === undefined || path.length === 0) return ''
  return path.map(segment => String(isSegment(segment) ? segment.key : segment)).join('.')
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

function isSegment(segment: PropertyKey | StandardSchemaV1PathSegment): segment is StandardSchemaV1PathSegment {
  return typeof segment === 'object' && segment !== null && 'key' in segment
}
