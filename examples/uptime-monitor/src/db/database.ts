import type { PGlite } from '@electric-sql/pglite'

/** A row of a query result, keyed by column name. */
export type Row = Record<string, unknown>

/**
 * The database as the application sees it: parameterized SQL returning rows. Repositories and the
 * Postgres lock store (`schedule/postgres-lock-store.ts`) inject this interface and nothing else.
 *
 * PGlite provides it here (`database.factory.ts`), so the example runs without a server. On a real
 * PostgreSQL server, `pg` or Bun's `SQL` provide it with the same SQL:
 *
 * ```ts
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * const database: Database = { query: async (sql, params = []) => (await pool.query(sql, [...params])).rows }
 * ```
 */
export interface Database {
  query<R extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<R[]>
}

/** The {@link Database} of a PGlite client. */
export function pgliteDatabase(client: PGlite): Database {
  return {
    query: async <R extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
      (await client.query<R>(sql, [...params])).rows,
  }
}

/** Whether `error` is a PostgreSQL error with this SQLSTATE (`23503`: foreign key violation...). */
export function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
