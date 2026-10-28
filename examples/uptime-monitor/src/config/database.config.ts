import { Config } from '@znight/config'

/** Database settings: `DATABASE_DATA_DIR`. */
@Config('database')
export class DatabaseConfig {
  /**
   * Where PGlite (PostgreSQL compiled to WebAssembly) keeps its data: `memory://` for an in-memory
   * database (lost on exit), or a directory persisted on disk (`./data/uptime`).
   */
  dataDir = 'memory://'
}
