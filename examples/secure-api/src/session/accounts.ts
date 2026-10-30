import type { Logger } from '@znight/observability'
import type { Principal } from '../auth/principal.js'
import type { SessionConfig } from '../config/session.config.js'
import type { PasswordHasher } from '../security/password-hasher.js'

import { randomBytes } from 'node:crypto'
import { Injectable } from '@znight/core'
import { z } from 'zod'

import { ROLES } from '../auth/access.js'

const LocalAccounts = z.array(
  z.object({
    id: z.string().min(1),
    username: z.string().min(1),
    roles: z.array(z.enum(ROLES)),
    passwordHash: z.string().startsWith('$scrypt$'),
  }),
)

type Account = z.output<typeof LocalAccounts>[number]

/**
 * The accounts of the web front-end (`LOCAL_ACCOUNTS`), validated when the application starts: a
 * malformed list, an unknown role or a password that is not a PHC hash fail the boot.
 *
 * A real application keeps its accounts in a database; the rules stay the same: hash with
 * `PasswordHasher`, compare in constant time, never tell which half of the credentials was wrong.
 */
@Injectable()
export class Accounts {
  readonly #byId = new Map<string, Account>()
  readonly #byUsername = new Map<string, Account>()
  #decoy: Promise<string> | undefined

  constructor(
    config: SessionConfig,
    private readonly hasher: PasswordHasher,
    private readonly logger: Logger,
  ) {
    const parsed = LocalAccounts.safeParse(config.accounts)
    // the issues name paths and rules, never the values (they hold password hashes)
    if (!parsed.success) throw new Error(`Invalid LOCAL_ACCOUNTS:\n${z.prettifyError(parsed.error)}`)
    for (const account of parsed.data) {
      if (this.#byId.has(account.id) || this.#byUsername.has(account.username)) {
        throw new Error(`Invalid LOCAL_ACCOUNTS: account ${account.id} (${account.username}) is defined twice`)
      }
      const copy = { ...account } // the hash of an account is upgraded in place (see signIn)
      this.#byId.set(copy.id, copy)
      this.#byUsername.set(copy.username, copy)
    }
  }

  /** The principal of an account, with its current roles; `undefined` once the account is removed. */
  principal(id: string): Principal | undefined {
    const account = this.#byId.get(id)
    return account === undefined ? undefined : { id: account.id, roles: account.roles, via: 'session' }
  }

  /** The account matching the credentials, or `undefined`. */
  async signIn(username: string, password: string): Promise<Principal | undefined> {
    const account = this.#byUsername.get(username)
    // an unknown name costs a hash too: the response time does not tell which names exist
    const stored = account?.passwordHash ?? (await this.#decoyHash())
    const valid = await this.hasher.verify(password, stored)
    if (account === undefined || !valid) return undefined

    if (this.hasher.needsRehash(account.passwordHash)) {
      // the only moment the password is known: upgrade a hash made with older parameters
      account.passwordHash = await this.hasher.hash(password)
      this.logger.info('Password hash upgraded', { account: account.id }) // a database would store it here
    }
    return this.principal(account.id)
  }

  /** A hash of a random password, made once: what unknown names are compared with. */
  #decoyHash(): Promise<string> {
    this.#decoy ??= this.hasher.hash(randomBytes(32).toString('base64'))
    return this.#decoy
  }
}
