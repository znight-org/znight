import type { Logger } from '@znight/observability'
import type { DatabaseConfig } from '../config/database.config.js'
import type { Database } from './database.js'

import { mkdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { Factory, Provides } from '@znight/core'

import { pgliteDatabase } from './database.js'
import { migrate } from './migrations.js'

/**
 * The data layer. A database client is not a class the compiler can construct, so a `@Factory`
 * provides it: each `@Provides` method is a provider of its **return type**, its parameters are
 * injected like constructor parameters.
 *
 * - `client()` is async: the container awaits it at boot. `dispose: 'close'` closes it on shutdown,
 *   after every provider using it stopped (the scheduler has drained its runs by then).
 * - `database()` applies the migrations (the lock table included) before anything can query.
 *
 * Tests share one PGlite between two applications by overriding `PGlite` with a value (values are
 * never disposed by the container): see `test/single-runner.test.ts`.
 */
@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'close' })
  async client(config: DatabaseConfig, logger: Logger): Promise<PGlite> {
    // a directory (not `memory://`, `idb://`...): PGlite creates the last segment only
    if (!config.dataDir.includes('://')) await mkdir(config.dataDir, { recursive: true })
    const client = await PGlite.create(config.dataDir)
    logger.info('Database opened', { dataDir: config.dataDir })
    return client
  }

  @Provides()
  async database(client: PGlite, logger: Logger): Promise<Database> {
    const applied = await migrate(client)
    if (applied.length > 0) logger.info('Database migrated', { migrations: applied })
    return pgliteDatabase(client)
  }
}
