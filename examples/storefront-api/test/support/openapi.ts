import { readFileSync } from 'node:fs'
import { Validator } from '@seriousme/openapi-schema-validator'

/** The committed document (`bun run openapi` writes it, `bun run openapi:check` checks it). */
export const OPENAPI_FILE = new URL('../../openapi.json', import.meta.url)

/** The committed document, as text: the served one must be equal byte for byte. */
export function committedOpenApi(): string {
  return readFileSync(OPENAPI_FILE, 'utf8')
}

/**
 * Validates a document against the official OpenAPI JSON Schema of its version, with
 * `@seriousme/openapi-schema-validator` (its `openapi` field picks the schema: 3.1 here).
 */
export async function validateOpenApi(
  document: unknown,
): Promise<{ readonly valid: boolean; readonly version: string; readonly errors: unknown }> {
  const validator = new Validator()
  // the validator annotates what it reads: give it a copy (the served document is frozen)
  const result = await validator.validate(structuredClone(document) as Record<string, unknown>)
  return { valid: result.valid, version: validator.version, errors: result.errors }
}
