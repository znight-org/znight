import { Config, Env } from '@znight/config'

/** Log levels accepted by `LOG_LEVEL` (a literal union: any other value fails the boot). */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/**
 * Settings of the HTTP server, of the logs and of the GraphQL error masking, read from the
 * environment (or a `.env` file) and validated at boot by `ConfigPlugin`. Properties with an
 * initializer are optional.
 */
@Config('server')
export class ServerConfig {
  /** Port of the API (`0` picks a free port, logged when the application is ready). */
  @Env('PORT')
  port = 3000

  /** Interface the API binds to. */
  @Env('HOST')
  host = '0.0.0.0'

  /** Minimum level of the JSON logs. */
  @Env('LOG_LEVEL')
  logLevel: LogLevel = 'info'

  /**
   * Send the real message of unexpected errors (`Unexpected error.` otherwise), in GraphQL errors and
   * in HTTP 500 responses. Development only.
   */
  @Env('EXPOSE_ERRORS')
  exposeErrors = false
}
