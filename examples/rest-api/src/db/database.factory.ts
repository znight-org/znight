import type { Logger } from '@znight/observability'
import type { DatabaseConfig } from '../config/database.config.js'
import type { Database } from './database.js'

import { PGlite } from '@electric-sql/pglite'
import { Factory, Provides } from '@znight/core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import * as schema from './schema.js'
import { seedBooks } from './seed.js'

/**
 * The data layer: third-party objects (a database client, an ORM) are not classes the compiler can
 * construct, so a `@Factory` provides them. Each `@Provides` method is a provider of its **return
 * type**; its parameters are injected like constructor parameters.
 *
 * - `client()` is **async** (`Promise<PGlite>`): the container awaits it while booting, and
 *   independent async singletons start concurrently. `dispose: 'close'` makes the container call
 *   `client.close()` on shutdown — after every provider that depends on it was stopped.
 * - `database()` depends on the client, so it runs once the client is open: it applies the
 *   migrations before anything can query the database.
 *
 * Swap PGlite for a real server with `drizzle-orm/node-postgres` (or `bun:sql`) and a `Pool`:
 * only this file changes, repositories keep injecting `Database`.
 */
@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'close' })
  async client(config: DatabaseConfig, logger: Logger): Promise<PGlite> {
    const client = await PGlite.create(config.dataDir)
    logger.info('Database opened', { dataDir: config.dataDir })
    return client
  }

  @Provides()
  async database(client: PGlite, config: DatabaseConfig, logger: Logger): Promise<Database> {
    const db = drizzle(client, { schema })
    // Applies the pending migrations of the folder (drizzle-kit layout) and records them in the
    // drizzle.__drizzle_migrations table: restarting on an existing database applies nothing.
    await migrate(db, { migrationsFolder: config.migrationsFolder })
    logger.info('Database migrated', { migrationsFolder: config.migrationsFolder })
    if (config.seed) {
      const inserted = await seedBooks(db)
      if (inserted > 0) logger.info('Database seeded', { books: inserted })
    }
    return db
  }
}
