import type { Principal } from './request-user.js'

import { Injectable } from '@znight/core'

/** The API keys of the machine clients (`CHAT_KEYS=alice:key-a:moderator,bob:key-b`). */
@Injectable()
export class ApiKeys {
  readonly #byKey = new Map<string, Principal>()

  constructor() {
    const spec = process.env['CHAT_KEYS'] ?? 'alice:alice-key:moderator,bob:bob-key'
    for (const entry of spec.split(',')) {
      const [name, key, ...roles] = entry.split(':')
      if (name && key) this.#byKey.set(key, { name, roles })
    }
  }

  identify(key: string): Principal | undefined {
    return this.#byKey.get(key)
  }
}
