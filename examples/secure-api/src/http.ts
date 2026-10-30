import { HttpPlugin } from '@znight/http'

import { AuthGuard } from './auth/auth.guard.js'
import { CorsConfig } from './config/cors.config.js'
import { ServerConfig } from './config/server.config.js'
import { SessionConfig } from './config/session.config.js'
import { CsrfGuard } from './security/csrf.guard.js'
import { RateLimitGuard } from './security/rate-limit.js'

/** A new plugin instance per application (a plugin instance serves one application at a time). */
export function httpPlugin(): HttpPlugin {
  return HttpPlugin.configure(container => {
    const server = container.get(ServerConfig)
    const { origins } = container.get(CorsConfig)
    return {
      port: server.port,
      host: server.host,
      exposeErrors: server.exposeErrors,
      bodyLimit: '64kb',
      // AuthGuard first: the rate limit keys on the caller, the CSRF check depends on how they authenticated
      guards: [AuthGuard, RateLimitGuard, CsrfGuard],
      // credentials: a front-end of another origin of the same site signs in with the session cookie
      cors: origins.length > 0 && {
        origin: origins,
        credentials: true,
        exposeHeaders: ['location', 'retry-after', 'x-request-id'],
      },
      securityHeaders: { cacheControl: 'no-store' }, // answers depend on the caller: never in a shared cache
      trustProxy: server.trustedProxies.length > 0 && server.trustedProxies,
      cookies: { secrets: container.get(SessionConfig).secrets }, // signs the session cookie
    }
  })
}
