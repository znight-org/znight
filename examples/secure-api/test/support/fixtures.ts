import type { LocalAccount } from '../../src/config/session.config.js'

import { createHmac, randomBytes, scryptSync } from 'node:crypto'

import { PasswordHasher } from '../../src/security/password-hasher.js'

/** The browser front-end allowed by CORS (`CORS_ORIGINS`). */
export const BROWSER_ORIGIN = 'https://notes.example.com'

/** The keys of the export client: the current one and the next one (a rotation in progress). */
export const EXPORT_KEY = 'export-key-current-0123456789'
export const NEXT_EXPORT_KEY = 'export-key-next-0123456789'

export const WEBHOOK_SECRET = 'whsec-test-0123456789abcdef'
export const SESSION_SECRET = 'session-secret-for-tests-0123456789abcdef'

/** Accounts of the web front-end, with their passwords (the configuration only holds hashes). */
export const ADA = { id: 'acc-ada', username: 'ada', password: 'ada-correct-horse-battery', roles: ['editor'] }
export const GRACE = { id: 'acc-grace', username: 'grace', password: 'grace-staple-horse', roles: ['admin'] }
/** Hashed with older parameters (N = 2^14): upgraded at the first successful sign-in. */
export const LINUS = { id: 'acc-linus', username: 'linus', password: 'linus-legacy-password', roles: ['reader'] }

/** A PHC string made with lower parameters than `PasswordHasher` uses today. */
export function legacyHash(password: string, ln = 14): string {
  const salt = randomBytes(16)
  const key = scryptSync(password.normalize('NFC'), salt, 32, { N: 2 ** ln, r: 8, p: 1 })
  const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '')
  return `$scrypt$ln=${ln},r=8,p=1$${b64(salt)}$${b64(key)}`
}

const hasher = new PasswordHasher()

/** `LOCAL_ACCOUNTS`, hashed once per test process. */
export const LOCAL_ACCOUNTS: readonly LocalAccount[] = [
  { id: ADA.id, username: ADA.username, roles: ADA.roles, passwordHash: await hasher.hash(ADA.password) },
  { id: GRACE.id, username: GRACE.username, roles: GRACE.roles, passwordHash: await hasher.hash(GRACE.password) },
  { id: LINUS.id, username: LINUS.username, roles: LINUS.roles, passwordHash: legacyHash(LINUS.password) },
]

/** The `x-signature` header of a webhook delivery, as the billing provider computes it. */
export function signWebhook(body: string, { secret = WEBHOOK_SECRET, timestamp = Date.now() / 1000 } = {}): string {
  const t = Math.floor(timestamp)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}
