import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from 'jose'

export const ISSUER = 'https://id.test/'
export const AUDIENCE = 'https://api.test'

const { publicKey, privateKey } = await generateKeyPair('RS256')
export const jwks: JSONWebKeySet = { keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] }

export interface TestClaims {
  readonly sub: string
  readonly roles?: readonly string[]
  readonly iss?: string
  readonly aud?: string
  /** `'5m'` (default), or an absolute time in Unix seconds (in the past for an expired token). */
  readonly exp?: string | number
  /** Not before: an absolute time in Unix seconds. */
  readonly nbf?: number
  /** The key id of the header (`'test'`, the key of the key set). */
  readonly kid?: string
}

/** A token as the identity provider would issue it, signed with the test key pair. */
export function mintToken(claims: TestClaims): Promise<string> {
  const token = new SignJWT({ roles: claims.roles ?? [] })
    .setProtectedHeader({ alg: 'RS256', kid: claims.kid ?? 'test' })
    .setSubject(claims.sub)
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '5m')
  if (claims.nbf !== undefined) token.setNotBefore(claims.nbf)
  return token.sign(privateKey)
}

const now = (): number => Math.floor(Date.now() / 1000)

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** The standard claims of a valid token, for the forged ones below. */
function claimsOf(sub: string, roles: readonly string[]): Record<string, unknown> {
  return { sub, roles, iss: ISSUER, aud: AUDIENCE, iat: now(), exp: now() + 300 }
}

/** Forged: an unsecured token (`alg: none`), no signature at all. */
export function unsecuredToken(sub: string, roles: readonly string[] = []): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claimsOf(sub, roles))}.`
}

/**
 * Forged: HS256 with the PUBLIC key as the HMAC secret, the classic algorithm confusion attack
 * against verifiers that let the token choose its algorithm.
 */
export function confusedToken(sub: string, roles: readonly string[] = []): Promise<string> {
  const secret = new TextEncoder().encode(JSON.stringify(jwks.keys[0]))
  return new SignJWT(claimsOf(sub, roles)).setProtectedHeader({ alg: 'HS256', kid: 'test' }).sign(secret)
}

/** Forged: signed by another key pair under the same key id. */
export async function foreignToken(sub: string, roles: readonly string[] = []): Promise<string> {
  const other = await generateKeyPair('RS256')
  return new SignJWT(claimsOf(sub, roles)).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(other.privateKey)
}

/** A valid signature over claims without `sub`. */
export function tokenWithoutSubject(): Promise<string> {
  const { sub: _sub, ...claims } = claimsOf('nobody', [])
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey)
}
