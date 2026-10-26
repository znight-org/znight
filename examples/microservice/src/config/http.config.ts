import { Config, Env } from '@znight/config'

/**
 * HTTP settings, validated at boot by ConfigPlugin (a wrong value stops the service with every
 * problem listed). Each property reads `HTTP_<PROPERTY>` from the environment or a `.env` file,
 * unless `@Env` names the variable; the TypeScript type selects the coercion (`"8080"` → `8080`).
 */
@Config('http')
export class HttpConfig {
  /** Listening port (`PORT`, the variable most platforms set). `0` picks a free port. */
  @Env('PORT')
  port = 3000

  /** Interface to bind (`HTTP_HOST`). */
  host = '0.0.0.0'

  /** Send the message of unexpected errors in 500 responses (`HTTP_EXPOSE_ERRORS`): development only. */
  exposeErrors = false
}
