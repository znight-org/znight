/**
 * The Redis recipe (`redis-lock-store.ts`, imported by the guide) against a Redis container through
 * Bun's `RedisClient` (RFC 0004 §12.2). Runs with `ZNIGHT_INTEGRATION=1` (Docker required).
 */
import type { StartedRedisContainer } from '@testcontainers/redis'

import { RedisContainer } from '@testcontainers/redis'
import { RedisClient } from 'bun'

import { memoryLockStore, SchedulePlugin } from '../../src/index.ts'
import { lockStoreScenarios } from '../../src/testing/index.ts'
import { RedisLockStore } from './redis-lock-store.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const integration = process.env['ZNIGHT_INTEGRATION'] === '1'

describe.skipIf(!integration)('RedisLockStore (testcontainers)', () => {
  let container: StartedRedisContainer
  let client: RedisClient
  let store: RedisLockStore

  beforeAll(async () => {
    container = await new RedisContainer('redis:7.4-alpine').start()
    client = new RedisClient(container.getConnectionUrl())
    store = new RedisLockStore({
      eval: (script, keys, args) => client.send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]),
    })
  }, 180_000)

  afterAll(async () => {
    client?.close()
    await container?.stop()
  })

  for (const scenario of lockStoreScenarios) {
    it(scenario.name, () => scenario.run(() => store), 20_000)
  }

  it('is accepted by SchedulePlugin', () => {
    expect(() => SchedulePlugin.configure({ lock: { store, ttl: '10s' } })).not.toThrow()
    expect(store.name).toBe('redis')
    expect(memoryLockStore().name).toBe('memory')
  })
})
