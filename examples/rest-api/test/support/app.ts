import type { ZnightMetadata } from '@znight/core'

import { ConfigPlugin, inline } from '@znight/config'
import { HttpPlugin, type HttpPluginOptions } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'
import { ObservabilityPlugin } from '@znight/observability'
import { TestApp, type TestAppOptions } from '@znight/testing'

import { __ZNIGHT_METADATA__ } from '../../src/.znight/container.generated.js'
import { AuthGuard } from '../../src/auth/auth.guard.js'
import { ServerConfig } from '../../src/config/server.config.js'
import { DomainErrorMapper } from '../../src/shared/domain-error.mapper.js'
import { httpSecurityOptions } from '../../src/shared/http-security.js'
import { ADMIN_KEY, BROWSER_ORIGIN, MIGRATIONS_FOLDER, READER_KEY } from './fixtures.js'

export interface TestAppSetup extends Omit<TestAppOptions, 'metadata' | 'plugins'> {
  /** The application metadata. Default: the generated one. */
  readonly metadata?: ZnightMetadata
  /** Configuration values, over the test defaults (`API_KEY`, `CORS_ORIGINS`...). */
  readonly env?: Readonly<Record<string, string>>
  /** Merged over the HTTP options of `main.ts`, for the tests of the boot checks only. */
  readonly http?: Partial<HttpPluginOptions>
}

/**
 * The application as `src/main.ts` wires it (same adapter, global guard, exception mapper and
 * security options), with a fresh in-memory database and test configuration:
 *
 * - `inline()` replaces `.env` files and the environment: tests do not depend on the machine;
 * - a browser origin is allowed (CORS), and the loopback address is a trusted proxy (`app.inject()`
 *   requests come from 127.0.0.1, so `x-forwarded-for` gives the client address);
 * - logs are silenced and the `/metrics` server is not started (metrics are still recorded);
 * - `port: 0`: `app.inject()` sends requests in memory, the server listens on a free port.
 */
export function createTestApp({
  metadata = __ZNIGHT_METADATA__,
  env = {},
  http = {},
  ...options
}: TestAppSetup = {}): Promise<TestApp> {
  return TestApp.create({
    metadata,
    plugins: [
      ObservabilityPlugin.configure({
        logging: { level: 'silent' },
        metrics: { server: false, defaultMetrics: false },
      }),
      ConfigPlugin.configure({
        loaders: [
          inline({
            API_KEY: ADMIN_KEY,
            READONLY_API_KEY: READER_KEY,
            DATABASE_MIGRATIONS_FOLDER: MIGRATIONS_FOLDER,
            CORS_ORIGINS: BROWSER_ORIGIN,
            TRUSTED_PROXIES: 'loopback',
            ...env,
          }),
        ],
      }),
      HttpPlugin.configure(container => ({
        adapter: fastifyAdapter(),
        port: 0,
        guards: [AuthGuard],
        exceptionMappers: [DomainErrorMapper],
        ...httpSecurityOptions(container.get(ServerConfig)),
        ...http,
      })),
    ],
    ...options,
  })
}
