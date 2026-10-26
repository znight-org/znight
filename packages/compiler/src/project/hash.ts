import { hash } from 'node:crypto'

/**
 * Content hash used as the parse cache key: SHA-1 hex digest of the UTF-8 encoded text.
 *
 * Uses the one-shot `crypto.hash()` (Node >= 21.7, Bun) which is several times faster than
 * `createHash()` for small inputs. SHA-1 is used for change detection only, not for security.
 */
export function contentHash(text: string): string {
  return hash('sha1', text, 'hex')
}
