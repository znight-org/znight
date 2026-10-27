/**
 * A Redis lock store for `@znight/schedule` (RFC 0004 §4.7): the recipe of the scheduling guide, tested
 * by `redis.test.ts` with `lockStoreScenarios` on a Redis container (`ZNIGHT_INTEGRATION=1`).
 *
 * One lease key and one occurrence key per job, in one hash slot (`{<key>}`: Redis Cluster safe). The
 * occurrence key keeps the last claimed occurrence: a claim must be later (occurrence fencing), and the
 * lease key must be free (`SET NX PX`). Redis expires the lease, so instance clocks do not matter.
 *
 * It takes a tiny `eval(script, keys, args)` port, so it works with any client:
 *
 * ```ts
 * // Bun
 * import { RedisClient } from 'bun'
 * const client = new RedisClient(process.env.REDIS_URL)
 * const store = new RedisLockStore({
 *   eval: (script, keys, args) => client.send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]),
 * })
 *
 * // ioredis
 * const redis = new Redis(process.env.REDIS_URL)
 * const store = new RedisLockStore({ eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) })
 * ```
 */
import type { LockClaim, LockLease, ScheduleLockStore } from '@znight/schedule'

/** What the store needs from a Redis client: `EVAL script numkeys key... arg...`. */
export interface RedisEval {
  eval(script: string, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown>
}

/** KEYS[1] = lease, KEYS[2] = last occurrence; ARGV = owner:occurrence, occurrence, ttl ms. */
const ACQUIRE = `local last = redis.call('GET', KEYS[2])
if last and tonumber(last) >= tonumber(ARGV[2]) then return 0 end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[3]) then
  redis.call('SET', KEYS[2], ARGV[2])
  return 1
end
return 0`

/** ARGV = owner:occurrence, ttl ms. */
const EXTEND = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`

/** ARGV = owner:occurrence. */
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

export class RedisLockStore implements ScheduleLockStore {
  readonly name = 'redis'

  constructor(private readonly redis: RedisEval) {}

  async acquire(key: string, claim: LockClaim): Promise<LockLease | undefined> {
    const keys = [`{${key}}:lease`, `{${key}}:occurrence`]
    const lease = `${claim.owner}:${claim.occurrence}`
    const acquired = await this.redis.eval(ACQUIRE, keys, [lease, claim.occurrence, claim.ttlMs])
    if (Number(acquired) !== 1) return undefined
    return {
      extend: async ttlMs => Number(await this.redis.eval(EXTEND, keys, [lease, ttlMs])) === 1,
      release: async () => {
        await this.redis.eval(RELEASE, keys, [lease])
      },
    }
  }
}
