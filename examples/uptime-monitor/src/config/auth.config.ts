import { Config, Secret } from '@znight/config'

/**
 * API keys. `@Secret` values are masked (`[REDACTED]`) whenever the instance is logged, serialised or
 * printed in an error message; the properties themselves keep the real values.
 */
@Config('auth')
export class AuthConfig {
  /** Key of the administrators: monitors, jobs and the outbox. Required: no boot without it. */
  @Secret('API_KEY')
  apiKey!: string

  /** Optional read-only key: lists monitors and their results. */
  @Secret('READONLY_API_KEY')
  readonlyApiKey?: string
}
