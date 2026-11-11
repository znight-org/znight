import type { ZnightMetadata } from '@znight/core'
import type { HttpPluginOptions } from '@znight/http'

import { inline } from '@znight/config'
import { TestApp, type TestAppOptions } from '@znight/testing'

import { metadata as generatedMetadata } from '../../src/.znight/container.generated.js'
import { plugins } from '../../src/app.js'
import { ADMIN_KEY, BROWSER_ORIGIN, MIGRATIONS_FOLDER, READER_KEY } from './fixtures.js'

export interface TestAppSetup extends Omit<TestAppOptions, 'metadata' | 'plugins'> {
  /** The application metadata. Default: the generated one. */
  readonly metadata?: ZnightMetadata
  /** Configuration values, over the test defaults (`API_KEY`, `CORS_ORIGINS`...). */
  readonly env?: Readonly<Record<string, string>>
  /** Merged over the HTTP options of `src/app.ts`, for the tests of the boot checks only. */
  readonly http?: Partial<HttpPluginOptions>
}

/**
 * The application with the plugins of `src/app.ts`, the ones `src/main.ts` runs (same adapter,
 * global guard, exception mapper and security options), a fresh in-memory database and test
 * configuration:
 *
 * - `inline()` replaces `.env` files and the environment: tests do not depend on the machine;
 * - a browser origin is allowed (CORS), and the loopback address is a trusted proxy (`app.inject()`
 *   requests come from 127.0.0.1, so `x-forwarded-for` gives the client address);
 * - logs are silenced and the `/metrics` server is not started (metrics are still recorded);
 * - `port: 0`: `app.inject()` sends requests in memory, the server listens on a free port.
 */
export function createTestApp({
  metadata = generatedMetadata,
  env = {},
  http = {},
  ...options
}: TestAppSetup = {}): Promise<TestApp> {
  return TestApp.create({
    metadata,
    plugins: plugins({
      observability: { logging: { level: 'silent' }, metrics: { server: false, defaultMetrics: false } },
      config: {
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
      },
      http: { port: 0, ...http },
    }),
    ...options,
  })
}
