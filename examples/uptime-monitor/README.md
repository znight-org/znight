# Uptime monitor

A production-shaped uptime monitor built with [Znight](../../README.md): HTTP endpoints probed on
their own schedules, results stored in **PostgreSQL**, a weekday digest mailed at 08:00 **Paris
time**, old results purged every night, and a public status page with **live results over
Server-Sent Events**. It runs on Node.js and on Bun, served by **Hono**.

It is the reference example of [`@znight/schedule`](../../packages/schedule/README.md), and the tested
source of the recipes of the [Scheduling guide](../../docs/guide/scheduling.md): every feature of
the scheduler is used here for a reason, and every recipe is a file of this application with its
test.

- **Jobs checked at build time.** Cron expressions, durations, time zones, job names and method
  signatures are validated by the compiler, with a caret under the faulty field.
- **Dynamic jobs.** One job per monitor, added and removed at runtime through the injectable
  `SchedulerRegistry`, with schedules from users validated by the same engine.
- **One runner across instances.** A Postgres lock store (in the application's own database) makes
  each occurrence of each job run on exactly one instance, with leases fenced by the occurrence.
- **Cooperative and bounded.** Each run has an abort signal: `maxDuration` bounds a probe (the
  signal goes to `fetch`), the nightly purge stops between two batches on shutdown.
- **Deterministic tests.** A virtual clock drives the real scheduler: the DST switch of March 2027,
  two instances sharing one database, an instance stopping mid-run.

The database is [PGlite](https://pglite.dev) (PostgreSQL compiled to WebAssembly), so the example
runs without any server; the SQL, the migrations and the lock store are plain PostgreSQL.

## What it shows

| Feature                                                                                        | Where                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@Cron` with a time zone and `maxDuration`, a schedule replaced per deployment (`DIGEST_CRON`) | [`digest/digest.jobs.ts`](src/digest/digest.jobs.ts), [`plugins.ts`](src/plugins.ts)                                                |
| `@Cron` with seconds, batches checking `ctx.signal` between them                               | [`maintenance/purge.jobs.ts`](src/maintenance/purge.jobs.ts)                                                                        |
| `@Interval` with `runOnStart`, `@Timeout`, per-instance jobs (`lock: false`)                   | [`status/status.cache.ts`](src/status/status.cache.ts)                                                                              |
| Dynamic jobs (`registry.addInterval` / `addCron` / `remove`), reconciled across instances      | [`monitors/monitor.scheduler.ts`](src/monitors/monitor.scheduler.ts)                                                                |
| `ctx.signal` passed to `fetch`, `ctx.scheduledAt` as the key of a result                       | [`monitors/probe.service.ts`](src/monitors/probe.service.ts), [`prober.ts`](src/monitors/prober.ts)                                 |
| User schedules validated with `parseCron` / `parseDuration` in a Zod schema                    | [`monitors/monitor.schemas.ts`](src/monitors/monitor.schemas.ts)                                                                    |
| Postgres lock store (the guide's recipe) on the application's database; a Redis recipe         | [`schedule/postgres-lock-store.ts`](src/schedule/postgres-lock-store.ts), [`redis-lock-store.ts`](src/schedule/redis-lock-store.ts) |
| Admin endpoints on `SchedulerRegistry`: list, run now, pause, resume                           | [`schedule/jobs.controller.ts`](src/schedule/jobs.controller.ts)                                                                    |
| A health check flagging overdue jobs (the `schedule:run` hook)                                 | [`health/job-health.ts`](src/health/job-health.ts), [`health.controller.ts`](src/health/health.controller.ts)                       |
| Server-Sent Events fed by jobs: `@Sse`, a bounded `EventChannel`, replay with `Last-Event-ID`  | [`status/status.controller.ts`](src/status/status.controller.ts), [`monitors/probe-events.ts`](src/monitors/probe-events.ts)        |
| PGlite through a `@Factory`: async init, migrations, dispose                                   | [`db/database.factory.ts`](src/db/database.factory.ts), [`db/migrations.ts`](src/db/migrations.ts)                                  |
| An idempotent outbox: one e-mail per occurrence                                                | [`digest/outbox.mailer.ts`](src/digest/outbox.mailer.ts)                                                                            |
| API keys and access decisions (`@Public()` / `@Roles()`), checked at build time and at boot    | [`auth/`](src/auth)                                                                                                                 |
| Job logs with `job` / `runId`, plugin order for a clean shutdown                               | [`plugins.ts`](src/plugins.ts), [`main.ts`](src/main.ts)                                                                            |
| Unit tests (`TestBed`, `createJobContext`), schedule tests on a virtual clock, HTTP tests, e2e | [`test/`](test)                                                                                                                     |

## Run it

Requirements: Node.js 24+ or Bun 1.3+. In this repository, install and build the framework once,
from the repository root: `bun install && bun run build` (the CLI and the production build use the
packages' `dist`).

```sh
bun run dev          # or: npm run dev
```

`dev` builds the application in watch mode and restarts it on every change, with
`NODE_ENV=development`: [`.env.development`](.env.development) provides development API keys, debug
logs, Paris as the default zone of the cron jobs, and a database kept in `./data/uptime` across
restarts. The API listens on <http://localhost:3000>.

| Script             | bun                        | npm / Node.js       | Does                                                                      |
| ------------------ | -------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `dev`              | `bun run dev`              | `npm run dev`       | `znight dev`: build in watch mode, restart on change                      |
| `build`            | `bun run build`            | `npm run build`     | `znight build`: production bundle `dist/main.js` (fails on any job error) |
| `start`            | `bun run start`            | `npm run start`     | `znight start`: runs `dist/main.js` with `NODE_ENV=production`            |
| `test`             | `bun run test`             | —                   | unit, schedule and HTTP tests (`bun test`), a few seconds                 |
| `test:e2e`         | `bun run test:e2e`         | —                   | builds, then runs the bundle on Node.js **and** Bun against a real target |
| `test:integration` | `bun run test:integration` | —                   | the Redis lock store on a Redis container (Docker)                        |
| `typecheck`        | `bun run typecheck`        | `npm run typecheck` | generates the container, then `tsc --noEmit`                              |
| `generate`         | `bun run generate`         | `npm run generate`  | writes `src/.znight/container.generated.ts` (`--check` in CI)             |

The production bundle runs on both runtimes, configured by environment variables only:

```sh
bun run build
API_KEY=change-me node --enable-source-maps dist/main.js   # Node.js
API_KEY=change-me bun dist/main.js                          # Bun
```

```json
{"level":30,"msg":"Uptime monitor ready","url":"http://0.0.0.0:3000","jobs":5}
{"level":30,"msg":"Monitors scheduled","monitors":0}
{"level":30,"component":"znight","msg":"Schedule: 5 job(s), next: monitors.sync at 2026-10-28T11:05:00.000Z","jobs":5}
{"level":30,"job":"status-cache.refresh","runId":"9802b510-…","trigger":"start","scheduledAt":"2026-10-28T11:04:58.913Z","durationMs":4.8,"lateMs":1,"msg":"job completed"}
```

### Configuration

Read by [`ConfigPlugin`](../../packages/config/README.md) from `.env` files, then from the
environment (which wins), and validated at boot. Schedules from the environment are validated by
the scheduler with the rules the compiler applies to decorators: `DIGEST_CRON='0 25 * * *'` or
`SCHEDULE_TIME_ZONE=Europe/Pariss` stop the boot with
[`ZNIGHT040`](../../docs/reference/error-codes.md#znight040).

| Variable                    | Default                     | Description                                                                                  |
| --------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `API_KEY`                   | (required)                  | Administrator key: monitors, jobs, outbox (`@Secret`: never printed)                         |
| `READONLY_API_KEY`          | —                           | Read-only key: lists monitors and their results                                              |
| `PORT` / `HOST`             | `3000` / `0.0.0.0`          | API address (`PORT=0`: a free port, logged when ready)                                       |
| `LOG_LEVEL`                 | `info`                      | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`                                 |
| `EXPOSE_ERRORS`             | `false`                     | Send the message of unexpected errors in 500 responses (development)                         |
| `METRICS_PORT`              | —                           | Prometheus `/metrics` on this port (needs `prom-client`: `bun add prom-client`)              |
| `DATABASE_DATA_DIR`         | `memory://`                 | PGlite data: in memory, or a directory persisted on disk                                     |
| `SCHEDULE_ENABLED`          | `true`                      | `false` on replicas that only serve HTTP: nothing is scheduled (manual runs still work)      |
| `SCHEDULE_TIME_ZONE`        | `UTC`                       | Zone of the cron jobs that do not name one (`probes.purge`)                                  |
| `SCHEDULE_LOCK_TTL`         | `30s`                       | Lease of a locked run, renewed every third of it: how long a crashed instance blocks its job |
| `SCHEDULE_DRAIN_TIMEOUT_MS` | `4000`                      | On shutdown, how long running jobs get to return once their signal is aborted                |
| `DIGEST_CRON`               | —                           | Replaces the schedule of `digest.daily` (`'0 8 * * MON-FRI'`), in its zone (Paris)           |
| `DIGEST_RECIPIENTS`         | `ops@example.com`           | Comma-separated addresses of the digest                                                      |
| `PROBES_RETENTION_DAYS`     | `30`                        | Results older than this are purged every night                                               |
| `PROBES_PURGE_BATCH_SIZE`   | `1000`                      | Rows deleted per statement by the purge                                                      |
| `PROBES_USER_AGENT`         | `znight-uptime-monitor/0.1` | Sent with every probe                                                                        |

## Try it

With `bun run dev` running (development keys: `dev-admin-key`, `dev-reader-key`):

```sh
API=http://localhost:3000
ADMIN='x-api-key: dev-admin-key'
READER='x-api-key: dev-reader-key'

# a monitor probed every 30 s: its job, monitor.1, is added to the registry at once
curl -i -H "$ADMIN" -H 'content-type: application/json' -X POST $API/monitors \
  -d '{"name":"Example","url":"https://example.com","every":"30s"}'
# 201, location: /monitors/1
# {"id":1,...,"schedule":"every 30s","timeoutMs":10000,"job":{"name":"monitor.1","state":"scheduled","nextRun":"2026-10-28T11:10:00.000Z","lastRun":null}}

# or on a cron schedule, in a time zone: every 5 minutes during Paris office hours
curl -H "$ADMIN" -H 'content-type: application/json' -X POST $API/monitors \
  -d '{"name":"Office hours","url":"https://example.com","cron":"*/5 9-18 * * MON-FRI","timeZone":"Europe/Paris"}'

# schedules from users are validated by the scheduler's own engine, with the build-time messages
curl -H "$ADMIN" -H 'content-type: application/json' -X POST $API/monitors \
  -d '{"name":"Bad","url":"https://example.com","cron":"0 25 * * *"}'
# 400 {"message":"Invalid body","details":[{"path":"cron","message":"Invalid cron expression '0 25 * * *': hour 25 is out of range (0-23)"}]}

# the results, live: one `probe` event per probe (public)
curl -N $API/status/events
# retry: 5000
#
# id: 2
# event: probe
# data: {"monitorId":1,"up":true,"status":200,"latencyMs":209,"error":null,"checkedAt":"...","scheduledAt":"2026-10-28T11:10:00.000Z"}

curl $API/status                                    # the status page, refreshed every minute (public)
curl -H "$READER" $API/monitors/1                   # a monitor, its job and its latest results
curl $API/health                                    # {"status":"ok","scheduler":{"state":"running","jobs":7,...},"overdue":[]}

# the scheduler, for administrators
curl -H "$ADMIN" $API/admin/jobs                    # every job: schedule, state, nextRun, lastRun
curl -H "$ADMIN" $API/admin/jobs/digest.daily       # ...and its next five occurrences
curl -H "$ADMIN" -X POST $API/admin/jobs/digest.daily/run     # 202 {"job":"digest.daily","accepted":true}
curl -H "$ADMIN" $API/admin/outbox                  # the digest, waiting for the relay
curl -H "$ADMIN" -X POST $API/admin/jobs/digest.daily/pause   # {"state":"paused","nextRun":null,...}
curl -H "$ADMIN" -X POST $API/admin/jobs/digest.daily/resume
curl -H "$READER" -X POST $API/admin/jobs/digest.daily/run    # 403

curl -H "$ADMIN" -X DELETE $API/monitors/1          # 204: the job is removed, a probe in flight is aborted
```

| Method   | Path                       | Access   | Response                                                                                      |
| -------- | -------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `GET`    | `/status`                  | public   | the status page (a per-instance cache), `503` until its first refresh                         |
| `GET`    | `/status/events`           | public   | an event stream of the probe results (`Last-Event-ID` replays the missed ones)                |
| `GET`    | `/health`                  | public   | `200 {status: ok \| degraded, scheduler, overdue}`, `503` when the database is down           |
| `GET`    | `/monitors`                | `reader` | the monitors with their job on this instance                                                  |
| `GET`    | `/monitors/:id`            | `reader` | a monitor, its job and its 20 latest results, `404`                                           |
| `POST`   | `/monitors`                | `admin`  | `{name, url, every \| cron, timeZone?, expectedStatus?, timeout?}`: `201` + `location`, `400` |
| `DELETE` | `/monitors/:id`            | `admin`  | `204`, `404`                                                                                  |
| `GET`    | `/admin/jobs`              | `admin`  | every job, static and dynamic                                                                 |
| `GET`    | `/admin/jobs/:name`        | `admin`  | a job and its next occurrences, `404`                                                         |
| `POST`   | `/admin/jobs/:name/run`    | `admin`  | `202`: the run goes on in the background, through the lock                                    |
| `POST`   | `/admin/jobs/:name/pause`  | `admin`  | the job, `404`, `409` for a job that is done or disabled                                      |
| `POST`   | `/admin/jobs/:name/resume` | `admin`  | the job, `404`, `409`                                                                         |
| `GET`    | `/admin/outbox`            | `admin`  | the 20 latest e-mails waiting for the relay                                                   |

## Try breaking it

The jobs are checked by the compiler: `znight build`, `znight dev`, `znight generate` and `bun test`
fail with a located diagnostic. In [`digest.jobs.ts`](src/digest/digest.jobs.ts), make the digest run
at 25:00:

```txt
✗ ZNIGHT040: Invalid cron expression for job 'digest.daily': hour 25 is out of range (0-23)
  --> src/digest/digest.jobs.ts:36:12
   |
36 |   @Cron('0 25 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
   |            ^^
   = hint: Fields: [second] minute hour day-of-month month day-of-week
```

Misspell its zone (`'Europe/Pariss'`): `ZNIGHT040: @Cron: Unknown time zone 'Europe/Pariss' (did you mean
'Europe/Paris'?)`. Give the purge of [`purge.jobs.ts`](src/maintenance/purge.jobs.ts) the name of the
digest:

```txt
✗ ZNIGHT041: Job name 'digest.daily' is used twice
  --> src/maintenance/purge.jobs.ts:32:27
   |
32 |   @Cron('0 30 3 * * *', { name: 'digest.daily', maxDuration: '10m' })
   |                           ^^^^^^^^^^^^^^^^^^^^
   |
  ::: src/digest/digest.jobs.ts:36:30
   |
36 |   @Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
   |                              -------------------- first declared here
   = hint: Job names must be unique (logs, metrics, lock keys): rename one of them
```

Make the purge `private` (`ZNIGHT005: PurgeJobs.purge() must be public: @Cron methods are called by
the generated code`), or give the digest a second parameter (`ZNIGHT040: DigestJobs.sendDaily(ctx:
JobContext, extra: string) is called with (ctx: JobContext)`). Schedules from the environment fail
at boot instead, with the same messages: `DIGEST_CRON='0 25 * * *' bun run dev`.
[`build-check.test.ts`](test/build-check.test.ts) compiles a copy of the application with these
changes and checks every diagnostic, so this section stays true.

## How it is built

```txt
src/
├─ main.ts                          # Application.create(): plugins(), shutdown timeouts
├─ plugins.ts                       # Observability, Config, Schedule (lock store, overrides), Http: shared with the tests
├─ app.lifecycle.ts                 # "ready" and "stopping" log lines
├─ config/                          # @Config classes: server, database, auth (@Secret), schedule, digest, probes
├─ db/
│  ├─ database.ts                   # interface Database: parameterized SQL returning rows
│  ├─ database.factory.ts           # @Factory: PGlite client (dispose) + migrated Database
│  └─ migrations.ts                 # schema, the lock table included
├─ schedule/
│  ├─ postgres-lock-store.ts        # the lock store of the scheduling guide (used here)
│  ├─ redis-lock-store.ts           # the Redis recipe (tested, not used)
│  └─ jobs.controller.ts            # /admin/jobs
├─ monitors/
│  ├─ monitor.ts                    # domain types, job names
│  ├─ monitor.schemas.ts            # POST /monitors, schedules validated with parseCron / parseDuration
│  ├─ monitor.scheduler.ts          # one dynamic job per monitor; monitors.sync (@Interval)
│  ├─ probe.service.ts              # the body of a monitor job
│  ├─ prober.ts                     # interface Prober, FetchProber (fetch + ctx.signal)
│  ├─ probe-events.ts               # fan-out of the results to the event streams
│  ├─ monitor.repository.ts, probe-result.repository.ts
│  └─ monitor.controller.ts         # /monitors
├─ status/                          # StatusCache (@Interval, @Timeout), /status and /status/events (@Sse)
├─ digest/                          # DigestJobs (@Cron), ReportService, Mailer port, OutboxMailer, /admin/outbox
├─ maintenance/purge.jobs.ts        # @Cron with seconds, batched purge
├─ health/                          # JobHealth (schedule:run hook), /health
├─ auth/                            # AuthGuard, @Public / @Roles
└─ .znight/                         # generated container (git-ignored)
test/                               # bun test: unit, schedule, HTTP, build checks, e2e, integration
```

### The jobs

| Job                    | Declaration                                                                  | Runs                                 | Shows                                                                           |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `monitor.<id>`         | `registry.addInterval()` / `addCron()`, at `onReady` and through the API     | once per occurrence, on one instance | dynamic jobs, `ctx.signal` passed to `fetch`, `maxDuration`, a lock per monitor |
| `digest.daily`         | `@Cron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris', maxDuration: '10m' })` | 08:00 Paris time on weekdays         | zones and DST, `DIGEST_CRON` override, idempotent outbox                        |
| `probes.purge`         | `@Cron('0 30 3 * * *', { maxDuration: '10m' })`                              | 03:30:00 in `SCHEDULE_TIME_ZONE`     | 6 fields, batches with `ctx.signal`, cooperative shutdown                       |
| `status-cache.refresh` | `@Interval('1m', { lock: false, runOnStart: true })`                         | every minute, on every instance      | per-instance work, epoch alignment, `runOnStart`                                |
| `status-cache.warm`    | `@Timeout('2s', { lock: false })`                                            | once, 2 s after the start            | one-shot at start                                                               |
| `monitors.sync`        | `@Interval('30s', { lock: false })`                                          | every 30 s, on every instance        | reconciling dynamic jobs (they are neither persisted nor shared)                |

A class with jobs needs no decorator: `DigestJobs`, `PurgeJobs` and `StatusCache` become singleton
providers with constructor injection, created at boot. The compiler declares them as entry points,
so `reportUnused` does not flag them and `prune` keeps them.

### Writing a job: the occurrence and the signal

Every run receives a `JobContext`. Two of its fields shape how the jobs here are written:

- **`ctx.scheduledAt`, never `new Date()`.** It is the occurrence the run stands for, on the
  scheduler clock: a probe result is keyed by it (`UNIQUE (monitor_id, scheduled_at)`), the digest
  reports on the period ending at it and its e-mail is keyed by it, the purge computes its cut-off
  from it. A late run (a stalled process) still reports on the right period, a second run of the
  same occurrence writes nothing twice, and tests pick any occurrence they want. With a lock store
  it also increases strictly per job across the fleet: a free fencing token for writes.
- **`ctx.signal`, everywhere.** It is aborted when `maxDuration` is exceeded (`timeout`), the lock
  lease is lost (`lock-lost`), the job is removed with `{ abort: true }` (`removed`) or the
  application stops (`shutdown`). JavaScript cannot kill a promise, so jobs cooperate:
  [`FetchProber`](src/monitors/prober.ts) passes it to `fetch`, and
  [`PurgeJobs`](src/maintenance/purge.jobs.ts) checks it between two batches.

```ts
// monitors/probe.service.ts (excerpt): the run's signal bounds the probe
try {
  ;({ status } = await this.prober.probe({ url: monitor.url, signal: ctx.signal }))
} catch (cause) {
  const aborted = abortReason(ctx.signal)
  if (aborted !== undefined && aborted !== 'timeout') return // shutdown, deleted monitor, lost lease
  error = aborted === 'timeout' ? `No answer within ${monitor.timeoutMs} ms` : describeError(cause)
}
```

### Dynamic jobs: one per monitor

Monitors live in the database, so their jobs cannot be decorators.
[`MonitorScheduler`](src/monitors/monitor.scheduler.ts) adds them to the injectable
`SchedulerRegistry`:

```ts
#schedule(monitor: Monitor): ScheduledJob {
  const name = monitorJobName(monitor.id) // 'monitor.42': its logs, metrics and lock key
  const probe = (ctx: JobContext): Promise<void> => this.probes.run(monitor, ctx)
  const options = { maxDuration: monitor.timeoutMs } // ctx.signal aborts after the monitor's timeout
  return 'every' in monitor.schedule
    ? this.registry.addInterval(name, monitor.schedule.every, probe, options)
    : this.registry.addCron(name, monitor.schedule.cron, probe, { ...options, timeZone: monitor.schedule.timeZone })
}
```

- `onReady` schedules every monitor of the database: providers' `onReady` runs before the plugins',
  so the jobs are armed together with the decorated ones.
- The API adds a job when a monitor is created and removes it (`{ abort: true }`) when it is
  deleted. A schedule from a user is validated first by the scheduler's own engine
  ([`monitor.schemas.ts`](src/monitors/monitor.schemas.ts) calls `parseCron` and `parseDuration` in a
  Zod refinement), so the registry never rejects it and the user gets the build-time message.
- Dynamic jobs are neither persisted nor shared between instances: `monitors.sync` reconciles the
  registry with the database every 30 seconds on every instance, so a monitor created through
  another instance gets its job here too.
- Each monitor job is **locked** (the plugin has a lock store): with three instances, each
  occurrence of each monitor is probed once, by whichever instance claims it first, and the
  monitors spread over the fleet.

### Time zones and daylight saving time

Cron jobs are evaluated on the wall clock of their zone, UTC by default. `digest.daily` names its
own (`Europe/Paris`): 07:00Z in winter, 06:00Z in summer, never twice nor skipped on a DST day.
`probes.purge` names none and takes the plugin's (`SCHEDULE_TIME_ZONE`). Zones are validated at build
time and again at boot with the runtime's `Intl`. Intervals are durations: zones do not apply, and
their occurrences are multiples of the period since the Unix epoch, so every instance and every
restart agrees on them (`status-cache.refresh` runs at hh:mm:00, whenever the instance started).
[`digest.schedule.test.ts`](test/digest.schedule.test.ts) runs the digest across the March 2027
switch.

### One runner across instances

[`plugins.ts`](src/plugins.ts) gives the scheduler a lock store in the application's own
database (simplified):

```ts
SchedulePlugin.configure((container): SchedulePluginOptions => {
  const schedule = container.get(ScheduleConfig)
  return {
    enabled: schedule.enabled, // SCHEDULE_ENABLED
    timeZone: schedule.timeZone, // SCHEDULE_TIME_ZONE
    lock: {
      store: new PostgresLockStore(container.get<Database>('Database')),
      ttl: parseDuration(schedule.lockTtl), // SCHEDULE_LOCK_TTL, parsed by the scheduler's rules
    },
    // DIGEST_CRON, validated at boot (ZNIGHT040)
    jobs: schedule.digestCron === undefined ? {} : { 'digest.daily': { cron: schedule.digestCron } },
    drainTimeoutMs: schedule.drainTimeoutMs, // SCHEDULE_DRAIN_TIMEOUT_MS
  }
})
```

With a store, every job is locked by default; `lock: false` opts out the per-instance work (the
status cache, `monitors.sync`). [`PostgresLockStore`](src/schedule/postgres-lock-store.ts) is one
row per job and one atomic upsert per claim: it takes the row only when its lease expired **and**
the claimed occurrence is later than the last one claimed. Two instances whose clocks differ both
fire "08:00": the first claims it, the second is refused even after the first released it, so the
digest is never sent twice, without guessing a minimum hold time. Expiry uses the database clock.

- A run's lease is renewed every third of `SCHEDULE_LOCK_TTL` while it lasts; an instance that
  crashes blocks its job for one lease at most.
- At shutdown, a run that does not return within the drain timeout is **abandoned**: its lease is
  not released and simply expires, so no other instance starts the job while it may still be
  writing. [`single-runner.test.ts`](test/single-runner.test.ts) shows both instances, and the
  takeover.
- [`RedisLockStore`](src/schedule/redis-lock-store.ts) is the same contract on Redis (a Lua script,
  Cluster-safe keys), for fleets that share a Redis rather than a database.

Both stores pass the conformance scenarios of `@znight/schedule/testing`
([`postgres-lock-store.test.ts`](test/postgres-lock-store.test.ts) on PGlite,
[`redis-lock-store.test.ts`](test/redis-lock-store.test.ts) on a Redis container).

### Live results: Server-Sent Events

`GET /status/events` streams one `probe` event per stored result. Jobs **push** results while
clients **pull** events, so [`ProbeEvents`](src/monitors/probe-events.ts) gives each client a bounded
`EventChannel`: a client that falls too far behind is disconnected, reconnects with `Last-Event-ID`
(the id of a result) and catches up from the database. The route
([`status.controller.ts`](src/status/status.controller.ts)) is an `async` method that subscribes and
reads the missed results before the stream opens, with a `retry` delay and a `maxDuration` of 30
minutes so that long-lived clients spread over the instances of a rolling deployment. The fan-out is
in-process: with several instances, each client sees the probes of the instance it is connected to
(fan out through `LISTEN` / `NOTIFY` or a broker for a fleet-wide stream).

### Health and admin endpoints

The admin endpoints ([`jobs.controller.ts`](src/schedule/jobs.controller.ts)) are plain routes on
`SchedulerRegistry`, behind the global `AuthGuard`. A manual run answers `202` at once and goes
through the whole pipeline: overlap policy, lock, its own container scope, hooks. Pauses are per
instance and not persisted.

[`JobHealth`](src/health/job-health.ts) listens to the `schedule:run` hook of `@znight/core`, which
the scheduler emits once per occurrence with its outcome, and `GET /health` lists the jobs that
missed two occurrences in a row on this instance. They make the status `degraded`, not the response
a `503`: restarting the instance would not fix a failing job, but the list is worth an alert. For the
whole fleet, alert on `schedule_last_success_timestamp_seconds` (below).

### Observability

`ObservabilityPlugin` comes first in [`plugins.ts`](src/plugins.ts), so its hooks wrap every request
and every run:

- one log line per run: `job completed` (`info`), `job failed` (`error`, with the stack), `job
  skipped` (`warn`: a run still in flight when the next occurrence fired), `job not acquired`
  (`debug`: another instance holds the lock), with `job`, `runId`, `trigger`, `scheduledAt`,
  `durationMs`, `lateMs` and `aborted`; every line logged inside a run carries `job` and `runId`;
- with `METRICS_PORT` (and `prom-client`): `schedule_runs_total{job, outcome}`,
  `schedule_run_duration_seconds`, `schedule_run_lateness_seconds`, `schedule_active_runs` and
  `schedule_last_success_timestamp_seconds{job}`, the basis of "has not succeeded since" alerts;
- a span per run, `schedule <job>`, with any OpenTelemetry SDK (a child of the admin request for a
  manual run).

### Graceful shutdown

On `SIGTERM` / `SIGINT`, plugins stop in the reverse order of [`plugins.ts`](src/plugins.ts): HTTP
first (no new monitor nor manual run, in-flight requests drained, event streams closed with a
jittered `retry`), then the scheduler: it disarms its timer, aborts the signal of every running run
(`shutdown`) at once and waits for them, at most `SCHEDULE_DRAIN_TIMEOUT_MS`. A probe in flight is
aborted and records nothing (the target is not to blame), the purge returns at its next batch
boundary, and the drain completes in milliseconds. Then providers stop, the database closes, and the
process exits with code `0`. Keep `SCHEDULE_DRAIN_TIMEOUT_MS` (4 s) below `hookTimeoutMs` (5 s), and
`timeoutMs` (9 s, [`main.ts`](src/main.ts)) below your platform's grace period.

## Tests

```sh
bun run test               # unit, schedule, HTTP and build checks: a few seconds
bun run test:e2e           # production build, then Node.js and Bun processes against a real target
bun run test:integration   # the Redis lock store on a Redis container (Docker)
```

`bunfig.toml` preloads `@znight/compiler/bun`, which regenerates the container before the tests.
Schedule tests run the **real** scheduler on a **virtual clock** (`createTestClock()`): time only
moves when the test advances it, and advancing waits for the runs it started (database queries
included), so no test sleeps to wait for a job. [`support/app.ts`](test/support/app.ts) boots the
application with the `plugins()` of `main.ts`, a fake network and silent logs.

| File                                                              | Shows                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`digest.jobs.test.ts`](test/digest.jobs.test.ts)                 | `TestBed` and `createJobContext()`: the job reads `ctx.scheduledAt`, not the current time; an aborted signal                                                                                                                           |
| [`probe.service.test.ts`](test/probe.service.test.ts)             | the body of a monitor job, with each abort reason                                                                                                                                                                                      |
| [`digest.schedule.test.ts`](test/digest.schedule.test.ts)         | `TestApp` and a test clock across the March 2027 DST switch; `DIGEST_CRON` override; an invalid one refused at boot                                                                                                                    |
| [`monitors.http.test.ts`](test/monitors.http.test.ts)             | `POST /monitors` adds `monitor.<id>`; advancing the clock probes; `maxDuration`; `DELETE` aborts the probe; event streams                                                                                                              |
| [`admin.http.test.ts`](test/admin.http.test.ts)                   | list, run (202, then `lastRun.outcome === 'completed'`), pause and resume, 401, 403, 404, 409                                                                                                                                          |
| [`status.http.test.ts`](test/status.http.test.ts)                 | the status cache and its jobs; `/health` flagging a failing job                                                                                                                                                                        |
| [`single-runner.test.ts`](test/single-runner.test.ts)             | two applications sharing one PGlite and one clock: each occurrence runs once; an instance stops mid-run, its lease expires                                                                                                             |
| [`shutdown.test.ts`](test/shutdown.test.ts)                       | a running purge receives `shutdown` and returns between batches; a probe in flight is aborted; the drain completes                                                                                                                     |
| [`postgres-lock-store.test.ts`](test/postgres-lock-store.test.ts) | the conformance scenarios of lock stores against the Postgres store on PGlite                                                                                                                                                          |
| [`build-check.test.ts`](test/build-check.test.ts)                 | `compile()` on a copy of the application: ZNIGHT040 (with the location of the field), ZNIGHT041, ZNIGHT005                                                                                                                             |
| [`redis-lock-store.test.ts`](test/redis-lock-store.test.ts)       | `ZNIGHT_INTEGRATION=1`: the conformance scenarios against the Redis store, on a Redis container, through Bun's `RedisClient`                                                                                                           |
| [`e2e.test.ts`](test/e2e.test.ts)                                 | `ZNIGHT_E2E=1`: `znight build`, the bundle on Node.js then Bun (same data directory), a 2-second monitor against a local target, event stream, run logs, `/admin/jobs`, SIGTERM with a probe in flight (aborted, drained, exit code 0) |

## In this repository

The example is a workspace of the Znight monorepo, so a few settings exist only to use the
framework from its sources; a project created with `znight new` does not need them:

- `tsconfig.json`: `customConditions: ["@znight/source"]` and `allowImportingTsExtensions` make `tsc`
  check against the packages' TypeScript sources;
- `vite.config.ts`: `ssr.external` keeps the linked `@znight/*` packages out of the bundle (packages
  installed from npm are external anyway);
- `test` scripts pass `--conditions=@znight/source` to `bun test`.

`bunfig.toml` sets `env = false` in any project: Bun would otherwise load `.env` files itself, with
its own precedence and expansion rules, before `ConfigPlugin` does.
