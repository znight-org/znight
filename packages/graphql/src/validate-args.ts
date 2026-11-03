/**
 * `validateArgs()`: Standard Schema validation of resolver arguments (RFC 0005 §5.4, §7.3), called
 * by the generated `invoke` functions (README, "Compiler contract").
 */
import type { InferSchemaOutput, StandardSchemaV1, StandardSchemaV1Result } from '@znight/http'

import { isThenable, toIssueDetail } from '@znight/http'

import { GraphQLErrorCode, GraphQLException } from './errors.ts'

/**
 * Validates an argument value (after GraphQL coercion) with a [Standard Schema](https://standardschema.dev)
 * (Zod, Valibot, ArkType...) and returns the schema **output** (transforms run, defaults applied).
 *
 * Synchronous when the schema validates synchronously (no promise, no microtask), a promise
 * otherwise: generated code `await`s the result, which is free for a plain value.
 *
 * @param label what is validated, for the message: the argument name (`'input'`), or `'arguments'`
 *   for `@Args(Schema)` without name.
 * @throws GraphQLException `BAD_USER_INPUT`, `extensions.issues: [{ path, message }]`, when the
 *   value is invalid.
 * @throws TypeError when `schema` is not a Standard Schema v1 (a programming error, masked).
 */
export function validateArgs<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  label: string,
): InferSchemaOutput<S> | Promise<InferSchemaOutput<S>> {
  const props =
    schema !== null && (typeof schema === 'object' || typeof schema === 'function')
      ? (schema as { readonly '~standard'?: { readonly version?: unknown; readonly validate?: unknown } })['~standard']
      : undefined
  if (props === null || typeof props !== 'object' || props.version !== 1 || typeof props.validate !== 'function') {
    throw new TypeError(`The schema of ${label} is not a Standard Schema v1 (missing "~standard.validate")`)
  }
  const result = (props.validate as (value: unknown) => StandardSchemaV1Result<InferSchemaOutput<S>>)(value)
  // sync fast path: most schemas validate synchronously
  if (isThenable(result)) return Promise.resolve(result).then(settled => unwrap(settled, label))
  return unwrap(result, label)
}

function unwrap<T>(result: StandardSchemaV1Result<T>, label: string): T {
  if (result.issues === undefined) return result.value
  throw new GraphQLException(`Invalid ${label}`, {
    code: GraphQLErrorCode.BadUserInput,
    extensions: { issues: result.issues.map(toIssueDetail) },
  })
}
