import type { AuthConfig } from '../config/auth.config.js'

import { readFileSync } from 'node:fs'
import { Injectable } from '@znight/core'
import { createLocalJWKSet, createRemoteJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'

/** The verification keys. A provider of its own, so that tests can replace the key source. */
@Injectable()
export class JwksKeys {
  readonly getKey: JWTVerifyGetKey

  constructor(config: AuthConfig) {
    if (config.jwksUrl !== undefined) {
      // built once: the key set is cached and refreshed when an unknown `kid` shows up
      this.getKey = createRemoteJWKSet(config.jwksUrl, {
        cooldownDuration: 30_000, // at most one refetch every 30 s, whatever the tokens claim
        cacheMaxAge: 600_000, // refetch at least every 10 minutes (key rotation)
        timeoutDuration: 5_000, // then 503: the identity provider is unavailable
      })
    } else if (config.jwksFile === undefined) {
      throw new Error('Set AUTH_JWKS_URL (the key set of the identity provider), or AUTH_JWKS_FILE in development')
    } else {
      // development: the key set written by scripts/dev-token.ts
      this.getKey = createLocalJWKSet(readKeySet(config.jwksFile))
    }
  }
}

function readKeySet(file: string): JSONWebKeySet {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JSONWebKeySet
  } catch (error) {
    throw new Error(`Cannot read the key set ${file} (AUTH_JWKS_FILE): run \`bun scripts/dev-token.ts\` once`, {
      cause: error,
    })
  }
}
