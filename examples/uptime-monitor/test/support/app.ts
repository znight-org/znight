import type { PGlite } from '@electric-sql/pglite'
import type { ProviderKey } from '@znight/core'
import type { JobOverride } from '@znight/schedule'
import type { TestClock } from '@znight/schedule/testing'
import type { Prober } from '../../src/monitors/prober.js'

import { inline } from '@znight/config'
import { SchedulerRegistry } from '@znight/schedule'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../../src/.znight/container.generated.js'
import { plugins } from '../../src/plugins.js'
import { FakeProber } from './fake-prober.js'
import { ADMIN_KEY, READER_KEY } from './fixtures.js'

/** The jobs declared with decorators (the monitors' jobs are added at runtime). */
export const STATIC_JOBS: readonly string[] = (
  (metadata.extensions?.schedule as { jobs: readonly { name: string }[] } | undefined)?.jobs ?? []
).map(job => job.name)

/** Overrides disabling every decorated job but `names`: a test watches only what it asserts. */
export function onlyJobs(...names: readonly string[]): Readonly<Record<string, JobOverride>> {
  return Object.fromEntries(STATIC_JOBS.filter(name => !names.includes(name)).map(name => [name, { enabled: false }]))
}

export interface TestAppSetup {
  /** The scheduler clock. Without one the scheduler is disabled (`trigger()` still runs jobs). */
  readonly clock?: TestClock
  /** Configuration values, over the test defaults (API keys, silent logs, a free port). */
  readonly env?: Readonly<Record<string, string>>
  /** Job overrides (`onlyJobs(...)`). */
  readonly jobs?: Readonly<Record<string, JobOverride>>
  /** The network. Default: a new {@link FakeProber} (every target answers 200). */
  readonly prober?: Prober
  /** A database shared with another application (or kept after this one closed). Default: a fresh in-memory one. */
  readonly database?: PGlite
  /** More replacements (values or `overrideFactory()` definitions), applied last. */
  readonly overrides?: readonly (readonly [ProviderKey, unknown])[]
}

/**
 * The application as `src/main.ts` wires it (the same `plugins()`: Hono adapter, global guard,
 * Postgres lock store, job overrides), with test configuration:
 *
 * - `inline()` replaces `.env` files and the environment: tests do not depend on the machine;
 * - logs are silenced, the server listens on a free port (`app.inject()` needs no socket);
 * - the prober is a fake: no network, every answer decided by the test;
 * - **time is virtual** when a clock is given: it only moves when the test advances it, and
 *   `clock.advance()` waits for the runs it starts, so assertions need no sleep. Without a clock the
 *   scheduler is disabled: jobs only run through `trigger()`.
 *
 * It resolves once the runs started at boot (`runOnStart`) settled.
 */
export async function createTestApp(setup: TestAppSetup = {}): Promise<TestApp> {
  // interfaces are designated by name: 'Prober' is the FetchProber of the application
  const overrides: (readonly [ProviderKey, unknown])[] = [['Prober', setup.prober ?? new FakeProber()]]
  // a value is never disposed by the container: the shared database outlives the application
  if (setup.database !== undefined) overrides.push(['PGlite', setup.database])
  overrides.push(...(setup.overrides ?? []))
  const app = await TestApp.create({
    metadata,
    plugins: plugins({
      config: [
        inline({
          API_KEY: ADMIN_KEY,
          READONLY_API_KEY: READER_KEY,
          LOG_LEVEL: 'silent',
          PORT: '0',
          HOST: '127.0.0.1',
          ...setup.env,
        }),
      ],
      scheduleEnabled: setup.clock !== undefined,
      ...(setup.clock === undefined ? {} : { clock: setup.clock }),
      ...(setup.jobs === undefined ? {} : { jobs: setup.jobs }),
    }),
    overrides,
  })
  await app.get(SchedulerRegistry).idle()
  return app
}
