/**
 * The Redis lock store (`src/schedule/redis-lock-store.ts`, the recipe of the scheduling guide)
 * against the conformance scenarios of `@znight/schedule/testing`, on a real Redis started by
 * testcontainers and through Bun's built-in `RedisClient`.
 *
 * Opt-in: `ZNIGHT_INTEGRATION=1 bun run test:integration` (Docker required).
 */
import type { StartedRedisContainer } from '@testcontainers/redis'

import { RedisContainer } from '@testcontainers/redis'
import { SchedulePlugin } from '@znight/schedule'
import { lockStoreScenarios } from '@znight/schedule/testing'
import { RedisClient } from 'bun'

import { RedisLockStore } from '../src/schedule/redis-lock-store.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const ENABLED = process.env.ZNIGHT_INTEGRATION === '1'

describe.skipIf(!ENABLED)('RedisLockStore (Redis container)', () => {
  let container: StartedRedisContainer | undefined
  let client: RedisClient | undefined
  let store: RedisLockStore

  beforeAll(async () => {
    container = await new RedisContainer('redis:7.4-alpine').start()
    const redis = new RedisClient(container.getConnectionUrl())
    client = redis
    // the store's port: `EVAL script numkeys key... arg...` (ioredis: redis.eval(script, keys.length, ...))
    store = new RedisLockStore({
      eval: (script, keys, args) => redis.send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]),
    })
  }, 180_000)

  afterAll(async () => {
    client?.close()
    await container?.stop()
  })

  for (const scenario of lockStoreScenarios) {
    it(scenario.name, async () => {
      await expect(scenario.run(() => store)).resolves.toBeUndefined() // a scenario throws on failure
    }, 20_000)
  }

  it('keeps the lease and the last claimed occurrence in one hash slot', async () => {
    const lease = await store.acquire('znight:schedule:digest.daily', {
      owner: 'host:1:a',
      occurrence: 1000,
      ttlMs: 30_000,
    })
    expect(await client?.send('GET', ['{znight:schedule:digest.daily}:lease'])).toBe('host:1:a:1000')
    await lease?.release()

    // released: the lease is gone, the occurrence stays claimed (fencing)
    expect(await client?.send('EXISTS', ['{znight:schedule:digest.daily}:lease'])).toBe(0)
    expect(await client?.send('GET', ['{znight:schedule:digest.daily}:occurrence'])).toBe('1000')
  })

  it('is accepted by SchedulePlugin', () => {
    expect(() => SchedulePlugin.configure({ lock: { store, ttl: '30s' } })).not.toThrow()
    expect(store.name).toBe('redis')
  })
})
