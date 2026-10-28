import { Config, Env } from '@znight/config'

/** Log levels accepted by `LOG_LEVEL` (a literal union: any other value fails the boot). */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/**
 * The HTTP server, validated at boot by ConfigPlugin. Every property is read from the environment
 * (or a `.env` file) and coerced to its type; properties with an initializer are optional.
 */
@Config('server')
export class ServerConfig {
  /** Port of the API (`0` picks a free port, logged when ready). */
  @Env('PORT')
  port = 3000

  /** Interface the API binds to. */
  @Env('HOST')
  host = '0.0.0.0'

  /** Minimum level of the JSON logs. */
  @Env('LOG_LEVEL')
  logLevel: LogLevel = 'info'

  /** Send the message of unexpected errors in 500 responses. Development only. */
  @Env('EXPOSE_ERRORS')
  exposeErrors = false

  /**
   * The proxies in front of the API (load balancer, ingress), comma-separated: addresses, CIDR ranges
   * or the aliases `loopback`, `private` and `linklocal`. Behind them, `ctx.ip` is the client read
   * from `x-forwarded-for` (the rate limit of anonymous callers and the audit logs depend on it).
   * Empty: the address of the connection. Never "every hop": a client would choose its address.
   */
  @Env('TRUSTED_PROXIES')
  trustedProxies: string[] = []
}
