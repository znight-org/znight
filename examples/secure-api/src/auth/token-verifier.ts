import type { HttpContext } from '@znight/http'
import type { AuthConfig } from '../config/auth.config.js'
import type { JwksKeys } from './jwks-keys.js'
import type { Principal } from './principal.js'

import { Injectable } from '@znight/core'
import { type HttpException, ServiceUnavailableException, UnauthorizedException } from '@znight/http'
import { errors, type JWTPayload, jwtVerify } from 'jose'

import { ROLES, type Role } from './access.js'

export const BEARER_CHALLENGE = 'Bearer realm="api"'

/** The token of an `Authorization: Bearer <token>` header (RFC 6750), or `undefined`. */
export function bearerToken(ctx: HttpContext): string | undefined {
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(ctx.header('authorization') ?? '')
  return match?.[1]
}

@Injectable()
export class TokenVerifier {
  constructor(
    private readonly config: AuthConfig,
    private readonly keys: JwksKeys,
  ) {}

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.keys.getKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256'], // pinned: what the identity provider signs with (never 'none', never HS* here)
        clockTolerance: 30, // seconds of clock skew
        requiredClaims: ['sub', 'exp'],
      })
      return toPrincipal(payload)
    } catch (error) {
      throw toHttpError(error)
    }
  }
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(ROLES)

function toPrincipal(payload: JWTPayload): Principal {
  const claim = payload.roles
  const roles = Array.isArray(claim) ? claim.filter((role): role is Role => KNOWN_ROLES.has(role)) : []
  return { id: payload.sub as string, roles, via: 'token' }
}

/** What the token is to blame for answers 401; an unavailable key source answers 503. */
function toHttpError(error: unknown): HttpException {
  const invalidToken =
    error instanceof errors.JWTExpired || // not a JWTClaimValidationFailed in jose 6
    error instanceof errors.JWTClaimValidationFailed || // not yet valid, wrong iss / aud, missing claim
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey || // unknown kid
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported
  if (invalidToken) {
    return new UnauthorizedException('Invalid token', undefined, {
      headers: { 'www-authenticate': `${BEARER_CHALLENGE}, error="invalid_token"` },
    })
  }
  // JWKSTimeout, a failed fetch, a non-200 or malformed key set: the caller is not to blame
  return new ServiceUnavailableException('Token verification unavailable', undefined, {
    headers: { 'retry-after': '5' },
    cause: error,
  })
}
