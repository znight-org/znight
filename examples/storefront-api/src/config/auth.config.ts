import { Config, Secret } from '@znight/config'

/**
 * Credentials of the callers. `@Secret` values are masked (`[REDACTED]`) whenever the instance is
 * logged, serialised or printed in an error message; the properties themselves keep the real values.
 *
 * The verifiers are deliberately trivial (static tokens from the configuration): real customer
 * authentication (JWT, sessions, OAuth 2.0) is the subject of `examples/secure-api`.
 */
@Config('auth')
export class AuthConfig {
  /**
   * Bearer tokens of the customers, as a JSON object `{ "<customer id>": "<token>" }`:
   * `CUSTOMER_TOKENS={"alice":"s3cr3t"}`. Required: the application does not start without it.
   */
  @Secret('CUSTOMER_TOKENS')
  customerTokens!: Readonly<Record<string, string>>

  /** API key of the administrators (`x-api-key`): every back-office route. Required. */
  @Secret('ADMIN_API_KEY')
  adminApiKey!: string

  /** Optional API key of the catalogue managers: products and images only. */
  @Secret('CATALOG_API_KEY')
  catalogApiKey?: string
}
