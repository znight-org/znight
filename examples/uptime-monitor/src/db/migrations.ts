import type { PGlite } from '@electric-sql/pglite'

import { POSTGRES_LOCK_TABLE } from '../schedule/postgres-lock-store.js'

/** A schema change, applied once, in order, in a transaction. */
export interface Migration {
  readonly id: string
  readonly sql: string
}

/**
 * The schema of the application. Plain PostgreSQL: the same statements run on PGlite and on a
 * PostgreSQL server. Append new migrations; never edit an applied one.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_monitors',
    sql: `
      CREATE TABLE monitors (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL,
        url text NOT NULL,
        expected_status integer NOT NULL,
        -- exactly one schedule: an interval (ms) or a cron expression with its time zone
        every_ms integer,
        cron text,
        time_zone text,
        timeout_ms integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((every_ms IS NULL) <> (cron IS NULL))
      );

      CREATE TABLE probe_results (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        monitor_id integer NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
        -- the occurrence the probe stands for (ctx.scheduledAt): one result per occurrence
        scheduled_at timestamptz NOT NULL,
        checked_at timestamptz NOT NULL,
        up boolean NOT NULL,
        status integer,
        latency_ms integer NOT NULL,
        error text,
        UNIQUE (monitor_id, scheduled_at)
      );
      CREATE INDEX probe_results_checked_at_idx ON probe_results (checked_at);

      -- e-mails waiting to be relayed (OutboxMailer): written in the database, sent by a relay
      CREATE TABLE outbox (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        -- idempotency key: the same e-mail is queued once (digest.daily:<occurrence>)
        key text NOT NULL UNIQUE,
        recipients text[] NOT NULL,
        subject text NOT NULL,
        body text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  // the leases of @znight/schedule (one row per locked job): the recipe's own DDL
  { id: '0002_schedule_locks', sql: POSTGRES_LOCK_TABLE },
]

/**
 * Applies the pending migrations and records them in `schema_migrations`: restarting on an existing
 * database applies nothing. Returns the ids of the applied migrations.
 */
export async function migrate(client: PGlite, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  await client.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations')
  const done = new Set(rows.map(row => row.id))
  const applied: string[] = []
  for (const migration of migrations) {
    if (done.has(migration.id)) continue
    await client.transaction(async tx => {
      await tx.exec(migration.sql)
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id])
    })
    applied.push(migration.id)
  }
  return applied
}
