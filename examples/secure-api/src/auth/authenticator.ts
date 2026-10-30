import type { HttpContext } from '@znight/http'
import type { Logger } from '@znight/observability'
import type { SessionCookies } from '../session/session-cookies.js'
import type { ApiKeys } from './api-keys.js'
import type { Principal } from './principal.js'
import type { TokenVerifier } from './token-verifier.js'

import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

import { API_KEY_CHALLENGE, API_KEY_HEADER } from './api-keys.js'
import { BEARER_CHALLENGE, bearerToken } from './token-verifier.js'

@Injectable()
export class Authenticator {
  constructor(
    private readonly tokens: TokenVerifier,
    private readonly apiKeys: ApiKeys,
    private readonly sessions: SessionCookies,
    private readonly logger: Logger,
  ) {}

  /** The first credentials the request carries decide: a bearer token, an API key, then a session cookie. */
  async authenticate(ctx: HttpContext): Promise<Principal> {
    const token = bearerToken(ctx)
    if (token !== undefined) return await this.tokens.verify(token) // 401 invalid_token, or 503

    const key = ctx.header(API_KEY_HEADER)
    if (key !== undefined) {
      const client = this.apiKeys.identify(key)
      if (client !== undefined) return client
      // an audit trail of wrong keys, never the key itself (ctx.ip: the client behind the trusted proxies)
      this.logger.warn('Invalid API key', { ip: ctx.ip, route: ctx.route?.path })
      throw unauthorized('Invalid API key')
    }

    const session = this.sessions.read(ctx) // signed, unexpired, of an existing account
    if (session !== undefined) return session.principal
    if (this.sessions.isPresent(ctx)) this.sessions.close(ctx) // expired or revoked: the browser drops it

    throw unauthorized('Authentication required')
  }
}

/** A 401 lists every challenge (RFC 9110): the client picks a scheme it supports. */
function unauthorized(message: string): UnauthorizedException {
  return new UnauthorizedException(message, undefined, {
    headers: { 'www-authenticate': [BEARER_CHALLENGE, API_KEY_CHALLENGE] },
  })
}
