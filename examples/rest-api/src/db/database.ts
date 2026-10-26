import type { PgliteDatabase } from 'drizzle-orm/pglite'
import type * as schema from './schema.js'

/**
 * The Drizzle database of the application: the type repositories inject, provided by
 * `DatabaseFactory.database()`.
 *
 * Injection is resolved by type at build time, so the injected type needs a stable name: an
 * interface gives one to Drizzle's generic `PgliteDatabase<typeof schema>` (a type alias would be
 * expanded to it, and `typeof` types cannot be compared by the compiler).
 */
export interface Database extends PgliteDatabase<typeof schema> {}
