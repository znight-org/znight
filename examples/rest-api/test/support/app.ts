import { ConfigPlugin, inline } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'
import { ObservabilityPlugin } from '@znight/observability'
import { TestApp, type TestAppOptions } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../../src/.znight/container.generated.js'
import { AuthGuard } from '../../src/auth/auth.guard.js'
import { DomainErrorMapper } from '../../src/shared/domain-error.mapper.js'
import { ADMIN_KEY, MIGRATIONS_FOLDER, READER_KEY } from './fixtures.js'

/**
 * The application as `src/main.ts` wires it (same adapter, global guard and exception mapper), with
 * a fresh in-memory database and test configuration:
 *
 * - `inline()` replaces `.env` files and the environment: tests do not depend on the machine;
 * - logs are silenced and the `/metrics` server is not started (metrics are still recorded);
 * - `port: 0`: `app.inject()` sends requests in memory, the server listens on a free port.
 */
export function createTestApp(options: Omit<TestAppOptions, 'metadata' | 'plugins'> = {}): Promise<TestApp> {
  return TestApp.create({
    metadata,
    plugins: [
      ObservabilityPlugin.configure({
        logging: { level: 'silent' },
        metrics: { server: false, defaultMetrics: false },
      }),
      ConfigPlugin.configure({
        loaders: [
          inline({ API_KEY: ADMIN_KEY, READONLY_API_KEY: READER_KEY, DATABASE_MIGRATIONS_FOLDER: MIGRATIONS_FOLDER }),
        ],
      }),
      HttpPlugin.configure({
        adapter: fastifyAdapter(),
        port: 0,
        guards: [AuthGuard],
        exceptionMappers: [DomainErrorMapper],
      }),
    ],
    ...options,
  })
}
