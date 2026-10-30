import { Config, Env, Secret } from '@znight/config'

@Config('auth')
export class AuthConfig {
  /** The `iss` of the tokens: `https://id.example.com/`. */
  @Env('AUTH_ISSUER')
  issuer!: string

  /** The `aud` this API accepts: `https://api.example.com`. */
  @Env('AUTH_AUDIENCE')
  audience!: string

  /** The JSON Web Key Set of the identity provider (`<issuer>/.well-known/jwks.json`). */
  @Env('AUTH_JWKS_URL')
  jwksUrl?: URL

  /** Development: a key set on disk instead (`scripts/dev-token.ts` writes `.dev/jwks.json`). */
  @Env('AUTH_JWKS_FILE')
  jwksFile?: string

  /** Keys of the export client (see API keys), comma-separated: the current and the next one. */
  @Secret('EXPORT_API_KEYS')
  exportApiKeys: string[] = []
}
