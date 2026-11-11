import type { ConfigPluginOptions } from '@znight/config'
import type { Plugin } from '@znight/core'
import type { HttpPluginOptions } from '@znight/http'
import type { ObservabilityOptions } from '@znight/observability'

import { ConfigPlugin } from '@znight/config'
import { EventsPlugin } from '@znight/events'
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'
import { ObservabilityPlugin } from '@znight/observability'

import { AuthGuard } from './auth/auth.guard.js'
import { ServerConfig } from './config/server.config.js'
import { DomainErrorMapper } from './shared/domain-error.mapper.js'
import { httpSecurityOptions } from './shared/http-security.js'

/** What the tests change in the production wiring (`test/support/app.ts`). */
export interface AppOptions {
  /** Options of `ConfigPlugin`. Default: `.env` files, then the environment. Tests pass `inline()` values. */
  readonly config?: ConfigPluginOptions
  /** Merged over the observability options (tests: silent logs, no `/metrics` server). */
  readonly observability?: ObservabilityOptions
  /** Merged over the HTTP options (tests: `port: 0`; the tests of the boot checks change more). */
  readonly http?: Partial<HttpPluginOptions>
}

/**
 * The plugins of the application, used by `src/main.ts` and by the tests (`createTestApp()`): the
 * tests run the production wiring, with the few changes of {@link AppOptions}.
 */
export function plugins(options: AppOptions = {}): Plugin[] {
  return [
    // First, so that its hooks wrap everything else: one JSON log line per request (with its
    // requestId), RED metrics on a separate /metrics server, traces. Options may be computed from
    // config classes: the function runs once ConfigPlugin has loaded the configuration.
    ObservabilityPlugin.configure(container => {
      const server = container.get(ServerConfig)
      return {
        logging: { level: server.logLevel, requests: { ignore: event => event.route === '/health' } },
        metrics: { defaultLabels: { service: 'bookshelf' }, server: { port: server.metricsPort } },
        ...options.observability,
      }
    }),
    // Application events (BookAdded): listed before HttpPlugin, so that it stops after it and drains
    // the detached listeners once no request can publish any more.
    EventsPlugin.configure(),
    // Loads .env files then the environment, and validates every @Config class before anything
    // is created: a missing API_KEY stops the boot with every problem listed (ZNIGHT006).
    ConfigPlugin.configure(options.config),
    HttpPlugin.configure(container => {
      const server = container.get(ServerConfig)
      return {
        adapter: fastifyAdapter(),
        port: server.port,
        host: server.host,
        // Global guards run before the guards of controllers and routes. AuthGuard enforces the
        // "access" decision of every route (`static enforces`): without it, the boot fails with
        // ZNIGHT023 listing the unprotected routes.
        guards: [AuthGuard],
        exceptionMappers: [DomainErrorMapper],
        exposeErrors: server.exposeErrors,
        bodyLimit: '64kb', // JSON bodies are small; the cover upload route computes its own limit
        // CORS, security headers and trusted proxies
        ...httpSecurityOptions(server),
        ...options.http,
      }
    }),
  ]
}
