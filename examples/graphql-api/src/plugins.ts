import type { ConfigLoader } from '@znight/config'
import type { Plugin } from '@znight/core'
import type { GraphQLPluginOptions } from '@znight/graphql'

import { ConfigPlugin } from '@znight/config'
import { GraphQLPlugin } from '@znight/graphql'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { ObservabilityPlugin } from '@znight/observability'

import { AccessGuard } from './auth/access.guard.js'
import { Public } from './auth/access.js'
import { AuthenticationGuard } from './auth/authentication.guard.js'
import { ServerConfig } from './config/server.config.js'
import { CatalogErrorMapper } from './shared/catalog-error.mapper.js'

/** What the tests change; `main.ts` passes nothing. */
export interface PluginsOptions {
  /**
   * Where the configuration comes from. Default: `.env` files, then the environment (which wins).
   * Tests pass `[inline({ ... })]`, so that they do not depend on the machine.
   */
  readonly config?: readonly ConfigLoader[]
  /** GraphQL options over the application's (`limits`, `subscriptions`...). */
  readonly graphql?: Partial<GraphQLPluginOptions>
}

/**
 * The plugins of the application, shared by `main.ts` and the tests so that both run the same
 * wiring. Called once per application: a plugin instance serves one application at a time.
 *
 * 1. `ObservabilityPlugin` first, so that its hooks wrap everything: one JSON log line per HTTP
 *    request (`/graphql` included), with its request id.
 * 2. `ConfigPlugin` loads and validates every `@Config` class before anything needs them.
 * 3. `HttpPlugin` serves the routes: the controllers', and those `GraphQLPlugin` contributes.
 * 4. `GraphQLPlugin` builds the schema from the generated metadata and serves it on `/graphql`.
 */
export function plugins(options: PluginsOptions = {}): Plugin[] {
  return [
    ObservabilityPlugin.configure(container => ({
      logging: {
        level: container.get(ServerConfig).logLevel,
        // the health checks of the load balancer would drown the interesting lines
        requests: { ignore: event => event.route === '/health' },
        redact: ['*.headers["x-api-key"]'],
      },
      metrics: false,
    })),

    ConfigPlugin.configure(options.config === undefined ? {} : { loaders: options.config }),

    HttpPlugin.configure(container => {
      const server = container.get(ServerConfig)
      return {
        // Hono's router: `Bun.serve()` on Bun (SSE streams included), `@hono/node-server` on Node.js
        adapter: honoAdapter(),
        port: server.port,
        host: server.host,
        // On every HTTP request, /graphql included: identify the caller (an API key), then decide.
        guards: [AuthenticationGuard, AccessGuard],
        exposeErrors: server.exposeErrors,
        // responses depend on the caller's key: no shared cache
        securityHeaders: { cacheControl: 'no-store' },
      }
    }),

    GraphQLPlugin.configure(container => ({
      // the same guard decides per root field: the endpoint itself is open, the fields are not
      guards: [AccessGuard],
      http: { meta: [Public.meta()] },
      errorMappers: [CatalogErrorMapper],
      exposeErrors: container.get(ServerConfig).exposeErrors,
      // introspection: on unless NODE_ENV=production; GraphiQL: with NODE_ENV=development (`bun run dev`)
      ...options.graphql,
    })),
  ]
}
