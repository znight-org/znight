import { Config, Env, Secret } from '@znight/config'

/**
 * An account of the web front-end, signing in with a password. The configuration holds the PHC
 * string of the password (`$scrypt$ln=17,r=8,p=1$...`, see `scripts/hash-password.ts`), never the
 * password itself. A JSON value: `Accounts` validates its shape at boot.
 */
export interface LocalAccount {
  readonly id: string
  readonly username: string
  readonly roles: readonly string[]
  readonly passwordHash: string
}

/** Cookie sessions of the web front-end (password sign-in, see `src/session/`). */
@Config('session')
export class SessionConfig {
  /**
   * Keys signing the session cookie, comma-separated, at least 32 bytes each
   * (`openssl rand -base64 32`): the first signs, all verify. Rotate by prepending a new key, then
   * removing the old one once the longest session has expired. Removing a key ends its sessions.
   */
  @Secret('SESSION_SECRETS')
  secrets!: string[]

  /** The accounts, as a JSON array of {@link LocalAccount}. Empty: password sign-in always fails. */
  @Secret('LOCAL_ACCOUNTS')
  accounts: LocalAccount[] = []

  /** Lifetime of a session in seconds (8 hours): the cookie and the signed expiry agree. */
  @Env('SESSION_MAX_AGE')
  maxAge = 28_800
}
