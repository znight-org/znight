import { Config, Env } from '@znight/config'

/** Log levels accepted by `LOG_LEVEL` (a literal union: any other value fails the boot). */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/**
 * Settings of the HTTP server and of the operational endpoints, validated at boot by ConfigPlugin.
 *
 * Every property is read from the environment (or a `.env` file) and coerced to its type: `PORT=8080`
 * becomes the number 8080, `EXPOSE_ERRORS=yes` the boolean `true`. Properties with an initializer are
 * optional. Without `@Env`, the name would be derived from the prefix: `SERVER_<PROPERTY>`.
 */
@Config('server')
export class ServerConfig {
  /** Port of the API (`0` picks a free port). */
  @Env('PORT')
  port = 3000

  /** Interface the API binds to. */
  @Env('HOST')
  host = '0.0.0.0'

  /** Port of the Prometheus `/metrics` endpoint, served apart from the API (`0` picks a free port). */
  @Env('METRICS_PORT')
  metricsPort = 9464

  /** Minimum level of the JSON logs. */
  @Env('LOG_LEVEL')
  logLevel: LogLevel = 'info'

  /** Send the message of unexpected errors in 500 responses. Development only. */
  @Env('EXPOSE_ERRORS')
  exposeErrors = false
}
