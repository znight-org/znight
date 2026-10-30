import type { HttpPluginOptions } from '@znight/http'
import type { OpenApiPluginOptions } from '@znight/openapi'
import type { ServerConfig } from './config/server.config.js'

import { honoAdapter } from '@znight/http/hono'

import { Public } from './auth/auth.decorators.js'
import { AuthGuard } from './auth/auth.guard.js'
import converters from './openapi.converters.js'
import { DomainErrorMapper } from './shared/domain-error.mapper.js'

/**
 * Options of `HttpPlugin`, shared by `main.ts` and the tests so that both serve the API the same
 * way. Called once per application (`HttpPlugin.configure(container => httpOptions(...))`): an
 * adapter instance serves a single application.
 *
 * - `honoAdapter()`: Hono's router, served by `Bun.serve()` on Bun and by `@hono/node-server` on
 *   Node.js. Responses are identical on every adapter (the Znight pipeline produces them).
 * - `guards: [AuthGuard]`: global, so it runs before the guards of controllers and routes. It
 *   enforces the `access` decision of every route; without it the boot fails (ZNIGHT023).
 * - `securityHeaders`: on by default; `no-store` because responses depend on the caller's
 *   credentials. A route setting its own `cache-control` wins (product images, the OpenAPI document).
 */
export function httpOptions(server: ServerConfig): HttpPluginOptions {
  return {
    adapter: honoAdapter(),
    port: server.port,
    host: server.host,
    guards: [AuthGuard],
    exceptionMappers: [DomainErrorMapper],
    exposeErrors: server.exposeErrors,
    // JSON bodies are small; the image upload route computes its own limit from `maxSize`
    bodyLimit: '64kb',
    securityHeaders: { cacheControl: 'no-store' },
  }
}

/**
 * Options of `OpenApiPlugin`: `GET /openapi.json` (the document) and `GET /docs` (Scalar).
 *
 * - `meta: [Public.meta()]`: the docs routes are plugin routes of `HttpPlugin`; they go through the
 *   global guards, and the `access` group is required: they need a decision too.
 * - `converters`: the module that `vite.config.ts` and `znight openapi` get too.
 * - `document`: `'build'` assembles the document from the generated metadata at boot (development,
 *   tests); in production, `main.ts` passes `{ file }`, the `dist/openapi.json` written by
 *   `znight build`: no schema conversion at boot, and the bytes served are the reviewed ones.
 * - Scalar's assets come from `node_modules` when `@scalar/api-reference` is installed, otherwise
 *   from the jsDelivr CDN at the version pinned by `@znight/openapi`, with Subresource Integrity.
 */
export function openApiOptions(
  server: ServerConfig,
  document: OpenApiPluginOptions['document'] = 'build',
): OpenApiPluginOptions {
  return {
    enabled: server.docs, // DOCS=false: an internal deployment serves no documentation
    meta: [Public.meta()],
    converters,
    document,
  }
}
