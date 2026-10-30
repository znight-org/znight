import { Config, Env } from '@znight/config'

/** Log levels accepted by `LOG_LEVEL` (a literal union: any other value fails the boot). */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/**
 * Settings of the HTTP server, validated at boot by ConfigPlugin: every property is read from the
 * environment (or a `.env` file) and coerced to its type (`PORT=8080` becomes the number 8080,
 * `DOCS=false` the boolean `false`). Properties with an initializer are optional.
 */
@Config('server')
export class ServerConfig {
  /** Port of the API (`0` picks a free port). */
  @Env('PORT')
  port = 3000

  /** Interface the API binds to. */
  @Env('HOST')
  host = '0.0.0.0'

  /** Minimum level of the JSON logs. */
  @Env('LOG_LEVEL')
  logLevel: LogLevel = 'info'

  /** Serve the OpenAPI document and the API reference (`/openapi.json`, `/docs`). */
  @Env('DOCS')
  docs = true

  /** Send the message of unexpected errors in 500 responses. Development only. */
  @Env('EXPOSE_ERRORS')
  exposeErrors = false
}
