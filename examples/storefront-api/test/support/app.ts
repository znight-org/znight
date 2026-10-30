import type { ZnightMetadata } from '@znight/core'
import type { OpenApiPluginOptions } from '@znight/openapi'

import { ConfigPlugin, inline } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { ObservabilityPlugin } from '@znight/observability'
import { OpenApiPlugin } from '@znight/openapi'
import { TestApp, type TestAppOptions } from '@znight/testing'

import { __ZNIGHT_METADATA__ } from '../../src/.znight/container.generated.js'
import { ServerConfig } from '../../src/config/server.config.js'
import { httpOptions, openApiOptions } from '../../src/http.js'
import { TEST_ENV } from './fixtures.js'

export interface TestAppSetup extends Omit<TestAppOptions, 'metadata' | 'plugins'> {
  /** The application metadata. Default: the generated one. */
  readonly metadata?: ZnightMetadata
  /** Configuration values, over the test defaults (credentials of `fixtures.ts`). */
  readonly env?: Readonly<Record<string, string>>
  /** Merged over the OpenApiPlugin options of `main.ts`. */
  readonly openapi?: Partial<OpenApiPluginOptions>
}

/**
 * The application as `src/main.ts` wires it, from the same option functions (`src/http.ts`): Hono
 * adapter, global `AuthGuard`, `DomainErrorMapper`, security headers, `OpenApiPlugin` with the
 * converters of `src/openapi.converters.ts`. Only the environment differs:
 *
 * - `inline()` replaces `.env` files and the environment: tests do not depend on the machine;
 * - logs are silenced (and metrics off, as in `main.ts`);
 * - `port: 0`: `app.inject()` sends requests in memory, the server listens on a free port.
 *
 * Every application has its own in-memory repositories (the catalogue is seeded with
 * `CATALOG_SEED=true`), so tests that change the stock create their own.
 */
export function createTestApp({
  metadata = __ZNIGHT_METADATA__,
  env = {},
  openapi = {},
  ...options
}: TestAppSetup = {}): Promise<TestApp> {
  return TestApp.create({
    metadata,
    plugins: [
      ObservabilityPlugin.configure({ logging: { level: 'silent' }, metrics: false }),
      ConfigPlugin.configure({ loaders: [inline({ ...TEST_ENV, CATALOG_SEED: 'true', ...env })] }),
      HttpPlugin.configure(container => ({ ...httpOptions(container.get(ServerConfig)), port: 0 })),
      OpenApiPlugin.configure(container => ({ ...openApiOptions(container.get(ServerConfig)), ...openapi })),
    ],
    ...options,
  })
}
