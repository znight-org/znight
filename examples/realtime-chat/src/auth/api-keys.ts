import type { ChatConfig } from '../config/chat.config.js'
import type { Principal } from './request-user.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/** The API keys of the clients (`CHAT_KEYS`, see `ChatConfig`). Only their SHA-256 digests are kept. */
@Injectable()
export class ApiKeys {
  readonly #keys: readonly { readonly digest: Buffer; readonly principal: Principal }[]

  constructor(config: ChatConfig) {
    const keys: { digest: Buffer; principal: Principal }[] = []
    for (const entry of config.keys.split(',')) {
      const [name, key, ...roles] = entry.trim().split(':')
      if (name && key) keys.push({ digest: sha256(key), principal: { name, roles } })
    }
    this.#keys = keys
  }

  /** The client owning `key`, or `undefined`. */
  identify(key: string): Principal | undefined {
    const digest = sha256(key) // fixed length: timingSafeEqual never throws, the key length does not leak
    let found: Principal | undefined
    for (const entry of this.#keys) if (timingSafeEqual(entry.digest, digest)) found = entry.principal // no early exit
    return found
  }
}
