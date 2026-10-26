import { Config, Env, Secret } from '@znight/config'

/** SMTP settings: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_LATENCY_MS. */
@Config('smtp')
export class SmtpConfig {
  host = 'localhost'

  port = 587

  @Env('SMTP_USER')
  user?: string

  /** Masked when the config is printed (`[REDACTED]`). */
  @Secret('SMTP_PASSWORD')
  password?: string

  /** Sender of every email. */
  from = 'Znight Worker <no-reply@example.com>'

  /** Simulated round trip of the fake SMTP server, in milliseconds. */
  latencyMs = 20
}
