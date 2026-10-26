import type { PGlite } from '@electric-sql/pglite'
import type { Logger } from '@znight/observability'
import type { Database } from '../../src/db/database.js'

import { createMock } from '@znight/testing'

import { DatabaseConfig } from '../../src/config/database.config.js'
import { DatabaseFactory } from '../../src/db/database.factory.js'
import { MIGRATIONS_FOLDER } from './fixtures.js'

/** A migrated in-memory database and the means to close it. */
export interface TestDatabase {
  readonly db: Database
  readonly client: PGlite
  close(): Promise<void>
}

/**
 * A fresh in-memory PostgreSQL (PGlite), migrated with the application's own factory: repository
 * tests run real SQL in-process, no server and no Docker. Providers are plain classes, so tests can
 * also build them by hand when the container brings nothing.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const config = Object.assign(new DatabaseConfig(), { migrationsFolder: MIGRATIONS_FOLDER })
  const logger = createMock<Logger>()
  const factory = new DatabaseFactory()
  const client = await factory.client(config, logger)
  const db = await factory.database(client, config, logger)
  return { db, client, close: () => client.close() }
}
