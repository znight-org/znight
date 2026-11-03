/**
 * `schemaHash` of `metadata.extensions.graphql` (RFC 0005 §7.1): the first 16 hexadecimal
 * characters of the SHA-256 of the SDL printed by `printSdl()`.
 *
 * Separate from the import-free `sdl.ts` because it needs `node:crypto`. That is fine on both sides:
 * the compiler extension runs at build time on Node.js or Bun, and the runtime targets Node.js >= 24
 * and Bun >= 1.3, which both provide `node:crypto`. The module reaches nothing else, so the
 * `./compiler` boundaries hold (tests/boundaries.test.ts).
 */
import { createHash } from 'node:crypto'

/** Length of a schema hash, in hexadecimal characters. */
export const SCHEMA_HASH_LENGTH = 16

/** First 16 hexadecimal characters of the SHA-256 of `sdl` (UTF-8). */
export function schemaHash(sdl: string): string {
  return createHash('sha256').update(sdl, 'utf8').digest('hex').slice(0, SCHEMA_HASH_LENGTH)
}
