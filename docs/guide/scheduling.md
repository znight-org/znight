---
description: Run scheduled work in production with Znight - choosing a trigger, cooperative jobs, dynamic jobs, time zones and daylight saving time, one runner across instances with Postgres and Redis lock stores, graceful shutdown, testing on a virtual clock and observability.
---

# Scheduling

[`@znight/schedule`](/packages/schedule) runs cron, interval and timeout jobs, checked by the
compiler and drained on shutdown. The package page is the reference; this guide is about running
scheduled work **in production**: which trigger to pick, how to write a job that behaves under
shutdowns, slow targets and replicas, how to deploy several instances with a lock store, how to deal
with time zones, and how to test and observe it all.

::: info The uptime-monitor example
Every recipe of this page is a source file of
[`examples/uptime-monitor`](https://github.com/znight-org/znight/tree/main/examples/uptime-monitor),
an uptime monitor running on Node.js 24 and Bun (Hono, PGlite): one dynamic job per monitor, a
weekday digest at 08:00 Paris time, a nightly purge, a status page with live results over
Server-Sent Events. Its tests are the tests of the recipes: the lock stores pass the conformance
scenarios, two instances share one database, the digest crosses a DST switch on a virtual clock, and
the production build runs on both runtimes.
:::

## Choose a trigger {#triggers}

| You need                                                       | Use                                             | In the example                             |
| -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| A wall-clock time: 08:00 in Paris on weekdays, 03:30 every day | `@Cron(expression, { timeZone })`               | `digest.daily`, `probes.purge`             |
| A period, whatever the time of day                             | `@Interval(every)`                              | `status-cache.refresh`                     |
| Once, shortly after the start                                  | `@Timeout(delay)` (or `runOnStart: true`)       | `status-cache.warm`                        |
| Schedules that come from data or users                         | `registry.addCron()`, `addInterval()`           | `monitor.<id>`                             |
| Retries with backoff, durable work, catch-up after downtime    | not a scheduler: publish a message from the job | [`@znight/messaging`](/packages/messaging) |

```ts [src/status/status.cache.ts (simplified)]
import { Interval, type JobContext, Timeout } from '@znight/schedule'

/** No @Injectable(): a class with jobs becomes a singleton provider, injectable like any other. */
export class StatusCache {
  #snapshot: StatusSnapshot | undefined

  constructor(private readonly results: ProbeResultRepository) {}

  /** Every minute (at hh:mm:00, on every instance), and once when the scheduler starts. */
  @Interval('1m', { name: 'status-cache.refresh', lock: false, runOnStart: true })
  async refresh(ctx: JobContext): Promise<void> {
    const rows = await this.results.statuses(new Date(ctx.scheduledAt.getTime() - DAY))
    this.#snapshot = toSnapshot(rows, ctx.scheduledAt)
  }

  /** Once, 2 s after the scheduler started: the first probes have run by then. */
  @Timeout('2s', { name: 'status-cache.warm', lock: false })
  warm(ctx: JobContext): Promise<void> {
    return this.refresh(ctx)
  }

  get snapshot(): StatusSnapshot | undefined {
    return this.#snapshot
  }
}
```

- **Arguments are static** (literals, `const` references): the compiler validates expressions,
  durations, zones, options, names and method signatures, with a caret under the faulty field
  ([`ZNIGHT040`](/reference/error-codes#znight040), [`ZNIGHT041`](/reference/error-codes#znight041)).
  Values that depend on the environment go through the plugin's `jobs` option, validated at boot
  ([per-deployment schedules](#per-deployment-schedules)).
- **Intervals are aligned on the Unix epoch.** A `'1m'` interval fires at hh:mm:00, a `'6h'` one at
  00:00, 06:00, 12:00 and 18:00 UTC, whenever the instance started: replicas agree on occurrences
  (locks need it), and a deploy every two hours never starves a six-hour job, which `setInterval`
  would restart at each boot. Use `@Cron` for a wall-clock time in a zone.
- **Name your jobs** (`name: 'digest.daily'`): the name is the key of the logs, the metrics, the
  lock and the admin endpoints, and it survives a refactoring of the class.

## Write cooperative jobs {#writing-jobs}

### Use the occurrence, not the clock {#occurrence}

`ctx.scheduledAt` is the occurrence a run stands for. Compute everything from it, never from
`new Date()`:

- a run that starts late (a stalled event loop, a suspended laptop, a long lease wait) still works
  on the period it stands for;
- writes keyed by the occurrence are idempotent: running the same occurrence twice (a manual
  trigger, a retry) changes nothing;
- with a lock store, occurrences increase strictly per job across the fleet: `ctx.scheduledAt` is a
  free **fencing token** for writes;
- tests choose the occurrence (`createJobContext({ scheduledAt })`) and get a deterministic result.

```ts [src/digest/digest.jobs.ts (excerpt)]
@Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
async sendDaily(ctx: JobContext): Promise<void> {
  const until = ctx.scheduledAt // the occurrence, never `new Date()`
  // since the previous occurrence of the job's own schedule: Monday's digest covers the weekend
  const job = this.registry.get(ctx.job)
  const since = (job === undefined ? undefined : previousRun(job, until)) ?? new Date(until.getTime() - DAY)

  const report = await this.reports.build({ since, until, signal: ctx.signal })
  // one e-mail per occurrence (the outbox ignores a key it already has)
  await this.mailer.send(digestMail(report, this.config.recipients, `${ctx.job}:${until.toISOString()}`))
}
```

### Pass the signal {#signal}

`ctx.signal` is aborted with a `JobAbortedError` ([`ZNIGHT044`](/reference/error-codes#znight044))
whose `reason` is `timeout` (`maxDuration` exceeded), `lock-lost` (the lease could not be renewed),
`removed` (`registry.remove(name, { abort: true })`) or `shutdown`. JavaScript cannot stop a
promise: a job **cooperates**, by passing the signal to `fetch` and database drivers, and by checking
it between units of work.

```ts [src/maintenance/purge.jobs.ts (excerpt)]
import type { JobContext } from '@znight/schedule'

import { Cron, JobAbortedError } from '@znight/schedule'

export class PurgeJobs {
  constructor(
    private readonly results: ProbeResultRepository,
    private readonly config: ProbesConfig,
    private readonly logger: Logger,
  ) {}

  /** 6 fields: 03:30:00, in the plugin's zone. Batches keep the table available. */
  @Cron('0 30 3 * * *', { name: 'probes.purge', maxDuration: '10m' })
  async purge(ctx: JobContext): Promise<void> {
    const before = new Date(ctx.scheduledAt.getTime() - this.config.retentionDays * DAY)
    let deleted = 0
    for (;;) {
      // shutdown: stop at a batch boundary, the next night resumes
      if (isShutdown(ctx.signal)) {
        this.logger.info('Probe results purge interrupted by the shutdown', { deleted })
        return
      }
      ctx.signal.throwIfAborted() // timeout, lost lease: fail the run (logs, metrics)
      const batch = await this.results.purgeBatch(before, this.config.purgeBatchSize)
      deleted += batch
      if (batch < this.config.purgeBatchSize) break
    }
  }
}

function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof JobAbortedError && signal.reason.reason === 'shutdown'
}
```

A probe hands the signal to `fetch`, so the monitor's timeout (its `maxDuration`) bounds the whole
exchange, and a probe interrupted by a shutdown or a deletion records nothing (the target is not to
blame):

```ts [src/monitors/probe.service.ts (excerpt)]
try {
  ;({ status } = await this.prober.probe({ url: monitor.url, signal: ctx.signal }))
} catch (cause) {
  const aborted = abortReason(ctx.signal) // JobAbortedError.reason
  if (aborted !== undefined && aborted !== 'timeout') return // shutdown, removed, lock-lost
  error = aborted === 'timeout' ? `No answer within ${monitor.timeoutMs} ms` : describeError(cause)
}
```

### Bound runs and overlaps {#overlap}

- **`maxDuration`** aborts the signal after a duration. It does not free the run's slot: until the
  run settles, the job counts as running.
- **`overlap`** decides what happens when an occurrence fires while the previous run is still going
  in this process: `'skip'` (default: dropped, logged at `warn` with how long the run has been
  going), `'queue'` (one pending run, started when the current one settles) or `'allow'` (runs
  concurrently, never locked).
- A run that ignores its signal keeps its slot: the following occurrences are skipped and logged,
  which keeps the problem visible instead of piling up runs.

## Dynamic jobs {#dynamic-jobs}

When schedules live in data (one probe per monitor, one report per customer), add them to the
injectable `SchedulerRegistry` at runtime. The registry is usable from providers' `onStart` /
`onReady`, requests and runs; providers' `onReady` runs before the plugins', so jobs added there are
armed together with the decorated ones.

```ts [src/monitors/monitor.scheduler.ts (simplified)]
import { Injectable, type OnReady } from '@znight/core'
import { Interval, type JobContext, type ScheduledJob, SchedulerRegistry } from '@znight/schedule'

@Injectable()
export class MonitorScheduler implements OnReady {
  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly monitors: MonitorRepository,
    private readonly probes: ProbeService,
  ) {}

  async onReady(): Promise<void> {
    await this.sync()
  }

  /** Dynamic jobs are neither persisted nor shared: every instance reconciles with the database. */
  @Interval('30s', { name: 'monitors.sync', lock: false })
  async sync(): Promise<void> {
    const monitors = await this.monitors.all()
    const wanted = new Set(monitors.map(monitor => monitorJobName(monitor.id)))
    for (const job of this.registry.jobs()) {
      if (monitorIdOf(job.name) !== undefined && !wanted.has(job.name)) this.registry.remove(job.name, { abort: true })
    }
    for (const monitor of monitors) if (!this.registry.has(monitorJobName(monitor.id))) this.#schedule(monitor)
  }

  #schedule(monitor: Monitor): ScheduledJob {
    const name = monitorJobName(monitor.id) // 'monitor.42': logs, metrics, lock key
    const probe = (ctx: JobContext): Promise<void> => this.probes.run(monitor, ctx)
    const options = { maxDuration: monitor.timeoutMs } // ctx.signal aborts after the monitor's timeout
    return 'every' in monitor.schedule
      ? this.registry.addInterval(name, monitor.schedule.every, probe, options)
      : this.registry.addCron(name, monitor.schedule.cron, probe, { ...options, timeZone: monitor.schedule.timeZone })
  }
}
```

(The example also adds and removes jobs at once from the API, serialized with `sync()`.)

- **Validate user schedules with the engine itself.** The compiler cannot see a schedule typed by a
  user, but the engine is public: `parseCron(expression, { timeZone })` and `parseDuration(value)`
  apply the rules of the compiler and the registry, and throw an `InvalidScheduleError` with the
  same message as the build diagnostic. Call them in the validation schema, so that a schedule
  accepted by the API is one the registry accepts:

  ```ts [src/monitors/monitor.schemas.ts (simplified)]
  import { parseCron, parseDuration } from '@znight/schedule'
  import { z } from 'zod'

  const Duration = z.union([z.number(), z.string()]).transform((value, ctx) => {
    try {
      return parseDuration(value) // '30s' → 30_000
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: messageOf(error) })
      return z.NEVER
    }
  })

  export const CreateMonitor = z
    .object({ name: z.string(), url: z.url(), every: Duration.optional(), cron: z.string().optional(), timeZone: z.string().optional() })
    .superRefine((input, ctx) => {
      if (input.cron === undefined) return
      try {
        parseCron(input.cron, { timeZone: input.timeZone ?? 'UTC' })
      } catch (error) {
        // "Invalid cron expression '0 25 * * *': hour 25 is out of range (0-23)"
        ctx.addIssue({ code: 'custom', path: ['cron'], message: messageOf(error) })
      }
    })
  ```

- **Names** match `^[\w$][\w.:$-]{0,127}$` and are unique across static and dynamic jobs (a taken
  name throws `ZNIGHT041`). A prefix (`monitor.`) keeps the jobs of one kind easy to find.
- **Dynamic jobs, pauses and reschedules are per process.** Nothing is persisted: rebuild dynamic
  jobs from the source of truth at `onReady`, and reconcile periodically when several instances can
  change it.

## Time zones and daylight saving time {#time-zones}

Cron expressions are evaluated on the wall clock of a zone: the job's `timeZone`, else the plugin's
`timeZone`, else **UTC**. A laptop in Paris and a container in UTC run the same job at the same
instant. Intervals and timeouts are durations: zones do not apply to them.

```ts
// 08:00 in Paris: 07:00Z in winter (CET), 06:00Z in summer (CEST)
@Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris' })

// no zone: the plugin's (SchedulePlugin.configure({ timeZone: 'Europe/Paris' })), UTC by default
@Cron('0 30 3 * * *', { name: 'probes.purge' })
```

Days with a daylight saving switch follow the rules of Vixie cron:

| Situation                                  | Rule                                                                                                                          | `Europe/Paris`                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The local time does not exist (spring gap) | It fires once, at the first instant after the gap                                                                             | `30 2 * * *` on 2027-03-28 fires at 03:00 CEST       |
| The local time exists twice (autumn fold)  | It fires at its **first** occurrence only, unless the hour field matches every hour (`*`): then the repeated hour fires again | `30 2 * * *` on 2026-10-25 fires once, at 02:30 CEST |
| Sub-hourly jobs (`*/30 * * * *`)           | Keep running every N minutes of real time                                                                                     | 00:00Z, 00:30Z, 01:00Z, 01:30Z on 2026-10-25         |

In practice:

- A daily job never runs twice nor gets skipped on a DST day. To stay clear of the switches
  entirely, schedule daily jobs outside 01:00–03:00 local time, or in UTC.
- `timeZone` accepts an IANA name, `'UTC'`, a fixed offset (`'+05:30'`) or `'local'` (the zone of
  the process, read once at boot: avoid it on servers).
- Zones are validated at build time with the compiler's `Intl` and again at boot with the
  runtime's: an unknown zone fails with a suggestion (`did you mean 'Europe/Paris'?`). They are kept
  as written, never canonicalised (Node.js and Bun disagree on aliases such as `US/Eastern`).
- To see what a schedule will do, ask the engine: `parseCron('0 8 * * MON-FRI', { timeZone:
  'Europe/Paris' }).nextRuns(5, new Date('2027-03-26T00:00:00Z'))`, or `GET /admin/jobs/:name` in the
  example ([admin endpoints](#admin-endpoints)).

### Per-deployment schedules {#per-deployment-schedules}

A staging digest every hour, a purge at another time in another region: override the schedule with
the plugin's `jobs` option, from configuration. The kind of a job never changes (`cron` and
`timeZone` for cron jobs, `every` for intervals, `delay` for timeouts), and overrides are validated
at boot with the rules the compiler applies to decorators:

```ts [src/plugins.ts (excerpt)]
SchedulePlugin.configure(container => {
  const schedule = container.get(ScheduleConfig)
  return {
    timeZone: schedule.timeZone, // SCHEDULE_TIME_ZONE
    // DIGEST_CRON replaces the decorator's expression (the zone stays Europe/Paris)
    jobs: schedule.digestCron === undefined ? {} : { 'digest.daily': { cron: schedule.digestCron } },
  }
})
```

`DIGEST_CRON='0 25 * * *'` stops the boot with `ZNIGHT040: ... hour 25 is out of range (0-23)`; an
override naming no job is [`ZNIGHT042`](/reference/error-codes#znight042), with a suggestion.

## Run several instances {#instances}

### Without a lock store {#without-lock}

Every instance runs every job. That is right for a single instance, and for work that is per
instance by nature: refreshing an in-memory cache, reconciling dynamic jobs. With replicas, the
digest would be mailed once per replica.

### With a lock store {#with-lock}

Give the plugin a store shared by the instances, and every job becomes **locked by default**: each
occurrence runs on exactly one instance. Opt out per job with `lock: false`.

```ts [src/plugins.ts (excerpt)]
SchedulePlugin.configure((container): SchedulePluginOptions => {
  const schedule = container.get(ScheduleConfig)
  return {
    enabled: schedule.enabled, // SCHEDULE_ENABLED=false on replicas that only serve HTTP
    lock: {
      store: new PostgresLockStore(container.get<Database>('Database')),
      ttl: parseDuration(schedule.lockTtl), // '30s' by default
    },
    drainTimeoutMs: schedule.drainTimeoutMs,
  }
})
```

A store implements one method, `acquire(key, { owner, occurrence, ttlMs })`, which claims an
occurrence of a job and returns a lease to extend and release. It accepts a claim only when **no
lease is live** for the job **and** the occurrence is **later than every occurrence claimed before**.
That second condition, occurrence fencing, is what makes it correct:

- Two instances whose clocks differ by 300 ms both fire "08:00". The first claims occurrence 08:00,
  sends the digest in 50 ms and releases. The second arrives late, finds 08:00 already claimed and
  is refused (`not-acquired`). A plain mutex would let it send the digest a second time; ShedLock
  works around this with a guessed `lockAtLeastFor`, which bounds both the clock skew it tolerates
  and the frequency of the job. Fencing needs neither.
- The lease is renewed every `ttl / 3` while the run lasts. When it cannot be renewed (the store is
  unreachable, or the lease expired and another instance took it), the run's signal is aborted
  with `lock-lost`.
- **No store answer, no run**: a store failure fails the run closed (`failed`), it never runs
  unlocked.
- An instance that crashes mid-run blocks its job for one `ttl` at most. At shutdown, a run that
  does not return within `drainTimeoutMs` is abandoned: its lease is **not** released and simply
  expires, so no other instance starts the job while the abandoned run may still be writing.

What locks do not give: an occurrence missed because its instance crashed is not run again (at most
once, no catch-up), and `@Timeout` and `runOnStart` runs happen once per process, not once per
fleet. Work that must happen exactly once belongs in a durable queue.

### Deployment topologies {#topologies}

| Topology                                          | Settings                                                                                  | When                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| One instance                                      | No store                                                                                  | Small services, workers with a single replica                     |
| Every replica schedules                           | A store; per-instance jobs declare `lock: false`                                          | The default: no extra deployment, jobs spread over the replicas   |
| Web replicas plus scheduler replicas (same image) | `SCHEDULE_ENABLED=false` on the web replicas; a store, and two scheduler replicas or more | Heavy jobs that must not compete with requests for the event loop |

Whatever the topology:

- **Rolling deploys** overlap old and new versions: with a store, a job never runs twice during the
  rollout, and epoch-aligned intervals keep their rhythm across restarts.
- **`SCHEDULE_ENABLED=false`** keeps the registry: jobs are still listed and run on demand
  (`trigger()`), and dynamic jobs can still be added; nothing is armed and no timer keeps the process
  alive. Keep the store on these replicas too: a manual run goes through the lock.
- **Per-instance state** stays per instance: in-memory caches need `lock: false` jobs, dynamic jobs
  need reconciling ([dynamic jobs](#dynamic-jobs)), and a pause from an admin endpoint applies to the
  instance that served the request. For a fleet-wide switch, use a `jobs` override (`enabled: false`)
  and redeploy, or a `schedule:run` hook wrapper that reads a feature flag (a wrapper that does not
  call `next()` skips the run).
- **TTL.** Shorter means a faster takeover after a crash and more renewals: 30 s suits most jobs;
  lower it for jobs every few seconds, raise it when the store is far away.

### Postgres lock store {#postgres-lock-store}

One row per job, one atomic upsert per claim; expiry uses the database clock, so the instances'
clocks do not matter. The store takes a `query(sql, params)` port that returns rows, so it works with
any client: the application's `Database` in the example (PGlite), `pg`, Bun's `SQL`. Copy the file
into your application, and create the table in a migration:

```ts [src/db/migrations.ts (excerpt)]
import { POSTGRES_LOCK_TABLE } from '../schedule/postgres-lock-store.js'

export const MIGRATIONS: readonly Migration[] = [
  // ...the application's tables
  { id: '0002_schedule_locks', sql: POSTGRES_LOCK_TABLE },
]
```

```ts [src/schedule/postgres-lock-store.ts]
import type { LockClaim, LockLease, ScheduleLockStore } from '@znight/schedule'

import { randomUUID } from 'node:crypto'

/** What the store needs from a Postgres client: a parameterized query returning its rows. */
export interface PostgresQuery {
  query(sql: string, params: readonly unknown[]): Promise<readonly unknown[]>
}

/** The table of the leases: one row per job (create it in a migration). */
export const POSTGRES_LOCK_TABLE = `CREATE TABLE IF NOT EXISTS znight_schedule_locks (
  key text PRIMARY KEY,
  occurrence bigint NOT NULL,
  owner text NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL
)`

/** $1 key, $2 occurrence, $3 owner, $4 token, $5 ttl ms: a row back when the claim is granted. */
const ACQUIRE = `INSERT INTO znight_schedule_locks AS lock (key, occurrence, owner, token, expires_at)
VALUES ($1, $2, $3, $4, clock_timestamp() + $5::double precision * interval '1 millisecond')
ON CONFLICT (key) DO UPDATE
  SET occurrence = excluded.occurrence, owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at
  WHERE lock.expires_at <= clock_timestamp() AND lock.occurrence < excluded.occurrence
RETURNING token`

/** $1 key, $2 token, $3 ttl ms: a row back while the lease is live. */
const EXTEND = `UPDATE znight_schedule_locks
SET expires_at = clock_timestamp() + $3::double precision * interval '1 millisecond'
WHERE key = $1 AND token = $2 AND expires_at > clock_timestamp()
RETURNING token`

/** $1 key, $2 token: ends a live lease (the occurrence stays claimed). */
const RELEASE = `UPDATE znight_schedule_locks SET expires_at = clock_timestamp()
WHERE key = $1 AND token = $2 AND expires_at > clock_timestamp()`

export class PostgresLockStore implements ScheduleLockStore {
  readonly name = 'postgres'

  constructor(private readonly db: PostgresQuery) {}

  async acquire(key: string, claim: LockClaim): Promise<LockLease | undefined> {
    const token = randomUUID()
    const rows = await this.db.query(ACQUIRE, [key, claim.occurrence, claim.owner, token, claim.ttlMs])
    if (rows.length !== 1) return undefined
    return {
      extend: async ttlMs => (await this.db.query(EXTEND, [key, token, ttlMs])).length === 1,
      release: async () => {
        await this.db.query(RELEASE, [key, token])
      },
    }
  }
}
```

Other clients only need the port:

```ts
// Bun
import { SQL } from 'bun'
const sql = new SQL(process.env.DATABASE_URL)
const store = new PostgresLockStore({ query: (text, params) => sql.unsafe(text, [...params]) })

// node-postgres
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const store = new PostgresLockStore({ query: async (text, params) => (await pool.query(text, [...params])).rows })
```

- `clock_timestamp()` (not `now()`, frozen for a transaction) keeps the expiry right inside long
  transactions and connection poolers.
- A random token identifies each lease: a stale `extend()` or `release()` from an instance whose
  lease expired never touches the lease that took over.
- A release keeps the row (and its occurrence): it only ends the lease, so the occurrence stays
  claimed.

### Redis lock store {#redis-lock-store}

For fleets that share a Redis rather than a database: one lease key (`SET NX PX`, expired by Redis)
and one key holding the last claimed occurrence per job, both updated by one Lua script. The keys
share a hash tag (`{<key>}`), so they land in one slot: the store works on Redis Cluster.

```ts [src/schedule/redis-lock-store.ts]
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
```

The `eval` port fits any client:

```ts
// Bun (built-in client, no dependency)
import { RedisClient } from 'bun'
const client = new RedisClient(process.env.REDIS_URL)
const store = new RedisLockStore({
  eval: (script, keys, args) => client.send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]),
})

// ioredis
const redis = new Redis(process.env.REDIS_URL)
const store = new RedisLockStore({ eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) })
```

Use a Redis with persistence (AOF) if a restart of Redis must not forget the claimed occurrences: a
Redis that lost them would accept a late instance's claim of an occurrence already run.

### Check a store {#lock-store-conformance}

`@znight/schedule/testing` exports the semantics every store must implement as runner-agnostic
scenarios: claim and refuse, occurrence fencing, expiry, extension, takeover, stale release, keys
independence, and ten concurrent claims with exactly one winner. Run them against your store, on
the real database:

```ts [test/postgres-lock-store.test.ts (excerpt)]
import { PGlite } from '@electric-sql/pglite'
import { lockStoreScenarios } from '@znight/schedule/testing'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

describe('PostgresLockStore', () => {
  let client: PGlite
  let store: PostgresLockStore

  beforeAll(async () => {
    client = await PGlite.create()
    await migrate(client) // the application's migrations create the lock table
    store = new PostgresLockStore(pgliteDatabase(client))
  })

  afterAll(() => client.close())

  for (const scenario of lockStoreScenarios) {
    it(scenario.name, async () => {
      await expect(scenario.run(() => store)).resolves.toBeUndefined() // a scenario throws on failure
    })
  }
})
```

The example runs the Redis store through the same scenarios on a Redis container
([`testcontainers`](https://node.testcontainers.org/), Bun's `RedisClient`), with
`ZNIGHT_INTEGRATION=1 bun run test:integration`.

## Graceful shutdown {#shutdown}

On `SIGTERM` (or `app.stop()`), the scheduler:

1. disarms its timer and drops the queued runs; `trigger()` and `add*()` now fail with
   [`ZNIGHT021`](/reference/error-codes#znight021);
2. aborts the signal of **every** running run with `shutdown`, at once, so that jobs checkpoint and
   return early;
3. waits until they settle, at most `drainTimeoutMs` (4 s by default);
4. abandons the runs still in flight, logged at `warn`. Their leases are not released: they expire.

List `SchedulePlugin` **before** `HttpPlugin`. Plugins stop in reverse order, so HTTP stops taking
requests first (manual runs from an admin endpoint included) and closes its event streams, then the
jobs drain, then providers stop and the database closes:

```ts [src/plugins.ts (excerpt)]
export function plugins(options: PluginsOptions = {}): Plugin[] {
  return [
    ObservabilityPlugin.configure(/* ... */), // first: its hooks wrap every request and run
    ConfigPlugin.configure(),
    SchedulePlugin.configure(/* ... */), // before HttpPlugin: drains after HTTP stopped
    HttpPlugin.configure(/* ... */),
  ]
}
```

Keep `sse.shutdownGraceMs` (1 s) < `drainTimeoutMs` (4 s) < `shutdown.hookTimeoutMs` (5 s) <
`shutdown.timeoutMs` < the grace period of your platform (see [Deployment](./deployment#graceful-shutdown-in-orchestrators)).
A process whose only work is the scheduler needs nothing else: while the scheduler runs, its timer
keeps the process alive, and `SIGTERM` ends it cleanly.

## Test scheduled code {#testing}

### Unit tests: a job is a method {#unit-tests}

`TestBed` builds the host with auto-mocked dependencies; `createJobContext()` gives the run of your
choice, with an `abort(reason)` helper. No scheduler, no clock, no database:

```ts [test/digest.jobs.test.ts (excerpt)]
import { SchedulerRegistry } from '@znight/schedule'
import { createJobContext } from '@znight/schedule/testing'
import { TestBed } from '@znight/testing'

test("reports on the period ending at the run's occurrence", async () => {
  const { instance, mocks } = await TestBed.create(DigestJobs, {
    metadata,
    config: { digest: { recipients: ['ops@example.com'] } },
  })
  mocks.get(SchedulerRegistry).get.mockReturnValue(digestJob()) // its schedule, for the previous occurrence
  mocks.get(ReportService).build.mockResolvedValue(aReport())
  const ctx = createJobContext({ job: 'digest.daily', scheduledAt: new Date('2027-03-29T06:00:00Z') })

  await instance.sendDaily(ctx)

  expect(mocks.get(ReportService).build).toHaveBeenCalledWith({
    since: new Date('2027-03-26T07:00:00Z'), // Friday 08:00 CET: Monday's digest covers the weekend
    until: new Date('2027-03-29T06:00:00Z'),
    signal: ctx.signal,
  })
  expect(mocks.get<Mailer>('Mailer').send).toHaveBeenCalledTimes(1)
})
```

### The schedule on a virtual clock {#test-clock}

To test **when** jobs run, boot the real application with a test clock. Time only moves when the
test advances it, and `advance()` / `advanceTo()` wait for the runs they start, real I/O included:
no sleep, no flaky timing.

```ts [test/digest.schedule.test.ts (excerpt)]
import { SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'

test('runs at 08:00 Paris time on weekdays, across the March 2027 DST switch', async () => {
  const clock = createTestClock('2027-03-26T06:00:00Z') // Friday 07:00 in Paris (CET)
  await using app = await createTestApp({ clock, jobs: onlyJobs('digest.daily') })

  await clock.advanceTo('2027-03-29T07:00:00Z') // Monday 09:00 in Paris (CEST)

  // Friday 08:00 CET (07:00Z) and Monday 08:00 CEST (06:00Z), none on the weekend
  expect((await app.get(OutboxMailer).queued(10)).map(mail => mail.key).toReversed()).toEqual([
    'digest.daily:2027-03-26T07:00:00.000Z',
    'digest.daily:2027-03-29T06:00:00.000Z',
  ])
  expect(app.get(SchedulerRegistry).get('digest.daily')?.nextRun?.toISOString()).toBe('2027-03-30T06:00:00.000Z')
})
```

`createTestApp()` ([`test/support/app.ts`](../../examples/uptime-monitor/test/support/app.ts)) boots
`TestApp` with the same `plugins()` as `main.ts`, the clock, a fake network and silent logs, and
waits for the runs started at boot (`await registry.idle()`). `onlyJobs(...)` turns the other
decorated jobs off with `jobs` overrides (`{ enabled: false }`), so a test over three days does not
run the per-minute ones thousands of times.

### HTTP and time together {#http-and-clock}

`TestApp.inject()` and the clock compose: create a monitor over HTTP, advance, read the result.

```ts [test/monitors.http.test.ts (excerpt)]
test("bounds a probe with the monitor's timeout", async () => {
  const prober = new FakeProber().answer(TARGET, 'hang') // never answers until its signal aborts
  const clock = createTestClock('2027-01-04T09:00:00Z', { settleTimeoutMs: 200 })
  await using app = await createTestApp({ clock, prober, jobs: onlyJobs() })
  await app.inject({
    method: 'POST',
    url: '/monitors',
    headers: admin,
    body: { name: 'Slow', url: TARGET, every: '1m', timeout: '5s' },
  })

  await clock.advance('1m') // the probe starts at 09:01:00 and hangs
  await clock.advance('5s') // maxDuration: ctx.signal aborts, and fetch with it

  expect(prober.requests[0]?.signal.reason).toMatchObject({ name: 'JobAbortedError', reason: 'timeout' })
})
```

A run that makes no progress (a probe hanging on purpose) is waited for `settleTimeoutMs` of real
time (1 000 ms by default) on each `advance()`: lower it in tests that keep runs pending. Event
streams fed by jobs are read with `app.injectSse()` while the clock moves.

### Several instances in one process {#instances-in-tests}

Two `TestApp`s sharing one database (the lock store) and one clock are a two-replica deployment:

```ts [test/single-runner.test.ts (excerpt)]
const database = await PGlite.create()
const clock = createTestClock('2027-01-04T09:00:00Z', { settleTimeoutMs: 200 })
const setup = {
  clock,
  prober,
  database,
  jobs: onlyJobs(),
  env: { SCHEDULE_LOCK_TTL: '2s', SCHEDULE_DRAIN_TIMEOUT_MS: '100' },
}
const first = await createTestApp(setup) // the database is a value: no application closes it
// ...a monitor created through `first`, scheduled by `second` from the database at its start
const second = await createTestApp(setup)

await clock.advance('2m')

expect(prober.requests).toHaveLength(4) // one probe per occurrence, not two
```

The example's test then stalls a probe (it ignores its signal), stops the instance holding it,
checks that the other one is refused the next occurrence (the abandoned lease is still live), waits
for the lease to expire on the database clock, and checks the takeover.

### Build-time checks {#build-checks}

`compile()` from `@znight/compiler` returns the diagnostics `znight build` would print.
[`build-check.test.ts`](../../examples/uptime-monitor/test/build-check.test.ts) compiles a copy of the
application with a broken expression, an unknown zone, a duplicated name and a private job method,
and checks each diagnostic and its location.

## Observe and operate {#observability}

### Logs, metrics and traces {#logs-metrics-traces}

Every occurrence goes through the `schedule:run` hook of `@znight/core`. With
[`@znight/observability`](/packages/observability) listed first among the plugins:

- **Logs**: one line per run, `job completed` (`info`), `job failed` (`error`, with the stack),
  `job skipped` (`warn`: the previous run is still going), `job not acquired` (`debug`: another
  instance holds the lock), with `job`, `runId`, `trigger`, `scheduledAt`, `durationMs`, `lateMs`
  and `aborted`. Every line logged inside a run carries `job` and `runId`.
- **Metrics** (with `prom-client`): `schedule_runs_total{job, outcome}`,
  `schedule_run_duration_seconds`, `schedule_run_lateness_seconds`, `schedule_active_runs` and
  `schedule_last_success_timestamp_seconds{job}`. The `job` label is capped (100 names, then
  `_OTHER`), since dynamic job names are unbounded.
- **Traces**: one `INTERNAL` span `schedule <job>` per executed run, the root of a new trace, or a
  child of the request for a manual run.

```txt
{"level":30,"msg":"job completed","job":"monitor.1","runId":"a9512f88-…","trigger":"schedule","scheduledAt":"2026-10-28T11:10:00.000Z","durationMs":245.1,"lateMs":41}
```

Alert on freshness, across the fleet (the maximum over the instances: with a lock store, any of
them may have run the job):

```yaml
- alert: DigestNotSent
  expr: time() - max(schedule_last_success_timestamp_seconds{job="digest.daily"}) > 26 * 3600
```

(For a weekday job, account for the weekend: compare with the expected occurrences, or alert only
on weekdays.)

### Health checks {#health}

A `/health` route can flag the jobs of an instance that keep failing. The example records the last
success of each job from the same hook, and reports the jobs whose **second occurrence** after their
last success has passed:

```ts [src/health/job-health.ts (simplified)]
import { type Application, type Hooks, Injectable, type OnStart, type OnStop } from '@znight/core'
import { SCHEDULE_PLUGIN_NAME, type SchedulePluginInstance, SchedulerRegistry } from '@znight/schedule'

@Injectable()
export class JobHealth implements OnStart, OnStop {
  readonly #lastSuccess = new Map<string, number>()
  #since = 0
  #unsubscribe: (() => void) | undefined

  constructor(
    private readonly app: Application,
    private readonly hooks: Hooks,
    private readonly registry: SchedulerRegistry,
  ) {}

  /** Providers start before the scheduler arms anything: no occurrence is missed. */
  onStart(): void {
    this.#since = this.#now()
    this.#unsubscribe = this.hooks.on('schedule:run', event => {
      // not-acquired: another instance claimed the occurrence
      if (event.outcome === 'completed' || event.outcome === 'not-acquired') {
        this.#lastSuccess.set(event.job, Math.max(event.scheduledAt, this.#lastSuccess.get(event.job) ?? 0))
      }
    })
  }

  onStop(): void {
    this.#unsubscribe?.()
  }

  /** Armed jobs (not paused, done or disabled) that missed two occurrences in a row. */
  overdue(): string[] {
    const now = this.#now()
    return this.registry
      .jobs()
      .filter(job => job.kind !== 'timeout' && job.nextRun !== undefined)
      .filter(job => {
        const [, second] = job.nextRuns(2, new Date(this.#lastSuccess.get(job.name) ?? this.#since))
        return second !== undefined && second.getTime() < now
      })
      .map(job => job.name)
  }

  /** The scheduler clock: virtual in tests. */
  #now(): number {
    return this.app.getPlugin<SchedulePluginInstance>(SCHEDULE_PLUGIN_NAME)?.clock?.now() ?? Date.now()
  }
}
```

Report overdue jobs as `degraded` with a `200`, not as a `503`: an orchestrator restarting the
instance would not fix a failing job, but the list is worth an alert.

### Admin endpoints {#admin-endpoints}

`@znight/schedule` does not depend on `@znight/http`: admin endpoints are plain routes on the
injectable registry, behind your guards.

```ts [src/schedule/jobs.controller.ts (excerpt)]
import { Controller, Get, HttpCode, NotFoundException, Param, Post } from '@znight/http'
import { type ScheduledJob, SchedulerRegistry } from '@znight/schedule'

@Controller('/admin/jobs')
@Roles(['admin'])
export class JobsController {
  constructor(private readonly registry: SchedulerRegistry) {}

  @Get()
  list(): JobView[] {
    return this.registry.jobs().map(toJobView) // name, schedule, state, running, nextRun, lastRun
  }

  @Post('/:name/run')
  @HttpCode(202)
  run(@Param('name') name: string): { readonly job: string; readonly accepted: true } {
    const job = this.#find(name)
    void job.trigger() // own scope and lock; never rejects for a job failure; the response does not wait
    return { job: job.name, accepted: true }
  }

  @Post('/:name/pause')
  pause(@Param('name') name: string): JobView {
    const job = this.#find(name)
    job.pause() // this instance only; a run in flight goes on
    return toJobView(job)
  }

  #find(name: string): ScheduledJob {
    const job = this.registry.get(name)
    if (job === undefined) throw new NotFoundException(`Unknown job "${name}"`)
    return job
  }
}
```

A manual run goes through the whole pipeline: the job's overlap policy (a running job answers
`skipped`), the lock, its own container scope (never the request's, which it may outlive) and the
hooks. It works with the scheduler disabled (`SCHEDULE_ENABLED=false`).

## Limits {#limits}

- **No durable jobs.** No persistence, history, retries or catch-up of occurrences missed while no
  instance ran: publish a message from the job for work that must survive failures
  ([`@znight/messaging`](/packages/messaging) retries and dead-letters it).
- **Locks are at most once.** A crash mid-run loses that occurrence; design jobs to pick up what the
  previous one left (the purge deletes everything older than the cut-off, not one day's worth).
- **Per-process state.** Dynamic jobs, pauses and reschedules are not shared: rebuild and reconcile
  them from your own data.
- Lock stores for Postgres and Redis are recipes to copy, not subpaths of the package.

See the [package page](/packages/schedule) for every option, the cron dialect and the diagnostics,
and the [uptime-monitor example](https://github.com/znight-org/znight/tree/main/examples/uptime-monitor)
for the whole application.
