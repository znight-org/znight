/**
 * Development tokens, standing in for the identity provider on your machine. Creates an RS256 key
 * pair and its public key set once (`.dev/`, git-ignored), then prints a token signed with it, for
 * the issuer and audience of `.env.development` (`AUTH_JWKS_FILE=.dev/jwks.json`):
 *
 *   bun scripts/dev-token.ts --sub u-ada --roles editor      # or: node scripts/dev-token.ts ...
 *   curl -H "authorization: Bearer $(bun scripts/dev-token.ts --roles admin)" localhost:3000/me
 *
 * Options: --sub (default dev-user), --roles (comma-separated), --ttl (default 1h), --iss, --aud,
 * --dir (default .dev). Production never sees these keys: it verifies the tokens of the identity
 * provider with its published key set (AUTH_JWKS_URL).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from 'jose'

const { values: options } = parseArgs({
  options: {
    sub: { type: 'string', default: 'dev-user' },
    roles: { type: 'string', default: '' },
    ttl: { type: 'string', default: '1h' },
    iss: { type: 'string', default: 'https://id.notes.localhost/' },
    aud: { type: 'string', default: 'https://api.notes.localhost' },
    dir: { type: 'string', default: '.dev' },
  },
})

const KID = 'dev'
const privateKeyFile = join(options.dir, 'private.jwk.json')
const keySetFile = join(options.dir, 'jwks.json')

if (!existsSync(privateKeyFile)) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  mkdirSync(options.dir, { recursive: true })
  const privateJwk = { ...(await exportJWK(privateKey)), kid: KID, alg: 'RS256' }
  writeFileSync(privateKeyFile, JSON.stringify(privateJwk), { mode: 0o600 })
  const keySet = { keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] }
  writeFileSync(keySetFile, `${JSON.stringify(keySet, null, 2)}\n`)
  console.error(`Created ${privateKeyFile} and ${keySetFile} (restart the API if it is running)`)
}

const privateKey = await importJWK(JSON.parse(readFileSync(privateKeyFile, 'utf8')) as JWK, 'RS256')
const roles = options.roles
  .split(',')
  .map(role => role.trim())
  .filter(role => role !== '')
const token = await new SignJWT({ roles })
  .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
  .setSubject(options.sub)
  .setIssuer(options.iss)
  .setAudience(options.aud)
  .setIssuedAt()
  .setExpirationTime(options.ttl)
  .sign(privateKey)

process.stdout.write(`${token}\n`)
