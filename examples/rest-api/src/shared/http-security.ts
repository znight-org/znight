import type { HttpPluginOptions } from '@znight/http'
import type { ServerConfig } from '../config/server.config.js'

/** Response headers a browser page may read on a cross-origin reply (CORS). */
const EXPOSED_HEADERS = ['location', 'x-request-id']

/**
 * The browser-facing security options of `HttpPlugin`, shared by `main.ts` and the tests so that
 * both serve the API with the same policies. They are validated at boot (ZNIGHT005): a malformed
 * origin or proxy address stops the application instead of silently matching nothing.
 *
 * - `cors`: only when origins are configured. Preflights are answered by the pipeline before the
 *   guards (a browser sends them without the API key), identically on every adapter. CORS is not
 *   access control: it decides what a page may read, `AuthGuard` decides who may call.
 * - `securityHeaders`: on by default (`content-security-policy: default-src 'none'`,
 *   `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer`).
 *   `cache-control: no-store` is added because responses depend on the caller's API key: shared
 *   caches must not keep them. A route setting its own header wins (the public cover is cacheable).
 *   HSTS is left to the TLS terminator.
 * - `trustProxy`: behind the configured proxies, `ctx.ip` is the client from `x-forwarded-for`
 *   (logged with rejected API keys) and `ctx.protocol` comes from `x-forwarded-proto`.
 */
export function httpSecurityOptions(
  server: ServerConfig,
): Required<Pick<HttpPluginOptions, 'cors' | 'securityHeaders' | 'trustProxy'>> {
  return {
    cors: server.corsOrigins.length > 0 && { origin: server.corsOrigins, exposeHeaders: EXPOSED_HEADERS },
    securityHeaders: { cacheControl: 'no-store' },
    trustProxy: server.trustedProxies.length > 0 && server.trustedProxies,
  }
}
