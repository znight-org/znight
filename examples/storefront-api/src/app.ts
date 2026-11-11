import type { ConfigPluginOptions } from '@znight/config'
import type { Plugin } from '@znight/core'
import type { HttpPluginOptions } from '@znight/http'
import type { ObservabilityOptions } from '@znight/observability'
import type { OpenApiPluginOptions } from '@znight/openapi'

import { ConfigPlugin } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { ObservabilityPlugin } from '@znight/observability'
import { OpenApiPlugin } from '@znight/openapi'

import { ServerConfig } from './config/server.config.js'
import { httpOptions, openApiOptions } from './http.js'

/** What `src/main.ts` and the tests (`test/support/app.ts`) change in the wiring. */
export interface AppOptions {
  /** Options of `ConfigPlugin`. Default: `.env` files, then the environment. Tests pass `inline()` values. */
  readonly config?: ConfigPluginOptions
  /** Merged over the observability options (tests: silent logs). */
  readonly observability?: ObservabilityOptions
  /** Merged over the HTTP options of `src/http.ts` (tests: `port: 0`). */
  readonly http?: Partial<HttpPluginOptions>
  /** Merged over the OpenAPI options of `src/http.ts` (`main.ts`: the document of the build in production). */
  readonly openapi?: Partial<OpenApiPluginOptions>
}

/**
 * The plugins of the application, used by `src/main.ts` and by the tests (`createTestApp()`): the
 * tests run the production wiring, with the few changes of {@link AppOptions}.
 */
export function plugins(options: AppOptions = {}): Plugin[] {
  return [
    // First, so that its hooks wrap everything else: one JSON log line per request (with its
    // requestId), traces. Options may be computed from config classes: the function runs once
    // ConfigPlugin has loaded the configuration. Health checks and documentation requests are not
    // logged. Metrics need the optional `prom-client`, which this example does not install
    // (examples/rest-api shows them): `false` says so explicitly.
    ObservabilityPlugin.configure(container => ({
      logging: {
        level: container.get(ServerConfig).logLevel,
        requests: {
          ignore: event =>
            event.route === '/health' || event.route === '/openapi.json' || event.route?.startsWith('/docs') === true,
        },
      },
      metrics: false,
      ...options.observability,
    })),
    // Loads .env files then the environment, and validates every @Config class before anything
    // is created: a missing ADMIN_API_KEY stops the boot with every problem listed (ZNIGHT006).
    ConfigPlugin.configure(options.config),
    HttpPlugin.configure(container => ({ ...httpOptions(container.get(ServerConfig)), ...options.http })),
    OpenApiPlugin.configure(container => ({ ...openApiOptions(container.get(ServerConfig)), ...options.openapi })),
  ]
}
