import { Config } from '@znight/config'

/**
 * Database settings. With the `database` prefix, properties are read from `DATABASE_<PROPERTY>`:
 * `DATABASE_DATA_DIR`, `DATABASE_MIGRATIONS_FOLDER`, `DATABASE_SEED`.
 */
@Config('database')
export class DatabaseConfig {
  /**
   * Where PGlite (PostgreSQL compiled to WebAssembly) keeps its data: `memory://` for an in-memory
   * database (lost on exit), or a directory persisted on disk (`./data/bookshelf`).
   */
  dataDir = 'memory://'

  /** Folder of the SQL migrations applied at startup, relative to the working directory. */
  migrationsFolder = 'drizzle'

  /** Insert a few sample books when the database is empty (enabled in `.env.development`). */
  seed = false
}
