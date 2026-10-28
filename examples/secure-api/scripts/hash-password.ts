/**
 * Hashes a password for `LOCAL_ACCOUNTS`, with the parameters the application uses:
 *
 *   printf '%s' 'a long passphrase' | bun scripts/hash-password.ts
 *
 * The password is read from stdin, so that it stays out of the process list. It runs on Bun, which
 * executes the TypeScript decorators of `src/` directly (Node.js does not run decorators yet).
 */
import { PasswordHasher } from '../src/security/password-hasher.js'

const MIN_LENGTH = 12

const chunks: Uint8Array[] = []
for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array)
const password = Buffer.concat(chunks)
  .toString('utf8')
  .replace(/\r?\n$/, '')

if (password.length < MIN_LENGTH) {
  console.error(`The password must have at least ${MIN_LENGTH} characters`)
  process.exitCode = 1
} else {
  process.stdout.write(`${await new PasswordHasher().hash(password)}\n`)
}
