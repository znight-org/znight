import type { ZnightMetadata } from '@znight/core'
import type { OpenApiPluginOptions } from '@znight/openapi'

import { inline } from '@znight/config'
import { TestApp, type TestAppOptions } from '@znight/testing'

import { metadata as generatedMetadata } from '../../src/.znight/container.generated.js'
import { plugins } from '../../src/app.js'
import { TEST_ENV } from './fixtures.js'

export interface TestAppSetup extends Omit<TestAppOptions, 'metadata' | 'plugins'> {
  /** The application metadata. Default: the generated one. */
  readonly metadata?: ZnightMetadata
  /** Configuration values, over the test defaults (credentials of `fixtures.ts`). */
  readonly env?: Readonly<Record<string, string>>
  /** Merged over the OpenApiPlugin options of `src/app.ts`. */
  readonly openapi?: Partial<OpenApiPluginOptions>
}

/**
 * The application with the plugins of `src/app.ts`, the ones `src/main.ts` runs (from the option
 * functions of `src/http.ts`): Hono adapter, global `AuthGuard`, `DomainErrorMapper`, security
 * headers, `OpenApiPlugin` with the converters of `src/openapi.converters.ts`. Only the environment
 * differs:
 *
 * - `inline()` replaces `.env` files and the environment: tests do not depend on the machine;
 * - logs are silenced (metrics are off, as in `main.ts`);
 * - `port: 0`: `app.inject()` sends requests in memory, the server listens on a free port.
 *
 * Every application has its own in-memory repositories (the catalogue is seeded with
 * `CATALOG_SEED=true`), so tests that change the stock create their own.
 */
export function createTestApp({
  metadata = generatedMetadata,
  env = {},
  openapi = {},
  ...options
}: TestAppSetup = {}): Promise<TestApp> {
  return TestApp.create({
    metadata,
    plugins: plugins({
      observability: { logging: { level: 'silent' } },
      config: { loaders: [inline({ ...TEST_ENV, CATALOG_SEED: 'true', ...env })] },
      http: { port: 0 },
      openapi,
    }),
    ...options,
  })
}
