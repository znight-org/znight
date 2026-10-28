---
description: "@znight/schedule - cron, interval and timeout jobs validated at build time, with time zones, overlap control, a lock for one runner across instances and graceful shutdown."
---

# @znight/schedule <Badge type="tip" text="available" />

Scheduled jobs for Znight, with the API NestJS users know (`@Cron`, `@Interval`, `@Timeout`, a
registry) and the guarantees of a compile-time framework:

- **Checked at build time.** Cron expressions, durations, time zones, options, job names and method
  signatures are validated by the compiler, with a caret under the faulty field
  ([`ZNIGHT040`](/reference/error-codes#znight040)).
- **One cron engine, no dependency.** The compiler and the runtime share the same engine, so the
  build and the process agree on every expression, on Node.js 24+ and Bun 1.3+. UTC by default,
  IANA time zones, written rules for daylight saving time.
- **Robust at runtime.** One timer for every job, resynchronised with the wall clock; overlapping
  runs skipped by default; `maxDuration` and `ctx.signal` to bound runs; running jobs aborted and
  drained on shutdown.
- **One runner across instances.** With a lock store, an occurrence runs on one instance only, even
  with clock skew between them.
- **Observable and testable.** A `schedule:run` hook for logs, metrics and traces, and a virtual
  clock for deterministic tests.

```sh
npm install @znight/schedule
```

## Quick start

```ts [src/digest/digest.jobs.ts]
import { Cron, type JobContext } from '@znight/schedule'

export class DigestJobs {
  constructor(
    private readonly reports: ReportService,
    private readonly mailer: Mailer,
  ) {}

  /** 08:00 in Paris, Monday to Friday. */
  @Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
  async sendDaily(ctx: JobContext): Promise<void> {
    const report = await this.reports.build({ until: ctx.scheduledAt, signal: ctx.signal })
    await this.mailer.send(digestEmail(report))
  }
}
```

```ts [src/main.ts]
import { Application } from '@znight/core'
import { SchedulePlugin } from '@znight/schedule'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [SchedulePlugin.configure()],
})
await app.start() // the process stays alive while the scheduler runs; SIGTERM drains running jobs
```

A class with jobs needs no decorator: it becomes a singleton provider with constructor injection,
like a guard (use `@Injectable({ scope })` for another scope). A mistake fails the build:

```txt
✗ ZNIGHT040: Invalid cron expression for job 'digest.daily': hour 25 is out of range (0-23)
  --> src/digest/digest.jobs.ts:9:9
```

## Jobs

```ts
import { Cron, Interval, type JobContext, Timeout } from '@znight/schedule'

export class OutboxJobs {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly broker: MessageBroker,
  ) {}

  /** 6 fields: every 10 seconds. A tick that fires during a run is queued (at most one). */
  @Cron('*/10 * * * * *', { name: 'outbox.flush', overlap: 'queue', maxDuration: '30s' })
  async flush(ctx: JobContext): Promise<void> {
    for (const batch of await this.outbox.pendingBatches()) {
      ctx.signal.throwIfAborted() // checkpoint: shutdown, maxDuration or lost lock
      await this.broker.publishAll(batch)
    }
  }

  /** Every minute, on every instance (a per-instance cache). */
  @Interval('1m', { lock: false, runOnStart: true })
  refresh() {}

  /** Once per process, 5 s after the scheduler started. */
  @Timeout('5s', { name: 'outbox.recover', lock: false })
  recover(): Promise<void> {
    return this.outbox.releaseStaleClaims()
  }
}
```

- A job method takes no parameter, or one `ctx: JobContext` (`job`, `runId`, `trigger`,
  `scheduledAt`, `startedAt`, `previous`, `signal`). Its promise is awaited.
- The default name is `<Class>.<method>` (`OutboxJobs.refresh`). Names are unique across the
  application and its libraries; a method with several triggers names each of them.
- Arguments are static (literals and constants). Values that depend on the environment go through
  the plugin's `jobs` option, validated at boot.
- `JobContext` is also a request-scoped value: each run has its own scope, so request-scoped
  providers work in jobs (`HttpContext` does not exist there).

| Option        | `@Cron` | `@Interval` | `@Timeout` | Default                                             |
| ------------- | ------- | ----------- | ---------- | --------------------------------------------------- |
| `name`        | ✓       | ✓           | ✓          | `<Class>.<method>`                                  |
| `enabled`     | ✓       | ✓           | ✓          | `true` (`false`: listed, never scheduled)           |
| `lock`        | ✓       | ✓           | ✓          | `true` with a lock store, unless `overlap: 'allow'` |
| `maxDuration` | ✓       | ✓           | ✓          | none (aborts `ctx.signal` when exceeded)            |
| `overlap`     | ✓       | ✓           | —          | `'skip'` (or `'queue'`, `'allow'`)                  |
| `runOnStart`  | ✓       | ✓           | —          | `false`                                             |
| `timeZone`    | ✓       | —           | —          | the plugin `timeZone`, `'UTC'`                      |

Durations are milliseconds or a number with a unit: `'500ms'`, `'30s'`, `'5m'`, `'1.5h'`, `'1d'`.

## Cron expressions and time zones

Five fields (`minute hour day-of-month month day-of-week`), or six with seconds first. Each field is
`*`, a value, a range `a-b`, a step `*/s` or `a-b/s`, or a list of those; months and days accept
names (`JAN`, `MON-FRI`). Also `L` (last day of the month), `5L` (last Friday), `MON#2` (second
Monday) and the nicknames `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly`. When both the day of
month and the day of week are restricted, either one matches, as in classic cron.

- **UTC by default.** Set `timeZone` per job (an IANA name, `'UTC'`, `'local'` or an offset such as
  `'+05:30'`), or for every cron job with the plugin's `timeZone`.
- **Daylight saving time.** A local time skipped in spring fires once, right after the gap; a local
  time repeated in autumn fires once, at its first occurrence. A daily job never runs twice nor gets
  skipped on a DST day, and sub-hourly jobs keep their real-time rhythm.

The engine is public, for validating schedules entered by users with the same rules:

```ts
import { parseCron, parseDuration } from '@znight/schedule'

const schedule = parseCron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris' }) // throws ZNIGHT040 when invalid
schedule.next(new Date('2026-10-27T10:00:00Z')) // 2026-10-28T07:00:00.000Z
parseDuration('1.5h') // 5_400_000
```

## Plugin options

`SchedulePlugin.configure(options)`, or a function of the container:

| Option           | Default | Description                                                                                        |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `enabled`        | `true`  | `false`: nothing is scheduled (web-only replicas); the registry still triggers jobs                |
| `timeZone`       | `'UTC'` | Default zone of cron jobs                                                                          |
| `lock`           | none    | A lock store, or `{ store, ttl, keyPrefix, owner }` (one runner per occurrence)                    |
| `jobs`           | —       | Per-job overrides by name: `{ enabled, cron, timeZone, every, delay, overlap, lock, maxDuration }` |
| `drainTimeoutMs` | `4000`  | Maximum wait for running jobs on shutdown                                                          |
| `clock`          | system  | Time source and timers (a test clock in tests)                                                     |

```ts
SchedulePlugin.configure(container => {
  const config = container.get(ScheduleConfig)
  return {
    enabled: config.enabled, // SCHEDULE_ENABLED=false on web-only replicas
    lock: { store: new PostgresLockStore(container.get(Database)), ttl: '30s' }, // a recipe: see below
    jobs: { 'digest.daily': { cron: config.digestCron } }, // validated at boot
  }
})
```

Put `SchedulePlugin` before `HttpPlugin`: plugins stop in reverse order, so the server stops taking
requests first, then running jobs are drained.

## One runner across instances

Without a lock store, every instance runs every job: right for a single instance and for
per-instance work. With replicas, configure a store shared by the instances: jobs are then locked by
default, and each occurrence runs once across the fleet (opt out with `lock: false`). A store
implements one method, `acquire(key, { owner, occurrence, ttlMs })`, which claims an occurrence of a
job and returns a lease to extend and release. `memoryLockStore()` serves a single process and
tests; for a fleet, implement the interface on a database or Redis shared by the instances (the
[package README](../../packages/schedule/README.md) describes the contract and the conformance
scenarios a store must pass; the package tests a Postgres recipe,
[`postgres-lock-store.ts`](../../packages/schedule/test/integration/postgres-lock-store.ts), and a
Redis one, [`redis-lock-store.ts`](../../packages/schedule/test/integration/redis-lock-store.ts), to
copy into your application). A job declaring `lock: true` without a store fails the boot
([`ZNIGHT043`](/reference/error-codes#znight043)).

## Dynamic jobs

`SchedulerRegistry` is injectable. It lists, triggers, pauses and reschedules the decorated jobs,
and adds jobs at runtime:

```ts
import { Injectable, type OnReady } from '@znight/core'
import { SchedulerRegistry } from '@znight/schedule'

@Injectable()
export class MonitorScheduler implements OnReady {
  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly monitors: MonitorRepository,
    private readonly prober: Prober,
  ) {}

  async onReady(): Promise<void> {
    for (const monitor of await this.monitors.all()) {
      this.registry.addInterval(`monitor.${monitor.id}`, monitor.every, ctx => this.prober.probe(monitor, ctx), {
        maxDuration: '10s',
      })
    }
  }
}
```

`registry.trigger(name)` runs a job now through the whole pipeline (overlap, lock, scope, hooks) and
resolves with the result of the run; an admin endpoint is a few lines of application code.

## Observability and testing

Every occurrence goes through the `schedule:run` hook of `@znight/core` (job, trigger, scheduled
time, outcome, error), which logs, metrics and tracing observe like HTTP requests and messages.

`TestApp` creates the job hosts at boot like controllers and consumers. Tests that do not exercise
the schedule pass `SchedulePlugin.configure({ enabled: false })` and can still run a job on demand:

```ts
import { SchedulePlugin, SchedulerRegistry } from '@znight/schedule'
import { TestApp } from '@znight/testing'

test('a manual run goes through the whole pipeline', async () => {
  await using app = await TestApp.create({
    metadata,
    plugins: [SchedulePlugin.configure({ enabled: false })],
    overrides: [[Mailer, new FakeMailer()]],
  })
  const result = await app.get(SchedulerRegistry).trigger('digest.daily')
  expect(result.outcome).toBe('completed')
})
```

A virtual clock makes time-based tests deterministic: time only moves when the test advances it,
and advancing waits for the runs it started, real I/O included (a run that makes no progress for
`settleTimeoutMs` of real time, 1 000 ms by default, is no longer waited for:
`createTestClock(start, { settleTimeoutMs })`). The test clock, a `JobContext` factory for unit tests
and the conformance scenarios of lock stores are described in the
[package README](../../packages/schedule/README.md).

## Coming from `@nestjs/schedule`

| `@nestjs/schedule`                     | `@znight/schedule`                                               |
| -------------------------------------- | ---------------------------------------------------------------- |
| `ScheduleModule.forRoot()`             | `SchedulePlugin.configure()`                                     |
| `@Cron(expr, { name, timeZone })`      | `@Cron(expr, { name, timeZone, overlap, lock, ... })`            |
| `CronExpression.EVERY_DAY_AT_MIDNIGHT` | `'@daily'` or `'0 0 * * *'`                                      |
| `@Interval('name', 10000)`             | `@Interval('10s', { name })`                                     |
| `@Timeout('name', 5000)`               | `@Timeout('5s', { name })`                                       |
| `schedulerRegistry.getCronJob(name)`   | `registry.get(name)`: `pause`, `resume`, `reschedule`, `trigger` |
| Overlapping runs, server time zone     | `overlap: 'skip'` and UTC by default                             |
| No distributed lock                    | a lock store: one runner per occurrence                          |

## Diagnostics

| Code                                            | Meaning                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`ZNIGHT040`](/reference/error-codes#znight040) | Invalid schedule: cron expression, duration, time zone, options or signature        |
| [`ZNIGHT041`](/reference/error-codes#znight041) | Two jobs share a name                                                               |
| [`ZNIGHT042`](/reference/error-codes#znight042) | Unknown job name (`jobs` override, `registry.trigger` / `remove`)                   |
| [`ZNIGHT043`](/reference/error-codes#znight043) | A job requires a lock but the plugin has no lock store                              |
| [`ZNIGHT044`](/reference/error-codes#znight044) | The reason of an aborted run's `ctx.signal` (timeout, lost lock, removal, shutdown) |
