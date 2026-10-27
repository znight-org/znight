# @znight/schedule

Cron, interval and timeout jobs for [Znight](../../README.md): the `@nestjs/schedule` model, plus what
a compile-time framework can guarantee.

- **Checked at build time**: cron expressions, durations, time zones, options, names and method
  signatures are validated by the compiler. A bad field gets a caret under the field itself.
- **One semantics**: a built-in cron engine (no dependency) is shared by the compiler and the
  runtime, on Node.js and Bun. Time zones come from `Intl`, UTC by default, with written DST rules.
- **Robust**: one timer for every job, overlapping runs skipped by default, `maxDuration` and an
  abort signal per run, graceful shutdown, epoch-aligned intervals.
- **One runner across instances**: a pluggable lock store with leases fenced by the occurrence
  time: two instances never run the same occurrence, whatever their clock skew.
- **Observable and testable**: a `schedule:run` hook (logs, metrics and spans with
  `@znight/observability`), a virtual clock and manual triggers.

```sh
bun add @znight/schedule
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). The compiler extension
(`@znight/schedule/compiler`) is loaded by `@znight/compiler` when the application imports the
package.

## Quick start

```ts
// src/digest/digest.jobs.ts
import { Cron, Interval, type JobContext, Timeout } from '@znight/schedule'

/** No @Injectable(): a class with jobs becomes a singleton provider automatically. */
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

  /** Every minute, and once at start. */
  @Interval('1m', { name: 'status-cache.refresh', runOnStart: true })
  refresh(): Promise<void> {
    return this.reports.refreshCache()
  }

  /** Once, 5 s after the scheduler started. */
  @Timeout('5s')
  warm(): void {}
}
```

```ts
// src/main.ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { SchedulePlugin } from '@znight/schedule'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  // before HttpPlugin: HTTP stops taking requests first, then running jobs are drained
  plugins: [SchedulePlugin.configure({ timeZone: 'Europe/Paris' }), HttpPlugin.configure({ port: 3000 })],
})
await app.start() // jobs start once every provider and plugin is ready; SIGTERM drains them
```

## Declaring jobs

`@Cron(expression, options?)`, `@Interval(every, options?)` and `@Timeout(delay, options?)` go on
methods of any class. Every argument is **static** (literals, `const` references, simple
expressions): values that depend on the environment go through the plugin's `jobs` option.

- A job is a **public method declared by the class itself**: inherited methods are not jobs, and job
  decorators on an abstract class are ZNIGHT005.
- The host may be any provider: `@Injectable`, `@Factory`, `@Controller`, `@Consumer`... A class
  registered by nothing becomes a **singleton** provider with constructor injection. Use
  `@Injectable({ scope: 'request' })` for one instance per run (see [Scopes](#jobcontext-and-scopes)).
- The method takes no parameter, or one `ctx: JobContext`. A promise it returns is awaited.
- A method may carry several triggers when each one has its own `name`. A method cannot be a job
  and an HTTP route or a message handler at the same time (let the job call the handler).
  Interceptor decorators (`@Intercept`, `@Logged`, `@Traced`, `@Metric`) wrap the job.
- The default name is `<Class>.<method>`. Names match `^[\w$][\w.:$-]{0,127}$` and are unique across
  the application and its libraries (ZNIGHT041).

| Option        | `@Cron` | `@Interval` | `@Timeout` | Default                                        |
| ------------- | ------- | ----------- | ---------- | ---------------------------------------------- |
| `name`        | ✓       | ✓           | ✓          | `<Class>.<method>`                             |
| `enabled`     | ✓       | ✓           | ✓          | `true` (`false`: declared, never scheduled)    |
| `lock`        | ✓       | ✓           | ✓          | `true` with a store, unless `overlap: 'allow'` |
| `maxDuration` | ✓       | ✓           | ✓          | none                                           |
| `overlap`     | ✓       | ✓           | —          | `'skip'`                                       |
| `runOnStart`  | ✓       | ✓           | —          | `false`                                        |
| `timeZone`    | ✓       | —           | —          | the plugin's `timeZone` (`'UTC'`)              |

**Durations** are milliseconds or a number with one unit: `'500ms'`, `'30s'`, `'5m'`, `'1.5h'`,
`'1d'`; a non-negative whole number of milliseconds, at most 366 days. `@Interval` and `maxDuration`
need at least 1 ms; `@Timeout(0)` runs right at start.

**Occurrences.** A cron job fires at the first matching wall-clock second after the previous one.
Intervals fire at the **multiples of `every` since the Unix epoch**, so every instance and every
restart agrees on them (a deploy every 2 hours never starves a 6-hour interval; use `@Cron` for
wall-clock alignment). A timeout fires once, `delay` after the scheduler started, then the job is
`done`. When the process wakes up late (stalled event loop, suspended laptop, clock moved forward),
a job runs **once**, for its latest missed occurrence; an occurrence never runs twice in a process.

## The cron dialect

| Field (in order)                             | Values                                | Special                                     |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| second (optional: with 6 fields; `0` with 5) | 0-59                                  |                                             |
| minute                                       | 0-59                                  |                                             |
| hour                                         | 0-23                                  |                                             |
| day of month                                 | 1-31                                  | `L` (last day), `?` (= `*`)                 |
| month                                        | 1-12, `JAN`-`DEC`                     |                                             |
| day of week                                  | 0-7 (0 and 7 are Sunday), `SUN`-`SAT` | `5L` (last Friday), `MON#2` (second Monday) |
- Each field is `*`, a value, a range `a-b`, a step `*/s`, `a-b/s` or `a/s` (from `a` to the
  maximum), or a comma-separated list of those. Names are case-insensitive. Ranges do not wrap:
  write `FRI-SUN,MON`, not `FRI-MON`.
- In the day of week, `a/s` runs up to Saturday (`1/2` is MON, WED, FRI) and `7/s` is Sunday alone.
  `SUN` closing a range is 7 (`FRI-SUN`), except after Sunday: `SUN-SUN` is Sunday, like `0-0`.
- Nicknames: `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` / `@midnight`, `@hourly`.
- **Day of month and day of week are OR-ed** when both are restricted (Vixie cron, POSIX):
  `0 0 13 * FRI` runs every 13th and every Friday.
- Not supported (with a hint): a year field, `W`, `LW`, `L-n`, `H`, `@reboot` (use
  `runOnStart: true` or `@Timeout(0)`).

The engine is public: validate user input with the rules the compiler and the scheduler use.

```ts
import { parseCron, parseDuration } from '@znight/schedule'

const schedule = parseCron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris' }) // throws InvalidScheduleError (ZNIGHT040)
schedule.next(new Date('2026-10-27T10:00:00Z')) // 2026-10-28T07:00:00.000Z
schedule.nextRuns(3) // the next three occurrences after now
schedule.matches(new Date('2026-10-28T07:00:00Z')) // true
parseDuration('1.5h') // 5_400_000
```

`InvalidScheduleError` carries `field` (`'hour'`...), `start` and `end` (offsets in the expression).
An expression that never fires (`'0 0 30 2 *'`) is invalid too.

## Time zones and daylight saving time

`timeZone` is an IANA name (`'Europe/Paris'`), `'UTC'`, a fixed offset (`'+05:30'`) or `'local'`
(the zone of the process, read once at boot). Zones are validated at build time and again at boot,
and **kept as written** (never canonicalised: Node and Bun disagree on aliases). Expressions are
evaluated on the wall clock of the zone:

| Situation                                         | Rule                                                                                                                                         | `Europe/Paris`                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A matching local time does not exist (spring gap) | It fires once, at the first instant after the gap. Occurrences falling on the same instant fire once                                         | `30 2 * * *` on 2027-03-28 fires at 03:00 CEST. `*/30 * * * *` that day: 00:30Z, 01:00Z, 01:30Z             |
| A matching local time exists twice (autumn fold)  | It fires at its **first** occurrence only, unless the hour field matches every hour (`*`, `0-23`, `*/1`): then the repeated hour fires again | `30 2 * * *` on 2026-10-25 fires once (02:30 CEST). `*/30 * * * *` that day: 00:00Z, 00:30Z, 01:00Z, 01:30Z |

A daily job never runs twice nor gets skipped on a DST day, and sub-hourly jobs keep running every N
minutes of real time. To keep a job clear of DST, schedule it outside 01:00–03:00 local time or in
UTC. `matches()` agrees with `next()`: the end of a gap is an occurrence of the wall times it skips.

Zone names may come from user input (`parseCron(expression, { timeZone })`): memory stays bounded
whatever the spellings (`Intl` accepts IANA names in any case), since every spelling of a zone shares
its data.

## Plugin configuration

```ts
SchedulePlugin.configure(container => {
  const schedule = container.get(ScheduleConfig)
  return {
    enabled: schedule.enabled, // SCHEDULE_ENABLED=false on web-only replicas
    timeZone: schedule.timeZone, // default zone of cron jobs
    lock: { store: new PostgresLockStore(container.get(Database)), ttl: '30s' }, // recipe: see below
    // per-environment schedules, validated at boot (ZNIGHT040 / ZNIGHT042)
    jobs: { 'digest.daily': { cron: schedule.digestCron } },
  }
})
```

| Option           | Default          | Description                                                                                                           |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`        | `true`           | `false`: nothing is scheduled. The registry still lists, triggers and adds jobs                                       |
| `timeZone`       | `'UTC'`          | Default zone of cron jobs                                                                                             |
| `lock`           | none             | A `ScheduleLockStore`, or `{ store, keyPrefix?, ttl?, owner? }` (key prefix `'znight:schedule:'`, ttl `'30s'`)        |
| `jobs`           | `{}`             | Overrides by job name: `enabled`, `cron`, `timeZone`, `every`, `delay`, `overlap`, `lock`, `maxDuration` (or `false`) |
| `drainTimeoutMs` | `4000`           | Maximum wait for running jobs on shutdown (`Infinity`: no limit of its own). Keep it below `shutdown.hookTimeoutMs`   |
| `clock`          | the system clock | Time source and timers (`createTestClock()` in tests)                                                                 |

Options may be a function of the container, evaluated in `onBootstrap`. The kind of a job never
changes: `cron` and `timeZone` override cron jobs, `every` intervals, `delay` timeouts; an unknown
job name is ZNIGHT042 (with a suggestion). The plugin instance (`app.getPlugin('schedule')`) exposes
`registry`, `clock` and `state` (`created`, `bootstrapped`, `running`, `stopping`, `stopped`), and
serves one running application at a time (ZNIGHT004 otherwise).

| Hook          | What happens                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `register`    | Provides `SchedulerRegistry` and the request-scoped `JobContext`                                                          |
| `onBootstrap` | Validates the options and the metadata, applies the overrides, checks locks, resolves singleton hosts, binds the registry |
| `onReady`     | Arms the scheduler (when `enabled`), runs `runOnStart` jobs, logs `Schedule: N job(s), next: <job> at <date>`             |
| `onStop`      | Stops arming, drops queued runs, aborts running runs (`shutdown`), waits up to `drainTimeoutMs`                           |
| `onDispose`   | Clears the timers, unbinds the registry                                                                                   |

Jobs start in `onReady`, once every provider started and every plugin listens: a job never runs
against a half-started application. While the scheduler runs, its timer keeps the process alive (a
worker whose only ingress is the scheduler does not exit); with `enabled: false`, no timer exists.

## JobContext and scopes

```ts
/** The current run, passed to job methods and injectable (request-scoped). */
interface JobContext {
  readonly job: string
  readonly runId: string // UUID, also in the logs and spans
  readonly trigger: 'schedule' | 'start' | 'manual' | 'queued'
  readonly scheduledAt: Date // the occurrence; use it rather than the current time
  readonly startedAt: Date // startedAt - scheduledAt is the lateness
  readonly previous: { readonly scheduledAt: Date; readonly outcome: RunOutcome } | undefined
  readonly signal: AbortSignal // maxDuration, lost lock, removal, shutdown
}
```

Each run executes in its own container scope seeded with its `JobContext`:

- a **singleton** host is resolved once, at bootstrap;
- a **request-scoped** or transient host is created in each run's scope (one instance per run) and
  disposed when the run settles; it may inject `JobContext`;
- a singleton reaches the current run through `Lazy<JobContext>` (injecting `JobContext` directly is
  ZNIGHT003);
- `HttpContext`, `RequestId` and `InboundMessage` do not exist in a run (ZNIGHT013 when resolved; a
  build warning when a request-scoped host depends on them).

```ts
import { Injectable, type Lazy } from '@znight/core'
import { Interval, type JobContext } from '@znight/schedule'

@Injectable({ scope: 'request' })
export class CatalogImport {
  constructor(
    private readonly ctx: JobContext, // seeded for each run
    private readonly importer: CatalogImporter,
  ) {}

  @Interval('15m', { name: 'catalog.import' })
  run(): Promise<void> {
    return this.importer.import({ runId: this.ctx.runId, signal: this.ctx.signal })
  }
}

@Injectable()
export class AuditTrail {
  constructor(private readonly job: Lazy<JobContext>) {}

  record(action: string): void {
    const { job, runId } = this.job.get() // resolved in the current run's scope
    console.log({ action, job, runId })
  }
}
```

## SchedulerRegistry and dynamic jobs

`SchedulerRegistry` is injectable. Static (decorated) and dynamic jobs share it.

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

  /** Providers' onReady runs before plugins' onReady: the jobs are armed when the scheduler starts. */
  async onReady(): Promise<void> {
    for (const monitor of await this.monitors.all()) this.schedule(monitor)
  }

  schedule(monitor: Monitor): void {
    this.registry.addInterval(`monitor.${monitor.id}`, monitor.every, ctx => this.prober.probe(monitor, ctx), {
      maxDuration: '10s',
    })
  }

  unschedule(id: string): void {
    if (this.registry.has(`monitor.${id}`)) this.registry.remove(`monitor.${id}`, { abort: true })
  }
}
```

| Member                                         | Description                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `jobs()`, `get(name)`, `has(name)`             | Every job, sorted by name                                                                        |
| `addCron(name, expression, handler, options?)` | Validated at once (ZNIGHT040, ZNIGHT041); armed now when the scheduler runs, else when it starts |
| `addInterval(...)`, `addTimeout(...)`          | Same, with a duration (a timeout added while running fires `delay` after the call)               |
| `remove(name, { abort? })`                     | Stops future runs and runs not started yet; a running run goes on unless `abort` (ZNIGHT042)     |
| `trigger(name)`                                | Runs the job now through the whole pipeline; never rejects for a job failure                     |
| `idle()`                                       | Resolves once no run is in flight (queued runs included)                                         |

Each `ScheduledJob` exposes `name`, `kind`, `origin`, `schedule` (`'0 8 * * MON-FRI (Europe/Paris)'`,
`'every 1m'`, `'once after 5s'`), `cron`, `timeZone`, `every`, `delay`, `overlap`, `locked`,
`maxDuration`, `state` (`scheduled`, `paused`, `disabled`, `done`, `removed`), `running`, `nextRun`,
`lastRun`, and `nextRuns(count, from?)`, `pause()`, `resume()`, `reschedule(schedule, { timeZone? })`
(same kind only) and `trigger()`. Reschedules, pauses and dynamic jobs are not persisted.

- A run **starts** when its job is called. A run that has not started yet (waiting for its lease, or
  for a `schedule:run` wrapper to call `next()`) is dropped when the job is removed or paused, or
  when the application stops: outcome `skipped`, with `aborted` when its signal was aborted, logged
  at `debug`. `pause()` also drops the queued occurrence of an `overlap: 'queue'` job. A running run
  goes on. Manual runs (`trigger()`) of a paused job still run.
- `reschedule()` arms a timeout again, `delay` from now, also from its own run (a retry):
  `registry.get('retry')?.reschedule('10s')`.

The registry is usable from the end of the plugin's `onBootstrap`: providers' `onStart` / `onReady`,
requests and runs. Earlier (a provider constructor) it throws ZNIGHT021; once the application is
stopping, `add*()` throws and `trigger()` rejects with ZNIGHT021. A manual trigger works with
`enabled: false`, runs in its own scope (never the caller's request scope, it may outlive it) and
keeps the async context of the caller (its span is a child of the request span).

An admin endpoint is plain application code:

```ts
import { Controller, Get, HttpCode, NotFoundException, Param, Post } from '@znight/http'
import { SchedulerRegistry } from '@znight/schedule'

@Controller('/admin/jobs')
export class JobsController {
  constructor(private readonly registry: SchedulerRegistry) {}

  @Get()
  list() {
    return this.registry.jobs().map(job => ({
      name: job.name,
      schedule: job.schedule,
      state: job.state,
      nextRun: job.nextRun,
      lastOutcome: job.lastRun?.outcome,
    }))
  }

  @Post('/:name/run')
  @HttpCode(202)
  run(@Param('name') name: string) {
    const job = this.registry.get(name)
    if (job === undefined) throw new NotFoundException(`Unknown job "${name}"`)
    void job.trigger() // own scope; never rejects for a job failure; the response does not wait
    return { accepted: true }
  }
}
```

## Overlap and maxDuration

| `overlap`        | An occurrence fires while a run of the same job is in flight in this process                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip` (default) | Dropped: outcome `skipped`, logged at `warn` with how long the run has been going                                                               |
| `queue`          | Kept as the single pending run (a later one replaces it, with the latest occurrence); it starts when the run settles, unless the job was paused |
| `allow`          | Runs concurrently (implies `lock: false`)                                                                                                       |

The next occurrence is armed when one fires, not when its run settles, so a slow run never delays
the schedule. `maxDuration` aborts `ctx.signal` with a `JobAbortedError` (ZNIGHT044, `reason`
`'timeout'`) but does not free the slot: JavaScript cannot kill a promise. Jobs are cooperative: pass
the signal to `fetch` and database drivers, and check it between units of work
(`ctx.signal.throwIfAborted()`). Manual triggers follow the job's policy.

## One runner across instances

Without a lock store, every instance runs every job: right for one instance and for per-instance
work (caches). With replicas, configure a store: jobs become **locked by default** (opt out with
`lock: false`). `lock: true` without store fails the boot (ZNIGHT043); `lock: true` with
`overlap: 'allow'` is ZNIGHT040.

```ts
export interface ScheduleLockStore {
  readonly name: string
  /** Claims `claim.occurrence` of `key`: only when no lease is live AND no later-or-equal occurrence was claimed. */
  acquire(key: string, claim: LockClaim): Promise<LockLease | undefined>
}
export interface LockClaim {
  readonly owner: string // <hostname>:<pid>:<random> by default
  readonly occurrence: number // epoch ms of the occurrence: strictly increasing per job
  readonly ttlMs: number
}
export interface LockLease {
  extend(ttlMs: number): Promise<boolean> // false when lost (expired, then taken)
  release(): Promise<void> // the occurrence stays claimed
}
```

**Occurrence fencing.** Two instances whose clocks differ by 300 ms both fire "09:00". The first
claims occurrence 09:00, runs and releases. The second arrives late, finds 09:00 already claimed and
is refused (outcome `not-acquired`): no `lockAtLeastFor` guesswork. `ctx.scheduledAt.getTime()` is a
free fencing token for the job's writes.

- The lease (`ttl`, default 30 s) is extended every `ttl / 3` while the run lasts. It is lost when
  `extend()` answers `false`, or `ttl` after the last successful extension, even while an extension
  hangs (a partitioned client queuing commands): the run's signal is aborted (`'lock-lost'`) when
  another instance may take the lease over.
- A store failure fails closed: no lease, no run (outcome `failed`). So does an `acquire()` that
  does not answer within `ttl` (a lease granted later is released at once). A `release()` that does
  not answer within `ttl` is logged at `warn` and the job is free again: the lease expires.
- What it does not guarantee: that an occurrence runs if the instance holding it crashes (at most
  once, no catch-up), or "once per period" for `@Timeout` and `runOnStart` runs (their occurrence is
  per process).

`memoryLockStore({ clock? })` works within one process (tests, several applications in one process).
Two recipes are tested on a real server with `ZNIGHT_INTEGRATION=1` (copy them into your
application): the Postgres store
[`test/integration/postgres-lock-store.ts`](./test/integration/postgres-lock-store.ts) (one atomic
upsert per claim, any client through a `query(sql, params)` port) and the Redis store
[`test/integration/redis-lock-store.ts`](./test/integration/redis-lock-store.ts). Check a custom
store with the conformance scenarios:

```ts
import { lockStoreScenarios } from '@znight/schedule/testing'

for (const scenario of lockStoreScenarios) {
  test(`PostgresLockStore: ${scenario.name}`, () => scenario.run(() => new PostgresLockStore(db)))
}
```

## Graceful shutdown

On `stop()` (SIGTERM, SIGINT): the timer is disarmed and queued runs are dropped; every running
run's signal is aborted with `'shutdown'` **at once**, so jobs can checkpoint and return early; the
plugin waits until every run settled, or `drainTimeoutMs`. Runs still in flight are **abandoned**
(logged at `warn`): their leases are not released but stop being extended, so no other instance
starts the job while the abandoned run may still be writing. A `stop()` called from inside a run
does not wait for that run. List `SchedulePlugin` before `HttpPlugin`: HTTP drains first (manual
triggers included), then the scheduler, within the default 10 s shutdown budget.

## Observability

Every occurrence goes through the `schedule:run` hook of `@znight/core` (`ScheduledRunEvent`):
executed runs are wrapped with `hooks.run()`, then every occurrence is emitted (`skipped`,
`not-acquired` and lock store failures are only emitted). A wrapper that does not call `next()`
vetoes the run (outcome `skipped`: feature flags, maintenance windows). `@znight/observability` turns
it into one log entry per run, `schedule_*` metrics and a span per run; its logger adds `job` and
`runId` to every entry written inside a run. Failures are logged by the scheduler at `error` with
`err`; when a `schedule:run` wrapper is installed, with the message only (the observer logs the
stack once).

## Testing

```ts
// Unit test: the job is a method; TestBed builds the class with auto-mocked dependencies.
import { createJobContext } from '@znight/schedule/testing'
import { TestBed } from '@znight/testing'

test('the daily digest mails the report of the previous day', async () => {
  const { instance, mocks } = await TestBed.create(DigestJobs, { metadata })
  mocks.get(ReportService).build.mockResolvedValue({ checks: 42, incidents: [] })

  await instance.sendDaily(createJobContext({ scheduledAt: new Date('2027-03-26T07:00:00Z') }))

  expect(mocks.get(Mailer).send).toHaveBeenCalledTimes(1)
})
```

```ts
// Schedule test: the real plugin on virtual time. Time only moves when the test advances it.
import { SchedulePlugin, SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'
import { TestApp } from '@znight/testing'

test('the digest follows Paris time across the DST switch', async () => {
  const clock = createTestClock('2027-03-26T06:00:00Z') // Friday 07:00 in Paris (CET)
  const mailer = new FakeMailer()
  await using app = await TestApp.create({
    metadata,
    plugins: [SchedulePlugin.configure({ clock })],
    overrides: [[Mailer, mailer]],
  })

  await clock.advanceTo('2027-03-29T07:00:00Z') // Monday 09:00 in Paris (CEST)

  expect(mailer.sent).toHaveLength(2) // Friday 07:00Z and Monday 06:00Z, none on the weekend
  expect(app.get(SchedulerRegistry).get('digest.daily')?.nextRun?.toISOString()).toBe('2027-03-30T06:00:00.000Z')
})
```

- `createTestClock(start = '2026-01-01T00:00:00Z', { settleTimeoutMs? })`: `now()`, `date`,
  `advance(duration)`, `advanceTo(date)` (fire the due timers in order and wait for the runs they
  start, real I/O included: no sleep needed), `setWallClock(date)` (a clock jump: timers keep their
  delays), `settle()`. A run that makes no progress for `settleTimeoutMs` of real time (default
  1000) is not waited for again during that call: it waits for a later timer (its `maxDuration`) or
  for the test. Lower it in tests that keep runs pending on purpose. Pass the clock to
  `memoryLockStore({ clock })` too to expire leases in virtual time.
- `createJobContext(init?)`: a `JobContext` for unit tests, with an `abort(reason)` helper.
- `TestApp` creates the job hosts at boot (they are entry points, like controllers and consumers).
  Tests that do not exercise the schedule pass `enabled: false`; with a test clock, time never moves
  by itself, but `runOnStart` jobs and `@Timeout(0)` still run at start (`await registry.idle()`).
- `registry.trigger(name)` runs a job through the whole pipeline (scope, lock, hooks), even with
  `enabled: false`.

## Diagnostics

| Code      | When                                                                                                                                                        | Reported                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| ZNIGHT040 | Invalid schedule: cron syntax, range, never fires, `@reboot`; duration; time zone; options; job name; method signature; plugin options, overrides, metadata | build, startup, runtime |
| ZNIGHT040 | Warning: `'* 9 * * *'` (every minute of an hour), a bare number below 100 for `@Interval` / `maxDuration`, a request-scoped host depending on `HttpContext` | build                   |
| ZNIGHT041 | Two jobs share a name (application, source and compiled libraries, dynamic jobs)                                                                            | build, startup, runtime |
| ZNIGHT042 | No job has this name: a `jobs` override (with a suggestion), `registry.trigger` / `remove`                                                                  | startup, runtime        |
| ZNIGHT043 | A job requires a lock (`lock: true`) but the plugin has no store                                                                                            | startup, runtime        |
| ZNIGHT044 | `ctx.signal.reason` of an aborted run (`JobAbortedError`: `timeout`, `lock-lost`, `removed`, `shutdown`); never thrown by the framework                     | runtime                 |
| ZNIGHT005 | Method shape (static, private, accessor, generator, computed name), abstract or generic host, decorator not called, route + job, parameter decorator        | build                   |
| ZNIGHT003 | A singleton host injects `JobContext` directly (use `Lazy<JobContext>` or the `ctx` parameter)                                                              | build                   |
| ZNIGHT021 | The registry is used before the bootstrap or once the application is stopping                                                                               | runtime                 |

```text
✗ ZNIGHT040: Invalid cron expression for job 'digest.daily': hour 24 is out of range (0-23)
  --> src/digest/digest.jobs.ts:14:12
   |
14 |   @Cron('0 24 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris' })
   |            ^^
   = hint: Fields: [second] minute hour day-of-month month day-of-week
```

## Compiler contract

The extension owns `@znight/schedule#Cron`, `#Interval` and `#Timeout` (methods, two static
arguments), declares every host with `AnalyzeContext.addRoot()` (a root of ZNIGHT019 and `prune`,
auto-registered as a singleton when nothing else registers it, recorded in compiled libraries) and
generates `metadata.extensions.schedule`:

```ts
{
  jobs: [ // sorted by name; options equal to their default are omitted
    {
      name: 'digest.daily',
      token: 'src/digest/digest.jobs.ts#DigestJobs',
      method: 'sendDaily',
      kind: 'cron',
      cron: '0 8 * * MON-FRI', // as written, whitespace collapsed; nicknames kept
      timeZone: 'Europe/Paris', // as written
      maxDuration: 600000,
      invoke: (c: DigestJobs, j: JobContext) => c.sendDaily(j),
    },
  ],
}
```

`SchedulePlugin` validates the section at boot (it may be hand-written): shapes, names, expressions
and zones with the runtime's `Intl`, host tokens (ZNIGHT001 naming the job).

## Coming from `@nestjs/schedule`

| `@nestjs/schedule`                                          | `@znight/schedule`                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ScheduleModule.forRoot()`                                  | `SchedulePlugin.configure()`                                                         |
| `@Cron(expr, { name, timeZone, utcOffset, disabled, ... })` | `@Cron(expr, { name, timeZone, enabled, overlap, lock, maxDuration, runOnStart })`   |
| `CronExpression.EVERY_DAY_AT_MIDNIGHT`                      | `'@daily'` or `'0 0 * * *'`                                                          |
| `@Interval('name', 10000)` / `@Timeout('name', 5000)`       | `@Interval('10s', { name })` / `@Timeout('5s', { name })`                            |
| `schedulerRegistry.getCronJob(name)`                        | `registry.get(name)`: `pause`, `resume`, `reschedule`, `trigger`, `nextRuns`         |
| `addCronJob`, `addInterval`, `addTimeout`, `delete*`        | `addCron(name, expr, handler)`, `addInterval`, `addTimeout`, `remove(name)`          |
| Overlapping runs, server time zone, no lock, errors at boot | `overlap: 'skip'`, UTC, occurrence-fenced locks, ZNIGHT040–043 at build time or boot |

## Limitations

- No durable jobs: no persistence, history, retries or catch-up of occurrences missed while the
  process was down (publish a message from the job for retries: `@znight/messaging`).
- No `W`, `LW`, `L-n`, year field or `H`; no fixed-delay intervals, jitter or global concurrency cap.
- Jobs are not inherited from base classes.
- Lock stores for Redis and Postgres are recipes, not subpaths of the package.
