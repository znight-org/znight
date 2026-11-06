/** Payload validation called by the generated `invoke` functions (RFC 0003 §7.3, "Compiler contract"). */
import type { InferSchemaOutput, StandardSchemaV1 } from '@znight/http'

import { ValidationException, validate } from '@znight/http'

import { WsValidationException } from './exceptions.ts'

/**
 * Validates a message payload with a Standard Schema and returns the schema output, synchronously
 * when the schema is synchronous.
 *
 * @throws WsValidationException (`BAD_REQUEST`, `details: [{ path, message }]`) when the payload is invalid.
 */
export function validatePayload<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): InferSchemaOutput<S> | Promise<InferSchemaOutput<S>> {
  try {
    const result = validate(schema, value, 'payload')
    return result instanceof Promise ? result.catch(rethrow) : result
  } catch (error) {
    return rethrow(error)
  }
}

function rethrow(error: unknown): never {
  if (error instanceof ValidationException) {
    throw new WsValidationException(error.details as readonly { path: string; message: string }[])
  }
  throw error
}
