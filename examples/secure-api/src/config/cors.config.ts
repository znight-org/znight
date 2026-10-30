import { Config, Env } from '@znight/config'

/** The browser front-ends of the API. */
@Config('cors')
export class CorsConfig {
  /**
   * Origins allowed to call the API from a browser, comma-separated and written exactly as browsers
   * send them: `https://notes.example.com,http://localhost:5173` (no path, no trailing slash, a
   * malformed origin fails the boot). Read by the CORS policy and by `CsrfGuard`. Empty: no CORS.
   */
  @Env('CORS_ORIGINS')
  origins: string[] = []
}
