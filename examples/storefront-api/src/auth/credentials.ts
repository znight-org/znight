import type { AuthConfig } from '../config/auth.config.js'
import type { Role } from './auth.decorators.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

/** Who is calling, once the credentials are verified. */
export interface Principal {
  /** The customer id (`alice`) for a bearer token, the name of the key (`admin`) for an API key. */
  readonly id: string
  readonly roles: readonly Role[]
}

interface Credential extends Principal {
  /** SHA-256 of the secret: compared in constant time, and the secret itself is not kept around. */
  readonly digest: Buffer
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/**
 * Verifies bearer tokens and API keys against the configuration (`AuthConfig`).
 *
 * Deliberately trivial: static secrets, enough to document and test two security schemes. A real
 * shop verifies signed tokens (JWT) instead; see `examples/secure-api`.
 */
@Injectable()
export class Credentials {
  readonly #tokens: readonly Credential[]
  readonly #keys: readonly Credential[]

  constructor(config: AuthConfig) {
    this.#tokens = Object.entries(config.customerTokens).map(([id, token]) => ({
      id,
      roles: ['customer'],
      digest: sha256(token),
    }))
    const keys: Credential[] = [{ id: 'admin', roles: ['admin', 'catalog'], digest: sha256(config.adminApiKey) }]
    if (config.catalogApiKey) keys.push({ id: 'catalog', roles: ['catalog'], digest: sha256(config.catalogApiKey) })
    this.#keys = keys
  }

  /** The customer owning a bearer token. */
  verifyToken(token: string): Principal | undefined {
    return match(this.#tokens, token)
  }

  /** The back-office principal of an API key. */
  verifyApiKey(key: string): Principal | undefined {
    return match(this.#keys, key)
  }
}

function match(candidates: readonly Credential[], secret: string): Principal | undefined {
  // digests have a fixed length: timingSafeEqual never throws and the secret length does not leak;
  // every candidate is compared (no early exit), so the timing does not tell which one matched
  const digest = sha256(secret)
  let found: Credential | undefined
  for (const candidate of candidates) if (timingSafeEqual(candidate.digest, digest)) found = candidate
  return found === undefined ? undefined : { id: found.id, roles: found.roles }
}
