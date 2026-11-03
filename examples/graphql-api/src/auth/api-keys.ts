import type { AuthConfig } from '../config/auth.config.js'
import type { EmailAddress } from '../shared/scalars.js'
import type { Principal } from './principal.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

/** Header carrying the API key. */
export const API_KEY_HEADER = 'x-api-key'

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/** The API keys of the configuration. Only their SHA-256 digests are kept. */
@Injectable()
export class ApiKeys {
  readonly #keys: readonly { readonly digest: Buffer; readonly principal: Principal }[]

  constructor(config: AuthConfig) {
    this.#keys = [
      {
        digest: sha256(config.editorApiKey),
        principal: { name: 'editor', email: 'editor@books.example' as EmailAddress, roles: ['reader', 'editor'] },
      },
      {
        digest: sha256(config.readerApiKey),
        principal: { name: 'reader', email: 'reader@books.example' as EmailAddress, roles: ['reader'] },
      },
    ]
  }

  /** The client owning `key`: a 401 (`UNAUTHENTICATED`) for an unknown key. */
  verify(key: string): Principal {
    const digest = sha256(key) // fixed length: timingSafeEqual never throws, the key length does not leak
    let found: Principal | undefined
    for (const entry of this.#keys) if (timingSafeEqual(entry.digest, digest)) found = entry.principal // no early exit
    if (found === undefined) {
      throw new UnauthorizedException('Invalid API key', undefined, {
        headers: { 'www-authenticate': `ApiKey header="${API_KEY_HEADER}"` },
      })
    }
    return found
  }
}
