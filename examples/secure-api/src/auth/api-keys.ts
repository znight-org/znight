import type { AuthConfig } from '../config/auth.config.js'
import type { Principal } from './principal.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

export const API_KEY_HEADER = 'x-api-key'
export const API_KEY_CHALLENGE = `ApiKey header="${API_KEY_HEADER}"`

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Static keys of machine clients. Only their SHA-256 digests are kept. */
@Injectable()
export class ApiKeys {
  readonly #keys: readonly { readonly digest: Buffer; readonly principal: Principal }[]

  constructor(config: AuthConfig) {
    // one principal per client, so that each can be revoked alone; several keys per client during a rotation
    const exporter: Principal = { id: 'export-client', roles: ['exporter'], via: 'api-key' }
    this.#keys = config.exportApiKeys.map(key => ({ digest: sha256(key), principal: exporter }))
  }

  /** The client owning `key`, or `undefined`. */
  identify(key: string): Principal | undefined {
    const digest = sha256(key) // fixed length: timingSafeEqual never throws, the key length does not leak
    let found: Principal | undefined
    for (const entry of this.#keys) if (timingSafeEqual(entry.digest, digest)) found = entry.principal // no early exit
    return found
  }
}
