import type { Role } from './access.js'

/** Who is calling, whatever the way they authenticated. */
export interface Principal {
  /** The `sub` of a token, the client of an API key, the account of a session. */
  readonly id: string
  readonly roles: readonly Role[]
  /** How the caller authenticated: only cookie sessions need a CSRF token. */
  readonly via: 'token' | 'api-key' | 'session'
}
