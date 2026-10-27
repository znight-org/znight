/**
 * Signed cookies (RFC 0006 §4.5): HMAC-SHA256 bound to the cookie name, with key rotation. Uses
 * `node:crypto` (synchronous, Node.js and Bun): only imported by the runtime entry, never by the
 * compiler extension.
 */
import crypto, { createHmac, createSecretKey, type KeyObject } from 'node:crypto'

/** Length of a signature: base64url of 32 bytes, without padding. */
const SIGNATURE_LENGTH = 43
/** Minimum size of a secret, in bytes. */
export const MIN_SECRET_BYTES = 32

/** A secret given to the plugin option `cookies.secrets`. */
export type CookieSecret = string | Uint8Array

const ENCODER = new TextEncoder()

/**
 * Signs and verifies cookie values. The wire form of a signed cookie is
 * `<encoded value>.<signature>` with `signature = base64url(HMAC-SHA256(secret, "<name>=<encoded value>"))`:
 * the MAC covers the name, so a value of `a` replayed as `b` fails. The first secret signs, every
 * secret verifies (rotation).
 */
export class CookieSigner {
  readonly #keys: readonly KeyObject[]

  /** @param secrets validated by {@link checkSecrets} (at least one, ≥ 32 bytes each, no duplicate). */
  constructor(secrets: readonly CookieSecret[]) {
    this.#keys = secrets.map(secret => createSecretKey(toBytes(secret)))
  }

  /** `<encoded>.<signature>` signed with the first secret. `encoded` is an encoded cookie value. */
  sign(name: string, encoded: string): string {
    return `${encoded}.${mac(this.#keys[0] as KeyObject, name, encoded)}`
  }

  /**
   * The encoded value of a signed wire value, `undefined` when the signature is malformed or made
   * with none of the secrets (constant-time comparison).
   */
  verify(name: string, wire: string): string | undefined {
    const dot = wire.lastIndexOf('.')
    if (dot === -1) return undefined
    const signature = wire.slice(dot + 1)
    if (!isSignature(signature)) return undefined
    const encoded = wire.slice(0, dot)
    const given = Buffer.from(signature, 'latin1')
    for (const key of this.#keys) {
      const expected = Buffer.from(mac(key, name, encoded), 'latin1')
      // through the module object: observable in tests (equal lengths only, see isSignature)
      if (crypto.timingSafeEqual(expected, given)) return encoded
    }
    return undefined
  }
}

function mac(key: KeyObject, name: string, encoded: string): string {
  return createHmac('sha256', key).update(`${name}=${encoded}`).digest('base64url')
}

/** 43 characters of the base64url alphabet. */
function isSignature(text: string): boolean {
  if (text.length !== SIGNATURE_LENGTH) return false
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    const valid =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d ||
      code === 0x5f
    if (!valid) return false
  }
  return true
}

function toBytes(secret: CookieSecret): Uint8Array {
  return typeof secret === 'string' ? ENCODER.encode(secret) : secret
}

/**
 * Normalises the option `cookies.secrets` to a list, or explains what is wrong with it (a secret
 * shorter than 32 bytes, a duplicate, an empty list, a value that is neither a string nor bytes).
 */
export function checkSecrets(
  value: unknown,
): { readonly secrets: readonly CookieSecret[] } | { readonly problem: string } {
  const list: unknown[] = Array.isArray(value) ? value : [value]
  if (list.length === 0) return { problem: 'at least one secret' }
  const seen = new Set<string>()
  for (const [index, secret] of list.entries()) {
    if (typeof secret !== 'string' && !(secret instanceof Uint8Array)) {
      return { problem: `strings or Uint8Arrays (secret #${index} is not)` }
    }
    const bytes = toBytes(secret)
    if (bytes.byteLength < MIN_SECRET_BYTES) {
      return {
        problem: `secrets of at least ${MIN_SECRET_BYTES} bytes (secret #${index} has ${bytes.byteLength}): crypto.randomBytes(32).toString('base64url')`,
      }
    }
    const fingerprint = Buffer.from(bytes).toString('base64')
    if (seen.has(fingerprint)) return { problem: `distinct secrets (secret #${index} is a duplicate)` }
    seen.add(fingerprint)
  }
  return { secrets: list as CookieSecret[] }
}
