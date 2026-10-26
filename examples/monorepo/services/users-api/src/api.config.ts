import { Config, Env } from '@znight/config'

/**
 * Settings of users-api, validated at boot by ConfigPlugin (every problem reported at once). Each
 * property is read from the environment or a .env file: `API_<PROPERTY>` by default, or the name
 * given to @Env. Properties with an initializer or `?` are optional.
 */
@Config('api')
export class ApiConfig {
  /** HTTP port (PORT). `0` picks a free port. */
  @Env('PORT')
  port = 3000

  /**
   * JSON file where the users are saved on shutdown and restored at startup (USERS_SNAPSHOT_FILE).
   * Without it, users only live as long as the process.
   */
  @Env('USERS_SNAPSHOT_FILE')
  snapshotFile?: string

  /** Send the message of unexpected errors in 500 responses (API_EXPOSE_ERRORS): development only. */
  exposeErrors = false
}
