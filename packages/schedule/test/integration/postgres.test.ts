/**
 * The Postgres recipe (`postgres-lock-store.ts`, referenced by the README) against a Postgres
 * container through Bun's `SQL` client (RFC 0004 §12.2). Runs with `ZNIGHT_INTEGRATION=1` (Docker
 * required).
 */
import type { StartedTestContainer } from 'testcontainers'

import { SQL } from 'bun'
import { GenericContainer, Wait } from 'testcontainers'

import { SchedulePlugin } from '../../src/index.ts'
import { lockStoreScenarios } from '../../src/testing/index.ts'
import { POSTGRES_LOCK_TABLE, PostgresLockStore } from './postgres-lock-store.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const integration = process.env['ZNIGHT_INTEGRATION'] === '1'

describe.skipIf(!integration)('PostgresLockStore (testcontainers)', () => {
  let container: StartedTestContainer
  let sql: SQL
  let store: PostgresLockStore

  beforeAll(async () => {
    container = await new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'znight-test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()
    sql = new SQL(`postgres://postgres:znight-test@${container.getHost()}:${container.getMappedPort(5432)}/postgres`)
    await sql.unsafe(POSTGRES_LOCK_TABLE)
    store = new PostgresLockStore({ query: (text, params) => sql.unsafe(text, [...params]) })
  }, 180_000)

  afterAll(async () => {
    await sql?.close()
    await container?.stop()
  })

  for (const scenario of lockStoreScenarios) {
    it(scenario.name, () => scenario.run(() => store), 20_000)
  }

  it('is accepted by SchedulePlugin', () => {
    expect(() => SchedulePlugin.configure({ lock: { store, ttl: '10s' } })).not.toThrow()
    expect(store.name).toBe('postgres')
  })
})
