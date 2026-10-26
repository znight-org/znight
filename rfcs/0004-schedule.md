# RFC 0004: `@znight/schedule`, task scheduling

|          |                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status   | Proposed                                                                                                                                                                                                                                                                                                                                         |
| Date     | 2026-10-27                                                                                                                                                                                                                                                                                                                                       |
| Affects  | New package `@znight/schedule`. Prerequisites in `@znight/core` (error codes, one hook), `@znight/compiler` (one extension API method), `@znight/testing` (TestApp roots). Follow-ups in `@znight/observability` and `@znight/cli`. Docs, a wave 7 example                                                                                       |
| Decision | Ship `@znight/schedule` in v0.1: `@Cron` / `@Interval` / `@Timeout`, `SchedulerRegistry`, `SchedulePlugin`. A **built-in** cron engine shared by the compiler and the runtime, time zones through `Intl`, UTC by default. Overlap `skip` by default. Single runner across instances through a pluggable lock store with occurrence-fenced leases |

## 1. Summary

Znight gets the scheduling API NestJS users know, plus the guarantees only a compile-time framework
can give:

```ts
import { Cron, type JobContext } from '@znight/schedule'

export class DigestJobs {
  constructor(
    private readonly reports: ReportService,
    private readonly mailer: Mailer,
  ) {}

  /** 08:00 in Paris, Monday to Friday, on one instance of the fleet. */
  @Cron('0 8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
  async sendDaily(ctx: JobContext): Promise<void> {
    const report = await this.reports.build({ until: ctx.scheduledAt, signal: ctx.signal })
    await this.mailer.send(digestEmail(report))
  }
}
```

1. **Declarative jobs.** `@Cron(expression, options?)`, `@Interval(every, options?)` and
   `@Timeout(delay, options?)` go on methods of any class. A class that is not a provider yet
   becomes a singleton provider, as guards do today. Jobs can also be added at runtime through the
   injectable `SchedulerRegistry`.
2. **Checked at build time.** `@znight/schedule/compiler` validates cron expressions, durations,
   time zones, options, names and method signatures. A bad field gets a caret under the field
   itself. New codes ZNIGHT030 to ZNIGHT034; the block ZNIGHT030–039 is reserved for the package.
3. **A built-in cron engine, no dependency.** One import-free module is used by the compiler and
   by the runtime, so the build and the process agree on every expression. It supports 5 or 6
   fields, names, nicknames, `L` and `#`, and IANA time zones through `Intl` (Node 24 has no
   `Temporal`). DST behaviour is specified. The default time zone is UTC.
4. **A robust runtime.** One timer serves every job and resyncs with the wall clock at least every
   60 s. Intervals are aligned on the Unix epoch, so restarts and rolling deploys never starve a
   long interval. Overlapping runs are skipped by default. `maxDuration` and `ctx.signal` bound
   runs. Shutdown aborts and drains running jobs. The process stays alive while the scheduler runs.
5. **One runner across instances.** A `ScheduleLockStore` interface with leases fenced by the
   occurrence time: two instances never run the same occurrence, even with clock skew, without
   ShedLock's `lockAtLeastFor` guesswork. Once a store is configured, jobs are locked by default.
   v0.1 ships `memoryLockStore()`, conformance scenarios for custom stores, and Postgres and Redis
   recipes that are tested and included in the guide as is.
6. **Observable and testable.** A `schedule:run` hook in `@znight/core` feeds
   `@znight/observability` (logs, metrics, spans). A virtual clock and `registry.trigger()` make
   tests deterministic.

Three small prerequisites live outside the package (P0): the error codes and the hook in core;
`AnalyzeContext.addRoot()` in the compiler, because an `@Injectable` class used only by its `@Cron`
method is otherwise reported unused (ZNIGHT019) and **dropped by `prune`**; job hosts as default
`TestApp` roots.

## 2. What exists today (checked against the code and the runtimes)

| Fact                                                                                                                                                                                                                                                      | Where                                                                      | Consequence                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A feature package is marker decorators, a compiler extension (`analyzeClass` / `validate` / `generate`) and a plugin. Messaging validates static options at build time (`@Retry`), stores normalised data and generates one `invoke` per handler          | `packages/messaging/src/compiler/*`, architecture §1.4, §6.5               | Same layout. `@Retry`'s "mirror the runtime normalisation at build time" approach becomes "share the engine"                                               |
| Roots of ZNIGHT019 and `prune` are providers registered by an extension, providers with `onStart`/`onReady`/`onStop`, and classes referenced as values                                                                                                    | `packages/compiler/src/validation/unused.ts:47-71`                         | An `@Injectable` class whose only entry point is a `@Cron` method is "unused" and removed by `prune`. The compiler needs a way to declare roots (§5.5)     |
| Reachability is computed before extension `validate` runs                                                                                                                                                                                                 | `packages/compiler/src/analyze.ts:186-228`                                 | Roots must be declared during `analyzeClass`                                                                                                               |
| `registerProvider` on a class already registered is ZNIGHT005. `resolveClassRef` auto-registers helper classes as singletons, after every extension has analysed                                                                                          | `packages/compiler/src/extensions/contexts.ts:86-121`, `analyze.ts` step 4 | A job host may already be an `@Injectable`, a `@Controller` or a `@Consumer`. Registration has to be deferred like class refs                              |
| Hook names and event types live in core (`ZnightHooks`), so producers and observers share them                                                                                                                                                            | `packages/core/src/hooks.ts`, architecture §8.3                            | `schedule:run` and `ScheduledRunEvent` go to core                                                                                                          |
| `ErrorCode` is a closed `as const` in core, shared by compiler and runtime. ZNIGHT022 is the last code; RFC 0001 proposes ZNIGHT023                                                                                                                       | `packages/core/src/errors.ts`                                              | New codes are added to core                                                                                                                                |
| Code shared by a compiler entry and the runtime lives in import-free modules (`@znight/http` `path.ts`, `@znight/config` `conventions.ts`)                                                                                                                | architecture §2 "Boundaries"                                               | The cron engine is such a module                                                                                                                           |
| The static evaluator cannot read package constants from `.d.ts` files                                                                                                                                                                                     | `packages/http/README.md` "Route decorators"                               | No NestJS-style `CronExpression` enum: nicknames instead (`@daily`)                                                                                        |
| Messaging keeps the process alive while consumers run and aborts `message.signal` on stop                                                                                                                                                                 | `packages/messaging/src/plugin.ts`                                         | Same behaviour for the scheduler                                                                                                                           |
| `container.runInScope()` opens a fresh scope. An unseeded request-scoped external throws ZNIGHT013                                                                                                                                                        | `packages/core/src/container.ts:684`, `container-errors.ts`                | One scope per run, seeded with `JobContext`. `HttpContext` does not exist in a job                                                                         |
| `TestApp` instantiates by default the closure of HTTP controllers and message consumers                                                                                                                                                                   | `packages/testing/src/test-app.ts`, `extensions.ts`                        | Job hosts must be added                                                                                                                                    |
| Node.js 24.21: no `Temporal`. `setTimeout(fn, 2 ** 31)` prints `TimeoutOverflowWarning` and fires after **1 ms**                                                                                                                                          | verified locally                                                           | No Temporal. Timer delays must be capped                                                                                                                   |
| Bun 1.4.4: `Temporal` exists. `Bun.cron(path, …)` registers OS-level jobs. `Bun.cron.parse()` accepts 5 fields only, in the local zone, without seconds, `L` or `#`, and returns `null` when an expression never fires                                    | verified locally                                                           | Bun's API cannot be the engine (Bun only, no zones). It is a possible future deployment target                                                             |
| Node (ICU 78.3, tzdata 2026c) and Bun (ICU 78.1) give the same DST transitions for Europe/Paris 2026–2027 and for Pacific/Apia's skipped 2011-12-30. They canonicalise aliases differently: Node turns `US/Eastern` into `America/New_York`, Bun keeps it | verified locally                                                           | `Intl` is a sound base on both runtimes. Generated code must keep zones as written, because the golden test requires byte-identical output on Node and Bun |
| `docs/guide/plugins.md` illustrates plugins with a fictional `SchedulerPlugin` (`name: 'scheduler'`, hook `scheduler:tick`); the core README with a `CronPlugin`                                                                                          | docs                                                                       | Rename them (`HeartbeatPlugin`) to avoid confusion with the real package                                                                                   |

## 3. Goals and non-goals

**Goals**

- **G1. NestJS parity.** `@Cron`, `@Interval`, `@Timeout` and a `SchedulerRegistry`, with the
  same mental model, so a NestJS user is productive in minutes (§4.9).
- **G2. Fail at build time.** Every mistake visible in the source is a located diagnostic: syntax,
  ranges, expressions that never fire, units, zones, options, names, signatures.
- **G3. One semantics.** The same engine answers at build time and at run time, on Node 24 and
  Bun.
- **G4. Predictable time.** An explicit zone per job, UTC by default, written DST rules, no drift.
- **G5. Robust in production.** Overlapping runs, hung jobs, event-loop stalls, clock jumps,
  suspended laptops, restarts, rolling deploys, replicas and SIGTERM all have defined behaviour.
- **G6. Cheap.** No runtime dependency, no work when there is no job, one timer whatever the
  number of jobs.
- **G7. Deterministic tests.** A virtual clock, manual triggers, `TestBed` and `TestApp` support.

**Non-goals (v0.1)**

- Durable jobs: persistence, history, retries with backoff, catch-up of occurrences missed while
  the process was down, misfire policies beyond "a late occurrence runs once". A job that needs
  retries publishes a message (`@znight/messaging` retries and dead-letters it).
- Lock store adapters for Redis or Postgres in the package (interface, memory store and recipes
  only, §11 Q6).
- Leader election, cluster membership.
- Quartz extras: `W`, `LW`, `L-n`, a year field, `H`. `@reboot` (use `runOnStart`).
- Jobs inherited from base classes (like HTTP routes, §11 Q4).
- Fixed-delay intervals, jitter, a global concurrency cap (§11 Q8).
- OS-level scheduling (crontab, `Bun.cron`, Kubernetes CronJob).
- Precision better than the event loop allows. Lateness is measured and observable, not
  prevented.

## 4. User-facing API

### 4.1 Declaring jobs

```ts
import { Injectable, type Lazy } from '@znight/core'
import { Cron, Interval, type JobContext, Timeout } from '@znight/schedule'

/** No @Injectable(): a class with jobs becomes a singleton provider automatically. */
export class StatusCache {
  #snapshot: StatusSnapshot | undefined

  constructor(private readonly monitors: MonitorRepository) {}

  /** Every instance keeps its own cache: opt out of the lock. */
  @Interval('1m', { name: 'status-cache.refresh', lock: false, runOnStart: true })
  async refresh(): Promise<void> {
    this.#snapshot = await this.monitors.snapshot()
  }

  get snapshot(): StatusSnapshot | undefined {
    return this.#snapshot
  }
}

export class OutboxJobs {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly broker: MessageBroker,
  ) {}

  /** 6 fields: every 10 seconds. A tick that fires during a run is queued, at most one. */
  @Cron('*/10 * * * * *', { name: 'outbox.flush', overlap: 'queue', maxDuration: '30s' })
  async flush(ctx: JobContext): Promise<void> {
    for (const batch of await this.outbox.pendingBatches()) {
      ctx.signal.throwIfAborted() // checkpoint: shutdown, maxDuration or lost lease
      await this.broker.publishAll(batch)
    }
  }

  /** Once per process, 5 s after the scheduler started. */
  @Timeout('5s', { name: 'outbox.recover', lock: false })
  recover(): Promise<void> {
    return this.outbox.releaseStaleClaims()
  }

  /** Several triggers on one method: each needs its own name. */
  @Cron('0 9 * * MON-FRI', { name: 'standup.weekdays' })
  @Cron('0 11 * * SAT,SUN', { name: 'standup.weekend' })
  remind(): void {}
}

/** A request-scoped host: one instance per run, disposed when the run settles. */
@Injectable({ scope: 'request' })
export class CatalogImport {
  constructor(
    private readonly ctx: JobContext, // request-scoped external, seeded for each run
    private readonly importer: CatalogImporter,
  ) {}

  @Interval('15m', { name: 'catalog.import' })
  run(): Promise<void> {
    return this.importer.import({ runId: this.ctx.runId, signal: this.ctx.signal })
  }
}

/** A singleton reaching the current run deep in a call chain. */
@Injectable()
export class AuditTrail {
  constructor(
    private readonly job: Lazy<JobContext>,
    private readonly log: AuditLog,
  ) {}

  record(action: string): void {
    const { job, runId } = this.job.get() // resolved in the current run's scope
    this.log.write({ action, job, runId })
  }
}
```

Rules:

- A job is a method **declared by the class itself**. Methods inherited from a base class are not
  jobs, and job decorators on an abstract class are ZNIGHT005 (§11 Q4).
- The host class may be any provider: `@Injectable`, `@Factory`, `@Controller`, `@Consumer`... A
  class registered by nothing becomes a singleton provider with constructor injection, like a guard.
  Use `@Injectable({ scope })` for another scope.
- Host scopes: a `singleton` host is resolved once, at bootstrap. A `request` or `transient` host is
  resolved in each run's scope, so each run gets a fresh instance.
- The method takes no parameter, or one `ctx: JobContext`. Its result is awaited when it is a
  promise.
- A method may carry several triggers when each one has its own `name`. A method cannot be a job
  and an HTTP route or a message handler at the same time.
- The default name is `<Class>.<method>` (`OutboxJobs.flush`). Names match
  `^[\w$][\w.:$-]{0,127}$` and are unique across the application and its libraries.

### 4.2 Options

```ts
/** Milliseconds, or a number with one unit: '500ms', '30s', '5m', '1.5h', '1d'. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

/** What happens when an occurrence fires while the previous run of the job still runs. */
export type OverlapPolicy = 'skip' | 'queue' | 'allow'

export interface JobOptions {
  /** Unique name (logs, metrics, lock keys, registry). Default `<Class>.<method>`. */
  readonly name?: string
  /** `false`: declared, listed by the registry, never scheduled (enable it with the plugin's `jobs` option). Default `true`. */
  readonly enabled?: boolean
  /** Run on one instance only, through the plugin's lock store (§4.7). Default: `true` when a store is configured and `overlap` is not `'allow'`. */
  readonly lock?: boolean
  /** Aborts `ctx.signal` after this duration (the run keeps its overlap slot until it settles). Default: none. */
  readonly maxDuration?: Duration
}

export interface CronOptions extends JobOptions {
  /** IANA name, 'UTC', a fixed offset ('+05:30') or 'local'. Default: the plugin's `timeZone` ('UTC'). */
  readonly timeZone?: string
  readonly overlap?: OverlapPolicy // default 'skip'
  /** Also run once when the scheduler starts. Default `false`. */
  readonly runOnStart?: boolean
}

export interface IntervalOptions extends JobOptions {
  readonly overlap?: OverlapPolicy // default 'skip'
  readonly runOnStart?: boolean // default false
}

export type TimeoutOptions = JobOptions

export function Cron(expression: string, options?: CronOptions): JobMethodMarker
export function Interval(every: Duration, options?: IntervalOptions): JobMethodMarker
export function Timeout(delay: Duration, options?: TimeoutOptions): JobMethodMarker

/** Type-checks the decorated method: `(ctx: JobContext) => unknown` (a method without parameter fits). */
export type JobMethodMarker = <F extends (ctx: JobContext) => unknown>(
  target: object,
  propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext<unknown, F>,
  descriptor?: TypedPropertyDescriptor<F>,
) => void
```

All arguments are **static** (literals, `const` references, simple expressions: architecture §4.6).
Values that depend on the environment go through the plugin's `jobs` option (§4.5), validated at
boot.

| Option        | `@Cron` | `@Interval` | `@Timeout` | Default                                        |
| ------------- | ------- | ----------- | ---------- | ---------------------------------------------- |
| `name`        | ✓       | ✓           | ✓          | `<Class>.<method>`                             |
| `enabled`     | ✓       | ✓           | ✓          | `true`                                         |
| `lock`        | ✓       | ✓           | ✓          | `true` with a store, unless `overlap: 'allow'` |
| `maxDuration` | ✓       | ✓           | ✓          | none                                           |
| `overlap`     | ✓       | ✓           | —          | `'skip'`                                       |
| `runOnStart`  | ✓       | ✓           | —          | `false`                                        |
| `timeZone`    | ✓       | —           | —          | plugin `timeZone`, `'UTC'`                     |

Durations: a non-negative integer number of milliseconds once converted, at most 366 days.
`@Interval` and `maxDuration` need at least 1 ms, `@Timeout(0)` runs right at start.

### 4.3 The cron dialect

| Field (in order)                                     | Values                                | Special                                                                 |
| ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| second (optional: present with 6 fields, `0` with 5) | 0-59                                  |                                                                         |
| minute                                               | 0-59                                  |                                                                         |
| hour                                                 | 0-23                                  |                                                                         |
| day of month                                         | 1-31                                  | `L` (last day), `?` (= `*`)                                             |
| month                                                | 1-12, `JAN`-`DEC`                     |                                                                         |
| day of week                                          | 0-7 (0 and 7 are Sunday), `SUN`-`SAT` | `<day>L` (last Friday: `5L`), `<day>#<n>` (second Monday: `MON#2`), `?` |
- Each field is `*`, a value, a range `a-b`, a step `*/s`, `a-b/s` or `a/s` (from `a` to the
  maximum), or a comma-separated list of those. Names are case-insensitive. Ranges do not wrap:
  `FRI-MON` is an error, write `FRI-SUN,MON`.
- Nicknames: `@yearly` / `@annually` (`0 0 1 1 *`), `@monthly` (`0 0 1 * *`), `@weekly`
  (`0 0 * * 0`), `@daily` / `@midnight` (`0 0 * * *`), `@hourly` (`0 * * * *`).
- **Day of month and day of week are OR-ed** when both are restricted, as in Vixie cron and POSIX:
  `0 0 13 * FRI` runs every 13th **and** every Friday. A field is restricted when it is anything but
  `*` or `?`.
- Errors with a hint: 7 fields (year), `W`, `LW`, `L-n`, `H`, `?` outside the day fields, a step of
  0, a reversed range, `@reboot` ("use `runOnStart: true` or `@Timeout(0)`").

The engine is public, so applications can validate user input with the same rules (the example
validates monitor schedules with it):

```ts
import { parseCron, parseDuration } from '@znight/schedule'

const schedule = parseCron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris' }) // throws InvalidScheduleError (ZNIGHT030)
schedule.next(new Date('2026-10-27T10:00:00Z')) // 2026-10-28T07:00:00.000Z
schedule.nextRuns(3) // the next three occurrences after now
schedule.matches(new Date('2026-10-28T07:00:00Z')) // true
parseDuration('1.5h') // 5_400_000
```

`InvalidScheduleError` carries `field` (`'hour'`...), `start` and `end` (offsets in the expression),
which the compiler turns into a precise location.

### 4.4 Time zones and daylight saving time

- `timeZone` accepts an IANA name (`Europe/Paris`), `UTC`, a fixed offset (`+05:30`, accepted by
  `Intl` on Node 24 and Bun, verified) or `local`, the zone of the process (`TZ` or the system),
  read once at boot. A cron job without `timeZone` uses the plugin's `timeZone`, `'UTC'` by default.
  Intervals and timeouts are durations: zones do not apply.
- Expressions are evaluated on the **wall clock** of the zone. DST rules (normative):

| Situation                                         | Rule                                                                                                                                                               | `Europe/Paris` examples                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| A matching local time does not exist (spring gap) | The occurrence fires once, at the first instant after the gap. Occurrences that fall on the same instant fire once                                                 | `30 2 * * *` on 2027-03-28 fires at 03:00 CEST (01:00Z). `*/30 * * * *` that day: 00:30Z, 01:00Z, 01:30Z (real time stays regular) |
| A matching local time exists twice (autumn fold)  | It fires at its **first** occurrence only, unless the hour field matches every hour (`*`, `0-23`, `*/1`): then minutes and seconds of the repeated hour fire again | `30 2 * * *` on 2026-10-25 fires once, at 02:30 CEST (00:30Z). `*/30 * * * *` that day fires at 00:00Z, 00:30Z, 01:00Z, 01:30Z     |

Consequences: a daily job never runs twice nor gets skipped on a DST day, and sub-hourly jobs
keep running every N minutes of real time. These are the rules of Vixie cron. To keep a job
clear of DST, schedule it outside 01:00–03:00 local time or in UTC.
- Zones are validated at build time with the compiler's `Intl`, and again at boot with the
  runtime's (ICU versions differ, §2). A zone is kept **as written**, in the metadata and in the
  registry: it is never canonicalised (Node and Bun disagree on aliases).

### 4.5 Plugin configuration

```ts
// src/main.ts
import { ConfigPlugin } from '@znight/config'
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { ObservabilityPlugin } from '@znight/observability'
import { SchedulePlugin } from '@znight/schedule'

import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'
import { ScheduleConfig } from './config/schedule.config.js'
import { Database } from './db/database.js'
import { PostgresLockStore } from './schedule/postgres-lock-store.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
    ObservabilityPlugin.configure({ logging: { jobs: true } }),
    ConfigPlugin.configure(),
    // Before HttpPlugin: plugins stop in reverse order, so HTTP stops taking requests (manual
    // triggers included) first, then running jobs are drained.
    SchedulePlugin.configure(container => {
      const schedule = container.get(ScheduleConfig)
      return {
        enabled: schedule.enabled, // SCHEDULE_ENABLED=false on web-only replicas
        timeZone: schedule.timeZone, // default zone of cron jobs
        lock: { store: new PostgresLockStore(container.get(Database)), ttl: '30s' },
        // per-environment schedules, validated at boot (ZNIGHT030 / ZNIGHT032)
        jobs: { 'digest.daily': { cron: schedule.digestCron } },
      }
    }),
    HttpPlugin.configure(() => ({ adapter: honoAdapter(), port: 3000 })),
  ],
  shutdown: { timeoutMs: 10_000, hookTimeoutMs: 5_000 },
})
await app.start()
```

```ts
export interface SchedulePluginOptions {
  /** `false`: nothing is scheduled. The registry still lists, triggers and adds jobs. Default `true`. */
  readonly enabled?: boolean
  /** Default zone of cron jobs. Default `'UTC'`. */
  readonly timeZone?: string
  /** Lock store for single-runner jobs, or the store with its settings. Default: none. */
  readonly lock?: ScheduleLockStore | ScheduleLockOptions
  /** Per-job overrides, by job name. */
  readonly jobs?: Readonly<Record<string, JobOverride>>
  /** Maximum wait for running jobs on shutdown, in ms; keep it below `shutdown.hookTimeoutMs`. `Infinity`: no limit of its own. Default 4000. */
  readonly drainTimeoutMs?: number
  /** Time source and timers. Default: the system clock. Tests: `createTestClock()`. */
  readonly clock?: ScheduleClock
}

export interface ScheduleLockOptions {
  readonly store: ScheduleLockStore
  /** Default `'znight:schedule:'`. */
  readonly keyPrefix?: string
  /** Lease duration, renewed every third of it while the run lasts. At least 1 s. Default `'30s'`. */
  readonly ttl?: Duration
  /** This process in the store. Default `<hostname>:<pid>:<8 random hex>`. */
  readonly owner?: string
}

/** The kind of a job never changes: `cron` and `timeZone` apply to cron jobs, `every` to intervals, `delay` to timeouts. */
export interface JobOverride {
  readonly enabled?: boolean
  readonly cron?: string
  readonly timeZone?: string
  readonly every?: Duration
  readonly delay?: Duration
  readonly overlap?: OverlapPolicy
  readonly lock?: boolean
  readonly maxDuration?: Duration | false
}
```

Options may be a function of the container (`PluginOptions`), evaluated in `onBootstrap` like every
feature plugin (§8.2). The instance (`app.getPlugin<SchedulePluginInstance>('schedule')`) exposes
`registry`, `clock` and `state` (`created`, `bootstrapped`, `running`, `stopping`, `stopped`). Like
`HttpPlugin`, an instance serves one running application at a time (ZNIGHT004 otherwise).

### 4.6 `JobContext`, `SchedulerRegistry` and dynamic jobs

```ts
/** The current run. Passed to job methods, and injectable as a request-scoped external. */
export interface JobContext {
  readonly job: string
  /** UUID of the run, also in the logs and spans. */
  readonly runId: string
  /** 'schedule' (its occurrence), 'start' (runOnStart), 'manual' (trigger()), 'queued' (overlap: 'queue'). */
  readonly trigger: RunTrigger
  /** The occurrence the run stands for, on the scheduler clock; the call time for a manual run. */
  readonly scheduledAt: Date
  /** When the run started; `startedAt - scheduledAt` is the lateness. */
  readonly startedAt: Date
  /** The previous executed run of the job in this process. */
  readonly previous: { readonly scheduledAt: Date; readonly outcome: RunOutcome } | undefined
  /**
   * Aborted when `maxDuration` is exceeded, the lock lease is lost, the job is removed with
   * `{ abort: true }` or the application stops. `signal.reason` is a `JobAbortedError` (ZNIGHT034)
   * whose `reason` is 'timeout' | 'lock-lost' | 'removed' | 'shutdown'.
   */
  readonly signal: AbortSignal
}

export type RunTrigger = 'schedule' | 'start' | 'manual' | 'queued'
export type RunOutcome = 'completed' | 'failed' | 'skipped' | 'not-acquired'
export type JobHandler = (ctx: JobContext) => unknown

/** Injectable. Static (decorated) and dynamic jobs share it. */
export abstract class SchedulerRegistry {
  /** Every job, sorted by name. */
  abstract jobs(): readonly ScheduledJob[]
  abstract get(name: string): ScheduledJob | undefined
  abstract has(name: string): boolean
  /** Validated at once (ZNIGHT030, ZNIGHT031); armed now when the scheduler runs, else when it starts. */
  abstract addCron(
    name: string,
    expression: string,
    handler: JobHandler,
    options?: Omit<CronOptions, 'name'>,
  ): ScheduledJob
  abstract addInterval(
    name: string,
    every: Duration,
    handler: JobHandler,
    options?: Omit<IntervalOptions, 'name'>,
  ): ScheduledJob
  abstract addTimeout(
    name: string,
    delay: Duration,
    handler: JobHandler,
    options?: Omit<TimeoutOptions, 'name'>,
  ): ScheduledJob
  /** Stops future runs; a running run goes on unless `abort`. Unknown name: ZNIGHT032. */
  abstract remove(name: string, options?: { readonly abort?: boolean }): void
  /** `get(name).trigger()`; unknown name: ZNIGHT032. */
  abstract trigger(name: string): Promise<JobRunResult>
  /** Resolves once no run is in flight. */
  abstract idle(): Promise<void>
}

export interface ScheduledJob {
  readonly name: string
  readonly kind: 'cron' | 'interval' | 'timeout'
  readonly origin: 'decorator' | 'dynamic'
  /** Human-readable: '0 8 * * MON-FRI (Europe/Paris)', 'every 1m', 'once after 5s'. */
  readonly schedule: string
  readonly cron: string | undefined
  readonly timeZone: string | undefined // as written; the effective zone for cron jobs
  readonly every: number | undefined
  readonly delay: number | undefined
  readonly overlap: OverlapPolicy
  readonly locked: boolean
  readonly maxDuration: number | undefined
  readonly state: 'scheduled' | 'paused' | 'disabled' | 'done' | 'removed'
  /** Runs in flight in this process. */
  readonly running: number
  readonly nextRun: Date | undefined
  readonly lastRun: JobRunResult | undefined
  nextRuns(count: number, from?: Date): Date[]
  pause(): void
  resume(): void
  /** Same kind only: a cron expression for a cron job, a duration for an interval or a timeout (ZNIGHT030). Not persisted. */
  reschedule(schedule: string | Duration, options?: { readonly timeZone?: string }): void
  /**
   * Runs the job now through the whole pipeline (overlap, lock, scope, hooks). Resolves with the
   * result and never rejects because the job failed; rejects with ZNIGHT021 when the scheduler is
   * stopping or not bootstrapped.
   */
  trigger(): Promise<JobRunResult>
}

export interface JobRunResult {
  readonly job: string
  readonly runId: string
  readonly trigger: RunTrigger
  readonly scheduledAt: Date
  readonly startedAt: Date | undefined // undefined when the run did not execute
  readonly finishedAt: Date | undefined
  readonly outcome: RunOutcome
  readonly error?: unknown
  readonly aborted?: 'timeout' | 'lock-lost' | 'removed' | 'shutdown'
}
```

Dynamic jobs, here one probe per monitor read from the database:

```ts
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

The registry is usable from the end of `onBootstrap` (provider `onStart` / `onReady`, requests,
runs). Earlier, in a provider constructor, it throws ZNIGHT021 with the hint "use it from
onStart/onReady". After `onStop` started, `add*` and `trigger` throw (reject) ZNIGHT021.
Reschedules, pauses and dynamic jobs are not persisted.

An admin endpoint is plain application code (`@znight/schedule` does not depend on
`@znight/http`):

```ts
@Controller('/admin/jobs')
@Roles(['admin'])
export class JobsController {
  constructor(private readonly registry: SchedulerRegistry) {}

  @Get()
  list() {
    return this.registry.jobs().map(job => ({
      name: job.name,
      schedule: job.schedule,
      state: job.state,
      running: job.running,
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

### 4.7 One runner across instances

Without a lock store, every instance runs every job. That is correct for a single instance and
for per-instance work (caches). With replicas, configure a store: jobs become **locked by default**.
Opt out per job with `lock: false`. `overlap: 'allow'` implies `lock: false`, and `lock: true` with
`overlap: 'allow'` is an error. A job declaring `lock: true` when no store is configured fails the
boot (ZNIGHT033): it asked for a guarantee the deployment does not give.

```ts
export interface ScheduleLockStore {
  /** Store name in logs. */
  readonly name: string
  /**
   * Atomically claims `claim.occurrence` of `key`. Succeeds only when (1) no live lease exists for
   * `key`, and (2) no occurrence greater than or equal to `claim.occurrence` was claimed for `key`
   * before. Resolves `undefined` when refused; rejects when the store fails (the run does not start).
   */
  acquire(key: string, claim: LockClaim): Promise<LockLease | undefined>
}

export interface LockClaim {
  readonly owner: string
  /** Epoch ms of the occurrence: strictly increasing per job, on every instance. */
  readonly occurrence: number
  readonly ttlMs: number
}

export interface LockLease {
  /** Extends the lease to `ttlMs` from now; `false` when it was lost (expired, then taken). */
  extend(ttlMs: number): Promise<boolean>
  /** Ends the lease. The occurrence stays claimed. */
  release(): Promise<void>
}

/** Process-local store: tests, and several applications in one process. */
export function memoryLockStore(options?: { readonly clock?: ScheduleClock }): ScheduleLockStore
```

Why occurrence fencing (§7.6): two instances whose clocks differ by 300 ms both fire "09:00". The
first claims occurrence `09:00`, runs for 50 ms and releases. The second arrives late and finds
occurrence `09:00` already claimed, so it is refused. A plain mutex would let it run a second time;
ShedLock works around this with a guessed `lockAtLeastFor`. The fencing also gives jobs a free
fencing token for their writes: `ctx.scheduledAt.getTime()` increases strictly per locked job.

Recipes. The guide imports the tested files with VitePress `<<<`, so the documented code is the
tested code. The Postgres store lives in the wave 7 example; the Redis store lives in
`packages/schedule/test/integration/` (§12.2).

```ts
/** PostgreSQL (PGlite, `pg`): the database clock decides expiry, not the instances' clocks. */
export const LOCKS_DDL = `create table if not exists znight_schedule_locks (
  key text primary key,
  owner text not null,
  occurrence bigint not null,
  expires_at timestamptz not null
)`

export interface SqlClient {
  query<R = unknown>(sql: string, params: readonly unknown[]): Promise<{ rows: R[] }>
}

export class PostgresLockStore implements ScheduleLockStore {
  readonly name = 'postgres'

  constructor(private readonly db: SqlClient) {}

  async acquire(key: string, claim: LockClaim): Promise<LockLease | undefined> {
    const { rows } = await this.db.query(
      `insert into znight_schedule_locks as l (key, owner, occurrence, expires_at)
       values ($1, $2, $3, clock_timestamp() + $4::double precision * interval '1 millisecond')
       on conflict (key) do update
         set owner = excluded.owner, occurrence = excluded.occurrence, expires_at = excluded.expires_at
         where l.expires_at <= clock_timestamp() and l.occurrence < excluded.occurrence
       returning key`,
      [key, claim.owner, claim.occurrence, claim.ttlMs],
    )
    if (rows.length === 0) return undefined
    const lease = [key, claim.owner, claim.occurrence] as const
    return {
      extend: async ttlMs => {
        const result = await this.db.query(
          `update znight_schedule_locks
              set expires_at = clock_timestamp() + $4::double precision * interval '1 millisecond'
            where key = $1 and owner = $2 and occurrence = $3 and expires_at > clock_timestamp()
           returning key`,
          [...lease, ttlMs],
        )
        return result.rows.length === 1
      },
      release: async () => {
        await this.db.query(
          `update znight_schedule_locks set expires_at = clock_timestamp()
            where key = $1 and owner = $2 and occurrence = $3`,
          lease,
        )
      },
    }
  }
}
```

```lua
-- Redis: KEYS[1] = '{<key>}:lease', KEYS[2] = '{<key>}:occurrence' (one hash slot, Cluster-safe)
-- acquire: ARGV = owner:occurrence, occurrence, ttl ms
local last = redis.call('GET', KEYS[2])
if last and tonumber(last) >= tonumber(ARGV[2]) then return 0 end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[3]) then
  redis.call('SET', KEYS[2], ARGV[2])
  return 1
end
return 0
-- extend:  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0
-- release: if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0
```

The Redis recipe takes a tiny `eval(script, keys, args)` port, so it works with `ioredis`,
`redis` or Bun's `RedisClient` (`send('EVAL', ...)`). Those client APIs come from my knowledge and
were not checked in this repository.

### 4.8 Testing with `@znight/testing`

`@znight/schedule/testing` exports `createTestClock()`, `createJobContext()` and
`lockStoreScenarios`.

```ts
// Unit test: the job is a method; TestBed builds the class with auto-mocked dependencies.
import { expect, test } from 'bun:test'
import { createJobContext } from '@znight/schedule/testing'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { DigestJobs } from '../src/digest/digest.jobs.js'
import { Mailer } from '../src/digest/mailer.js'
import { ReportService } from '../src/digest/report.service.js'

test('the daily digest mails the report of the previous day', async () => {
  const { instance, mocks } = await TestBed.create(DigestJobs, { metadata })
  mocks.get(ReportService).build.mockResolvedValue({ checks: 42, incidents: [] })

  await instance.sendDaily(createJobContext({ scheduledAt: new Date('2027-03-26T07:00:00Z') }))

  expect(mocks.get(ReportService).build).toHaveBeenCalledWith(
    expect.objectContaining({ until: new Date('2027-03-26T07:00:00Z') }),
  )
  expect(mocks.get(Mailer).send).toHaveBeenCalledTimes(1)
})
```

```ts
// Schedule test: real plugin, virtual time. Time only moves when the test advances it.
import { SchedulePlugin, SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'
import { TestApp } from '@znight/testing'

// (metadata, Mailer and FakeMailer imported as above)
test('the digest follows Paris time across the DST switch', async () => {
  const clock = createTestClock('2027-03-26T06:00:00Z') // Friday 07:00 in Paris (CET)
  const mailer = new FakeMailer()
  await using app = await TestApp.create({
    metadata,
    plugins: [SchedulePlugin.configure({ clock })],
    overrides: [[Mailer, mailer]],
  })

  await clock.advanceTo('2027-03-29T07:00:00Z') // Monday 09:00 in Paris (CEST)

  expect(mailer.sent).toHaveLength(2) // Friday 08:00 CET (07:00Z), Monday 08:00 CEST (06:00Z), none on the weekend
  const digest = app.get(SchedulerRegistry).get('digest.daily')
  expect(digest?.lastRun?.scheduledAt.toISOString()).toBe('2027-03-29T06:00:00.000Z')
  expect(digest?.nextRun?.toISOString()).toBe('2027-03-30T06:00:00.000Z')
})

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

```ts
// Two instances, one lock store, one clock: each occurrence runs once.
import { memoryLockStore } from '@znight/schedule'

test('single runner', async () => {
  const clock = createTestClock('2027-03-26T06:59:59Z')
  const lock = memoryLockStore({ clock })
  const mailer = new FakeMailer()
  const instance = () =>
    TestApp.create({ metadata, plugins: [SchedulePlugin.configure({ clock, lock })], overrides: [[Mailer, mailer]] })
  await using a = await instance()
  await using b = await instance()

  await clock.advance('2s')

  expect(mailer.sent).toHaveLength(1)
})
```

```ts
// Conformance of a custom store (scenarios are runner-agnostic: each throws on failure).
import { lockStoreScenarios } from '@znight/schedule/testing'

for (const scenario of lockStoreScenarios) {
  test(`PostgresLockStore: ${scenario.name}`, () => scenario.run(() => new PostgresLockStore(db)))
}
```

- `createTestClock(start = '2026-01-01T00:00:00Z')` returns a `ScheduleClock` with `date`,
  `advance(duration)` and `advanceTo(date)`. Both fire the due timers in order, and **wait for the
  runs they started to settle** before going on, so assertions need no sleep.
- `createJobContext(init?)` builds a `JobContext` for unit tests, with an `abort(reason)` helper.
- `TestApp` (prerequisite §9) adds job hosts to the default roots. Tests that do not exercise the
  schedule pass `enabled: false`. With a test clock, time never moves by itself, but `runOnStart`
  jobs and `@Timeout(0)` still run at start.

### 4.9 Coming from `@nestjs/schedule`

API of `@nestjs/schedule` v6 as I remember it; it was not checked in this repository.

| `@nestjs/schedule`                                                                                 | `@znight/schedule`                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ScheduleModule.forRoot()`                                                                         | `SchedulePlugin.configure()`                                                                                                 |
| `@Cron(expr, { name, timeZone, utcOffset, disabled, waitForCompletion, unrefTimeout, threshold })` | `@Cron(expr, { name, timeZone, enabled, overlap, lock, maxDuration, runOnStart })`. `utcOffset` becomes `timeZone: '+02:00'` |
| `CronExpression.EVERY_DAY_AT_MIDNIGHT`                                                             | `'@daily'` or `'0 0 * * *'`                                                                                                  |
| `@Interval('name', 10000)`                                                                         | `@Interval('10s', { name })` (or `10_000`)                                                                                   |
| `@Timeout('name', 5000)`                                                                           | `@Timeout('5s', { name })`                                                                                                   |
| `schedulerRegistry.getCronJob(name)` (a `cron` `CronJob`)                                          | `registry.get(name)`: `pause`, `resume`, `reschedule`, `trigger`, `nextRuns`                                                 |
| `addCronJob(name, new CronJob(...))`, `addInterval(name, setInterval(...))`, `addTimeout(...)`     | `addCron(name, expr, handler)`, `addInterval(name, every, handler)`, `addTimeout(name, delay, handler)`                      |
| `deleteCronJob`, `deleteInterval`, `deleteTimeout`                                                 | `remove(name)`                                                                                                               |
| Overlapping runs by default                                                                        | `overlap: 'skip'` by default                                                                                                 |
| Server time zone by default                                                                        | UTC by default                                                                                                               |
| No distributed lock                                                                                | `lock` store, one runner per occurrence                                                                                      |
| Errors at boot, or never                                                                           | ZNIGHT030–033 at build time or boot                                                                                          |

## 5. Compile-time analysis and validations

### 5.1 Decorators and analysis

| Identity                    | Targets | Params         |
| --------------------------- | ------- | -------------- |
| `@znight/schedule#Cron`     | method  | static, static |
| `@znight/schedule#Interval` | method  | static, static |
| `@znight/schedule#Timeout`  | method  | static, static |

`analyzeClass` runs for every class that carries at least one of them:

1. **Class.** An abstract class is ZNIGHT005 ("jobs are not inherited: declare them on the concrete
   class"). So is a class with unbound type parameters, as for any provider.
2. **Method shape.** The method must be public, non-static, not `#private`, not an accessor, not a
   generator, and its name must not be computed (ZNIGHT005, same messages as messaging handlers). A
   method that is also an HTTP route or a message handler, that is, it carries a decorator owned by
   another extension (`@Get`, `@OnMessage`), is ZNIGHT005: "a job method cannot be a route; let
   the job call the handler". Interceptor decorators (`@Intercept`, `@Logged`, `@Traced`,
   `@Metric`) are allowed and wrap the job.
3. **Signature.** At most one required parameter. The first parameter, when present, is typed
   `JobContext`, `unknown` or `any`, or has no annotation. Anything else is ZNIGHT030. A parameter
   decorator on a job method is ZNIGHT005 (the method only receives `ctx`).
4. **First argument.** `@Cron` takes a string, which is parsed by the shared engine. `@Interval`
   and `@Timeout` take a `Duration`.
5. **Options.** An object literal with known keys only. An unknown key is ZNIGHT030 with a
   did-you-mean, for example `timezone` → `timeZone`, or `timeZone` on `@Interval` ("intervals are
   durations: use @Cron for wall-clock schedules"). Each value is checked: type, enum, duration,
   name grammar, and zone through `new Intl.DateTimeFormat('en-US', { timeZone })` on the compiling
   runtime, with a did-you-mean over `Intl.supportedValuesOf('timeZone')`.
6. **Conflicts.** `lock: true` with `overlap: 'allow'` is ZNIGHT030.
7. **Roots.** `ctx.addRoot(cls, { reason: 'scheduled job host' })` (§5.5): the host is a root of
   ZNIGHT019 and `prune`, and becomes a singleton when nothing else registers it.
8. **Store.** `{ kind: 'job', name, explicitName, token, identity, displayName, method, trigger,
   options, takesContext, location, nameLocation }`.

`validate`, after binding:

1. **ZNIGHT031**: two jobs with the same name, across the application, its source libraries and the
   data of compiled libraries (`znight.providers.json`). The diagnostic has a related location and
   the hint "set { name } on one of them".
2. **Request-scoped hosts** (warning ZNIGHT030): a `request` or `transient` host whose non-`Lazy`
   dependency closure reaches `@znight/http#HttpContext`, `@znight/http#RequestId` or
   `@znight/messaging#InboundMessage`. Those values do not exist during a run (ZNIGHT013 at
   runtime). A singleton host is already covered by ZNIGHT003.

`generate`: §6.

**Locations.** When the cron argument is a plain string literal or a template without
substitutions, and its source text equals its value (no escapes), a field-level problem points at
the field: literal start + 1 + field offset, in UTF-16 units. Otherwise, for example with a `const`
reference, it points at the argument.

### 5.2 Diagnostics

| Code      | Severity | Condition                                                                                                                            | Example message / hint                                                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| ZNIGHT030 | error    | Wrong field count, unknown token, value out of range, step 0, reversed range, unsupported syntax (`W`, year, `H`, `?` misplaced)     | `hour 24 is out of range (0-23)`                                                                                                 |
| ZNIGHT030 | error    | The expression never fires (proleptic Gregorian calendar, 400-year cycle)                                                            | `'0 0 30 2 *' never fires: February has no day 30` / `Use 'L' for the last day of the month`                                     |
| ZNIGHT030 | error    | `@reboot`                                                                                                                            | `use runOnStart: true or @Timeout(0)`                                                                                            |
| ZNIGHT030 | warning  | The minute (or second) field is `*` while the hour (or minute) field is one value or a list                                          | `'* 9 * * *' fires every minute from 09:00 to 09:59` / `Once at 09:00 is '0 9 * * *'; write '0-59 9 * * *' to mean every minute` |
| ZNIGHT030 | error    | Invalid duration: unit, negative, not an integer number of ms, over 366 days, `@Interval(0)`                                         | `'5 min' is not a duration: use '5m' (ms, s, m, h, d)`                                                                           |
| ZNIGHT030 | warning  | A bare number below 100 for `@Interval` or `maxDuration`                                                                             | `@Interval(5) runs every 5 ms: did you mean '5s'? Write '5ms' to keep it`                                                        |
| ZNIGHT030 | error    | Unknown time zone                                                                                                                    | `Unknown time zone 'Europe/Pari' (did you mean 'Europe/Paris'?)`                                                                 |
| ZNIGHT030 | error    | Unknown option, wrong option type, invalid job name, `lock: true` with `overlap: 'allow'`                                            | `Unknown option 'timezone' (did you mean 'timeZone'?)`                                                                           |
| ZNIGHT030 | error    | Job method signature                                                                                                                 | `OutboxJobs.flush(batch: Batch) is called with (ctx: JobContext)`                                                                |
| ZNIGHT030 | warning  | A request-scoped host depends on an HTTP or messaging request value                                                                  | `CatalogImport depends on HttpContext, which does not exist during a scheduled run`                                              |
| ZNIGHT031 | error    | Duplicate job name                                                                                                                   | `Job name 'ReportJobs.daily' is used twice`                                                                                      |
| ZNIGHT005 | error    | Method shape, abstract host, decorator not called or not on a method, non-static argument, route + job, parameter decorator on a job | messaging's messages                                                                                                             |
| ZNIGHT003 | error    | A singleton host injects `JobContext` directly (core rule)                                                                           | hint: `Lazy<JobContext>` or the `ctx` parameter                                                                                  |

### 5.3 What it looks like

```text
✗ ZNIGHT030: Invalid cron expression for job 'digest.daily': hour 24 is out of range (0-23)
  --> src/digest/digest.jobs.ts:14:12
   |
14 |   @Cron('0 24 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris' })
   |            ^^
   = hint: Fields: [second] minute hour day-of-month month day-of-week

✗ ZNIGHT030: Cron expression '0 0 30 2 *' of job 'billing.close' never fires: February has no day 30
  --> src/billing/billing.jobs.ts:8:9
   |
 8 |   @Cron('0 0 30 2 *', { name: 'billing.close' })
   |         ^^^^^^^^^^^^
   = hint: Use 'L' for the last day of the month: '0 0 L 2 *'

⚠ ZNIGHT030: Cron expression '* 9 * * *' of job 'ReportJobs.daily' fires every minute from 09:00 to 09:59
  --> src/reports/report.jobs.ts:5:9
   |
 5 |   @Cron('* 9 * * *')
   |         ^^^^^^^^^^^
   = hint: Once at 09:00 is '0 9 * * *'; write '0-59 9 * * *' to mean every minute

✗ ZNIGHT031: Job name 'sync' is used twice
  --> src/crm/crm.jobs.ts:10:31
   ::: src/erp/erp.jobs.ts:7:35 (first declared here)
   = hint: Job names must be unique (logs, metrics, lock keys): rename one of them
```

### 5.4 Error codes and ranges

**Ranges.** ZNIGHT001–029 stay with the core and the v0.1 feature packages; RFC 0001 proposes
ZNIGHT023. From ZNIGHT030, each new package claims a block of ten in its RFC, recorded in
architecture §4.8: **ZNIGHT030–039 belongs to `@znight/schedule`**. It uses 030 to 034 and keeps
035 to 039 in reserve. Codes still live in `@znight/core` (`ErrorCode`, `ERROR_DESCRIPTIONS`),
since compiler and runtime share them. If another RFC claims the same block first, the second one
to merge moves to the next free block before the release. Code refers to codes by name only, so
renumbering is mechanical.

| Code      | Name               | Description                                                                                                                                                                                                                                                                                                    | Severity        | Reported                |
| --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------- |
| ZNIGHT030 | `InvalidSchedule`  | Invalid schedule: cron expression (syntax, range, never fires), duration, time zone, options, job method signature. At boot: invalid `SchedulePlugin` options, `jobs` overrides, hand-written metadata, a zone unknown to the runtime. At runtime: `parseCron`, `parseDuration`, `registry.add*`, `reschedule` | error / warning | build, startup, runtime |
| ZNIGHT031 | `DuplicateJob`     | Two jobs share a name                                                                                                                                                                                                                                                                                          | error           | build, startup, runtime |
| ZNIGHT032 | `UnknownJob`       | No job has this name: a `jobs` override (with did-you-mean), `registry.trigger` / `remove`                                                                                                                                                                                                                     | error           | startup, runtime        |
| ZNIGHT033 | `MissingLockStore` | A job requires a lock (`lock: true`) but `SchedulePlugin` has no store                                                                                                                                                                                                                                         | error           | startup                 |
| ZNIGHT034 | `JobAborted`       | `ctx.signal.reason` of an aborted run (`JobAbortedError`, `reason`: `timeout`, `lock-lost`, `removed`, `shutdown`). Never thrown by the framework                                                                                                                                                              | error value     | runtime                 |

Existing codes reused: ZNIGHT005 (decorator usage), ZNIGHT003 (scopes), ZNIGHT013 (`HttpContext`
in a job), ZNIGHT001 (host token not a provider, in hand-written metadata), ZNIGHT004 (one plugin
instance in two running applications), ZNIGHT015 (a request-scoped host factory failed: the run is
`failed`), ZNIGHT021 (registry used before bootstrap or after stop).

### 5.5 Compiler prerequisite: `AnalyzeContext.addRoot`

```ts
interface AnalyzeContext<TData> {
  /**
   * Declares `cls` as an entry point that the extension's plugin uses at runtime: its provider is a
   * root of ZNIGHT019 and `prune` (§4.8). When no provider decorator (core or extension) registers
   * the class by the end of the analysis, it is registered as a singleton with constructor
   * injection, `registeredBy: 'auto'` (the rule of `resolveClassRef`). Returns the token
   * (`cls.identity`).
   */
  addRoot(cls: ClassInfo, details?: { readonly location?: Location; readonly reason?: string }): Token
}
```

- The change is additive: `EXTENSION_API_VERSION` stays 1, and lockstep versions make skew
  impossible within a release line. Roots are recorded in `AnalysisState`, auto-registration
  happens in step 4 next to `resolveClassRefs()`, and `computeReachability` adds the roots.
- Compiled libraries record roots in `znight.providers.json` (optional `roots: Token[]`; schema
  version 1 stays valid), so a library job survives `prune` in the application.
- Without this method, the only alternative is a mandatory class decorator (`@Schedulable()`) that
  registers the provider itself, like `@Consumer`. That is one more decorator for users, and it
  cannot be combined with `@Injectable` or `@Controller` on the same class (ZNIGHT005, "registered by
  several provider decorators"). Rejected (§10).

## 6. Generated metadata and runtime contract

### 6.1 Shape

```ts
export interface ScheduleMetadata {
  /** Sorted by name. */
  readonly jobs: readonly ScheduledJobDefinition[]
}

export type ScheduledJobDefinition = CronJobDefinition | IntervalJobDefinition | TimeoutJobDefinition

interface JobDefinitionBase {
  readonly name: string
  /** Provider token of the host class. */
  readonly token: Token
  readonly method: string
  /** Absent: 'skip'. Never present on timeouts. */
  readonly overlap?: 'queue' | 'allow'
  /** Absent: the plugin rule (locked when a store is configured, unless overlap is 'allow'). */
  readonly lock?: boolean
  /** Milliseconds. */
  readonly maxDuration?: number
  /** Only `false` is emitted. */
  readonly enabled?: false
  /** `(c: Host) => c.method()` or `(c: Host, j: JobContext) => c.method(j)`. */
  // biome-ignore lint/suspicious/noExplicitAny: generated invokers receive the concrete host class
  readonly invoke: (host: any, ctx: JobContext) => unknown
}

export interface CronJobDefinition extends JobDefinitionBase {
  readonly kind: 'cron'
  /** As written, whitespace collapsed to single spaces. */
  readonly cron: string
  /** As written. Absent: the plugin's `timeZone`. */
  readonly timeZone?: string
  readonly runOnStart?: true
}

export interface IntervalJobDefinition extends JobDefinitionBase {
  readonly kind: 'interval'
  /** Milliseconds. */
  readonly every: number
  readonly runOnStart?: true
}

export interface TimeoutJobDefinition extends JobDefinitionBase {
  readonly kind: 'timeout'
  /** Milliseconds after the scheduler started. */
  readonly delay: number
}

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly schedule?: ScheduleMetadata
  }
}
```

### 6.2 Example (expected output, `build` mode)

```ts
import type { ZnightMetadata } from '@znight/core'
import type { JobContext } from '@znight/schedule'
import { DigestJobs } from '../digest/digest.jobs.js'
import { StatusCache } from '../status/status-cache.js'

export const __ZNIGHT_METADATA__: ZnightMetadata = {
  // ...providers: DigestJobs (core, @Injectable or auto), StatusCache (auto)...
  extensions: {
    ['schedule']: {
      ['jobs']: [
        {
          ['name']: 'digest.daily',
          ['token']: 'src/digest/digest.jobs.ts#DigestJobs',
          ['method']: 'sendDaily',
          ['kind']: 'cron',
          ['cron']: '0 8 * * MON-FRI',
          ['timeZone']: 'Europe/Paris',
          ['maxDuration']: 600000,
          ['invoke']: (c: DigestJobs, j: JobContext) => c.sendDaily(j),
        },
        {
          ['name']: 'status-cache.refresh',
          ['token']: 'src/status/status-cache.ts#StatusCache',
          ['method']: 'refresh',
          ['kind']: 'interval',
          ['every']: 60000,
          ['lock']: false,
          ['runOnStart']: true,
          ['invoke']: (c: StatusCache) => c.refresh(),
        },
      ],
    },
  },
}
```

### 6.3 Contract (normative)

- The section is omitted when the application has no job. `jobs` are sorted by name (compared with
  `compareStrings`), and the output is byte-identical on Node and Bun. Zones and expressions are
  emitted as written, never canonicalised or expanded: nicknames stay `@daily`.
- `JobContext` is imported (`import type`) only when a job takes the parameter. Unused arrow
  parameters are omitted (`noUnusedParameters`).
- Options equal to their default are omitted (architecture §3.3 "Omissions").
- `SchedulePlugin` validates the section at boot, because metadata can be hand-written: shapes,
  names (ZNIGHT030 / ZNIGHT031), expressions and zones with the runtime's `Intl` (ZNIGHT030), host
  tokens (`container.has(token)`, ZNIGHT001 naming the job).
- The plugin reads nothing else: no decorator, no reflection, no source location.

## 7. Runtime architecture

### 7.1 Plugin lifecycle

| Hook          | What happens                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`    | Registers the `SchedulerRegistry` value and declares the request-scoped external `JobContext`                                                                                                                                                                 |
| `onBootstrap` | Resolves and validates options (ZNIGHT030), reads and validates the metadata, applies `jobs` overrides (ZNIGHT032 for unknown names), checks lock requirements (ZNIGHT033), compiles every cron expression once, resolves singleton hosts, binds the registry |
| `onStart`     | Nothing is armed yet: jobs start in `onReady`                                                                                                                                                                                                                 |
| `onReady`     | When `enabled`: arms the scheduler (first occurrences, `@Timeout` deadlines), runs `runOnStart` jobs, starts the keep-alive, logs `Schedule: N job(s), next: digest.daily at 2026-10-28T07:00:00.000Z`                                                        |
| `onStop`      | Stops arming, drops queued runs, aborts every running run (`shutdown`), waits up to `drainTimeoutMs`, logs the runs it abandons                                                                                                                               |
| `onDispose`   | Clears timers and heartbeats, unbinds the registry                                                                                                                                                                                                            |

Jobs start in `onReady`, once every provider started and every plugin listens. A job never runs
against a half-started application, and a `stop()` during the start never arms anything.

### 7.2 The scheduler (**Impl.** details marked)

- **One timer.** Next deadlines live in a binary heap, ties broken by job name, so tests are
  deterministic. A single timer is armed for the earliest deadline, capped at **60 s** (**Impl.**).
  On every wake-up the scheduler re-reads `clock.now()` and fires whatever is due. This one cap
  handles three problems at once:
  - delays over 2^31 − 1 ms, which Node turns into 1 ms (§2);
  - wall-clock jumps (NTP steps, manual changes);
  - monotonic timers that stop during sleep (macOS).
- **Keep-alive.** From the end of `onReady` to the start of `onStop`, the timer is referenced, so a
  worker whose only ingress is the scheduler does not exit. With `enabled: false`, no timer exists.
- **Clock.** `ScheduleClock` is `{ now(): number; setTimer(fn, ms): unknown; clearTimer(handle): void;
  track?(run: Promise<unknown>): void }`. `systemClock` uses `Date.now` and `setTimeout`. The test
  clock implements `track` to await runs in `advance()`.
- **Engine.** A cron expression compiles to per-field bitsets plus the `L` / `#` rules. `next(after)`
  walks candidate days, then hours, minutes and seconds, skipping with the bitsets. Wall-clock
  fields come from one cached `Intl.DateTimeFormat` per zone (`formatToParts`, `hourCycle: 'h23'`).
  Wall time is turned back into an instant by offset iteration, which detects gaps and folds.
  `UTC` and fixed offsets skip `Intl`. The search horizon is 400 years, and a schedule with no
  occurrence becomes `done` with a warning (unreachable for compiled jobs: §5.2).

### 7.3 Occurrences (normative)

- **Cron.** The next occurrence is the first matching wall-clock second strictly after the
  previous one, with the DST rules of §4.4.
- **Interval.** Occurrences are the multiples of `every` since the Unix epoch (UTC). The first is
  the next multiple after the start; `runOnStart` adds a run at start (trigger `'start'`). Every
  instance and every restart agrees on occurrence times, which is required by locks, and a deploy
  every 2 hours no longer starves a 6-hour interval (with `setInterval`, the period restarts at each
  boot). Use `@Cron` for wall-clock alignment (`every: '1d'` runs at 00:00 UTC).
- **Timeout.** One occurrence, `delay` after the scheduler started; then the job is `done`.
- **Late wake-up.** When the scheduler wakes after one or more occurrences of a job (stalled event
  loop, suspended process, wall clock moved forward), the job runs **once**, for the latest missed
  occurrence. The next occurrence is computed strictly after now. The skipped ones are logged at
  `debug` with their count.
- **Monotonic per job.** An occurrence never runs twice in a process: after a backward clock jump,
  occurrences not greater than the last one run are ignored.
- The next occurrence is armed when an occurrence **fires**, not when its run settles, so a slow run
  never delays the schedule (overlap decides, §7.5).

### 7.4 The run pipeline (normative)

```text
occurrence due (job, scheduledAt, trigger)
→ state: paused, disabled, removed or stopping → dropped
→ overlap (§7.5): skip → emit {outcome: 'skipped'}; queue → keep as the pending run; allow → go on
→ lease, for locked jobs (§7.6): store.acquire(key, { owner, occurrence: scheduledAt, ttlMs })
    refused → emit {outcome: 'not-acquired'}   store error → emit {outcome: 'failed', error} (fail closed)
→ container.runInScope(seeded with JobContext,
    hooks.run('schedule:run', event,             // only when wrappers exist (core convention)
      invoke(host, ctx)))                        // host: bootstrap singleton, or get(token) in the scope
    in parallel: heartbeat every ttl/3 (lost → abort 'lock-lost'), maxDuration timer (→ abort 'timeout')
→ settle: outcome 'completed' | 'failed' (threw or rejected) | 'skipped' (a wrapper did not call next())
    lease released (§7.7 exception), lastRun updated, emit (listeners), failure logged
→ a pending queued occurrence re-enters at the overlap step with trigger 'queued'
```

- A wrapper that does not call `next()` vetoes the run (feature flags, maintenance windows): the
  outcome is `skipped`.
- Failures are logged at `error` with `err` (stack included). When a `schedule:run` wrapper is
  installed, the entry carries `error` (the message only), so the stack is logged once by the
  observer, as messaging does.
- Skipped runs are logged at `warn`, since a job slower than its period is a problem worth seeing.
  Refused leases are logged at `debug`: they are normal with replicas.

### 7.5 Overlap

| Policy           | An occurrence fires while a run of the same job is in flight in this process                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `skip` (default) | Dropped, outcome `skipped`                                                                                                            |
| `queue`          | Kept as the single pending run (a later one replaces it, with the latest `scheduledAt`). It starts as soon as the current run settles |
| `allow`          | Runs concurrently. Implies `lock: false`                                                                                              |

`maxDuration` aborts `ctx.signal` but does not free the slot. JavaScript cannot kill a promise, so
a run that ignores its signal keeps blocking `skip` and `queue`, and each skipped occurrence logs
how long the run has been going. That keeps the problem visible.

Manual triggers follow the job's policy: under `skip`, `trigger()` resolves
`{ outcome: 'skipped' }` immediately; under `queue`, it resolves when the queued run settles.

### 7.6 Locks: occurrence-fenced leases (normative)

- **Key** `<keyPrefix><job name>` (default `znight:schedule:digest.daily`). **Owner**
  `<hostname>:<pid>:<random>` per plugin instance.
- **Claim.** `occurrence` = `scheduledAt` in epoch ms: the cron occurrence, the epoch-aligned
  interval tick, start + delay for timeouts, now for manual and `runOnStart` runs, the queued
  occurrence for queued runs. A store accepts a claim only when no lease is live **and** the
  occurrence is greater than every occurrence claimed before for the key.
- **Guarantees.** (1) An occurrence runs at most once across the fleet. Instances that fire late
  because of clock skew or stalls are refused, whatever the skew, as long as all instances use the
  same schedule. (2) Runs of a job never overlap across instances while leases are kept alive.
  (3) The ordering gives a fencing token for writes. What it does **not** guarantee: that an
  occurrence runs at all if the instance holding it crashes (at most once, no catch-up), or
  "once per period" for `@Timeout` and `runOnStart` runs, whose occurrence is per process.
- **Lease.** `ttl` defaults to 30 s. It is extended every `ttl / 3` while the run lasts. A failed
  extension (store error) is retried at the next heartbeat. When the lease is lost (`extend` returns
  `false`, or `ttl` elapsed since the last successful extension), `ctx.signal` is aborted with
  `lock-lost` and logged at `warn`. The run is not killed.
- **Store failures fail closed.** No lease, no run: outcome `failed` with the store error.
- **Release** happens when the run settles, except for runs abandoned at shutdown (§7.7).
- `lockStoreScenarios` (§4.8) checks these semantics for any store: claim/refuse, monotonic
  occurrences, expiry, extend after expiry and takeover, stale release, and ten concurrent claims of
  one occurrence with exactly one winner.

### 7.7 Abort, `maxDuration` and graceful shutdown

- `ctx.signal` is aborted with a `JobAbortedError` (ZNIGHT034) whose `reason` is `timeout`
  (`maxDuration`), `lock-lost`, `removed` (`remove(name, { abort: true })`) or `shutdown`. The run
  result records it (`aborted`). Jobs are cooperative: pass the signal to `fetch`, database
  drivers and loops (`ctx.signal.throwIfAborted()`).
- **`onStop`** (normative):
  1. state `stopping`: the timer is disarmed, queued runs are dropped, `trigger()` and `add*()`
     reject or throw ZNIGHT021;
  2. every running run's signal is aborted with `shutdown`, **at once**, so jobs can checkpoint and
     return early. This is consistent with `message.signal`, and a job that wants to finish its
     current unit simply checks the signal between units;
  3. the plugin waits until every run settled, or `drainTimeoutMs` (default 4000 ms, `Infinity` = no
     own limit, finite values capped at 2^31 − 1);
  4. runs still in flight are **abandoned**: logged at `warn` (name, run id, duration). Their
     leases are **not** released, but they stop being extended and expire after `ttl`, so no other
     instance starts the job while the abandoned run may still be writing.
- A `stop()` called from inside a run, awaited or not, does not wait for that run. Runs are tracked
  with an `AsyncLocalStorage` marker; the calling run's signal is aborted, other runs drain
  normally. This mirrors core's "stop requested by a start hook" (§8.2) and avoids a deadlock until
  `drainTimeoutMs`.
- Keep `drainTimeoutMs` below `shutdown.hookTimeoutMs` (5000 ms by default), like `HttpPlugin`. With
  plugins `[..., Schedule, Http]`, HTTP drains first (4 s), then the scheduler (4 s), within the
  default 10 s budget.

### 7.8 Scopes

- Each run executes in its own `container.runInScope()`, seeded with `JobContext` (token
  `@znight/schedule#JobContext`). Request-scoped providers created during the run are disposed when
  it settles.
- A request-scoped or transient host is created in that scope, one instance per run. A singleton
  host is resolved once at bootstrap; the run calls it in the scope.
- A singleton injecting `JobContext` directly is ZNIGHT003 at build time; use `Lazy<JobContext>` or
  the method parameter.
- `HttpContext`, `RequestId` and `InboundMessage` are not seeded in a run. Resolving them throws
  ZNIGHT013 ("No value for the request-scoped @znight/http#HttpContext in the current scope
  (provided by HttpPlugin)"), and request-scoped hosts that depend on them get a build warning
  (§5.1).
- A manual trigger from an HTTP request runs in **its own** container scope, never the request's.
  It may outlive the request, so its instances must not be disposed with the response. It keeps the
  async context of the caller, so its span is a child of the request span.

### 7.9 Hooks and observability

Core gains a fourth hook (prerequisite):

```ts
// @znight/core
interface ZnightHooks {
  'schedule:run': ScheduledRunEvent // produced by @znight/schedule
}

export interface ScheduledRunEvent {
  readonly job: string
  readonly kind: 'cron' | 'interval' | 'timeout'
  /** Display name of the host class; `undefined` for dynamic jobs. */
  readonly host: string | undefined
  readonly method: string | undefined
  readonly runId: string
  readonly trigger: 'schedule' | 'start' | 'manual' | 'queued'
  /** Epoch ms of the occurrence (scheduler clock). */
  readonly scheduledAt: number
  /** `JobContext` from @znight/schedule; `undefined` when the run did not execute. */
  readonly context: unknown
  /** `performance.now()` when the run started, or was dropped. */
  readonly startTime: number
  /** Set before `hooks.run` resolves, or before `emit` for runs that did not execute. */
  outcome?: 'completed' | 'failed' | 'skipped' | 'not-acquired'
  error?: unknown
  aborted?: 'timeout' | 'lock-lost' | 'removed' | 'shutdown'
}
```

- Executed runs go through `hooks.run` (wrappers: spans, durations, logs), then `emit`.
  Occurrences that do not execute (`skipped`, `not-acquired`, `failed` because of the store) are
  only emitted, so no span or duration is recorded for a tick that did nothing, but counters still
  see them.
- `@znight/observability` (P1, §9):
  - `logging.jobs` (default `true`): one entry per settled run: `info` for completed, `error` for
    failed, `warn` for skipped, `debug` for not-acquired. Fields: `job`, `runId`, `trigger`,
    `scheduledAt`, `durationMs`, `lateMs`. The `Logger` also adds `job` and `runId` to every entry
    written inside a run: it reads `@znight/schedule#JobContext` from the current scope structurally,
    as it reads `RequestId` today.
  - `metrics.schedule` (default `true`):
    - `schedule_runs_total{job, outcome}` (counter, every outcome);
    - `schedule_run_duration_seconds{job, outcome}` (histogram, executed runs);
    - `schedule_run_lateness_seconds{job}` (histogram);
    - `schedule_active_runs{job}` (gauge);
    - `schedule_last_success_timestamp_seconds{job}` (gauge, for "has not succeeded since"
      alerts).

    The `job` label is capped at `maxJobs` (100) distinct names, then `_OTHER`, because dynamic job
    names can be unbounded.
  - `tracing.schedule` (default `true`): one `INTERNAL` span `schedule <job>` per executed run, the
    root of a new trace, except for manual triggers (child of the caller). Attributes:
    `znight.schedule.job`, `.kind`, `.trigger`, `.run_id`, `.scheduled_at`. The span status is
    `ERROR` on failure.
- Interceptors (`@Logged`, `@Traced`, `@Metric`, `@Intercept`) on a job method apply as on any
  method, since the container installs them on the instance.

### 7.10 HTTP integration

- **No adapter work.** Jobs never touch `HttpAdapter`. The scheduler runs the same next to the node,
  fastify, express or hono adapter, or with no HTTP at all (workers).
- **Admin endpoints** are user code on the injectable registry (§4.6). The wave 7 example guards
  them like rest-api does.
- **Tests** combine `TestApp.inject()` with a test clock: create a monitor over HTTP, advance time,
  assert the probe ran.
- **Shutdown order.** List `SchedulePlugin` before `HttpPlugin`: HTTP stops taking requests,
  manual triggers included, then the scheduler drains (§7.7).
- **Health.** `registry.jobs()` exposes `lastRun` and `nextRun`, so a `/health` route can flag jobs
  whose last success is older than two periods (shown in the example).

### 7.11 Node.js and Bun

- Only standard APIs: timers, `AbortController` / `AbortSignal`, `Intl`, `crypto.randomUUID`,
  `node:os` `hostname()`, and core's `AsyncLocalStorage`. Both runtimes provide them.
- `Intl` data differs (§2), hence boot revalidation and zones kept as written. A runtime-check
  fixture computes a table of occurrences with Node and with Bun and compares both against the
  expected values (§12.2).
- `Temporal` (Bun only today) and `Bun.cron` (OS-level, Bun only) are not used (§10).

### 7.12 Performance

- No reflection and no decorator reading at runtime. Each expression is parsed once at boot, in
  microseconds.
- One timer for all jobs, a heap, and at most one wake-up per minute when idle. Nothing is
  allocated per idle tick.
- Per run: one scope, one UUID, `hooks.run` only when wrappers exist, one lease round trip for
  locked jobs.
- `next()` stays in the microsecond range: bitset skipping, one cached formatter per zone, no `Intl`
  call for UTC or offsets. A non-gating benchmark tracks it (§12.2).
- Applications without `@znight/schedule` pay nothing: the compiler extension loads only when the
  code imports the package (architecture §6.5).

## 8. Dependencies

|                      | Choice                                                                                                                 | Why                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime dependencies | `@znight/core` (`workspace:*`) only                                                                                    | The engine is built in (below). Zones come from `Intl`                                                                                                                                                                           |
| Optional peers       | `@znight/compiler` (`workspace:^`)                                                                                     | Convention of every feature package                                                                                                                                                                                              |
| Lock stores          | none                                                                                                                   | The interface, `memoryLockStore()` and recipes. Applications bring their client (`pg`, PGlite, `ioredis`, Bun's `RedisClient`)                                                                                                   |
| devDependencies      | `croner`, `fast-check`, `testcontainers` + `@testcontainers/redis` (exact pins), `@znight/compiler`, `@znight/testing` | `croner` is the **differential test oracle** of the engine. `fast-check` generates expressions, zones and instants. The containers run the Redis recipe under `ZNIGHT_INTEGRATION=1` (Bun's `RedisClient`, no client dependency) |

**Engine: built in, not a dependency.** The ecosystem below comes from my knowledge up to mid-2026.
None of these libraries is installed in this repository, so check the versions when implementing.
Only Bun's APIs and `Intl` were checked locally.

| Library                                                                    | What it is                                                                                                                                                   | Verdict                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [croner](https://github.com/Hexagon/croner)                                | Zero dependencies, TypeScript, ESM, Node/Bun/Deno. Seconds, `L`, `W`, `#`, nicknames, IANA zones through `Intl`, `nextRuns`, overrun protection. Widely used | The best library. Kept as test oracle and as fallback engine (below)  |
| [cron](https://github.com/kelektiv/node-cron) (used by `@nestjs/schedule`) | `CronJob` with its own timers; depends on `luxon`                                                                                                            | No: luxon's weight, a second timer system, overlap allowed by default |
| [cron-parser](https://github.com/harrisiirak/cron-parser) v5               | Parser, depends on `luxon`                                                                                                                                   | No: luxon                                                             |
| [node-cron](https://github.com/merencia/node-cron)                         | Its own scheduler                                                                                                                                            | No: we need the parser, not another scheduler                         |
| `Bun.cron` / `Bun.cron.parse` (verified on Bun 1.4.4)                      | OS-level job registration; 5-field parser, local zone only, no seconds, `L` or `#`                                                                           | Bun only, no zones: no                                                |
| `Temporal`                                                                 | Bun 1.4 has it, Node 24 does not (verified)                                                                                                                  | Not before Node's floor ships it (§11 Q12)                            |
| BullMQ, pg-boss, Agenda                                                    | Durable queues with repeatable jobs (Redis, Postgres, Mongo)                                                                                                 | Out of scope (durable jobs); bridge later through messaging           |

Why built in:

1. **One semantics.** The compiler extension and the runtime import the same import-free module,
   exactly like `@znight/http` `path.ts`, so build-time validation can never disagree with the
   process.
2. **Precise diagnostics.** The parser returns field spans, so the caret lands on `24` in
   `'0 24 * * *'`. Libraries throw one generic message for the whole pattern.
3. **Analysis a library does not offer.** "Never fires" over a 400-year cycle, "every minute of
   hour 9" warnings, and specified DST rules that we document, test and own.
4. **Small and bounded.** No `W` and no year field. About 700 lines (parser, matcher, `next`,
   zones), differentially tested against croner on hundreds of thousands of cases. A dependency
   would also need an exact behavioural pin in the compiler, since its output becomes build errors.
5. **Fallback.** If the engine slips, M1 ships croner's pattern and `nextRun` behind the same
   `CronSchedule` interface. The compiler entry may import croner because it has no side effects,
   and the rest of the design does not change.

## 9. Changes to other packages and documentation

| Package / file                   | Change                                                                                                                                                                                                                                                                                                                                                                   | Priority |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `@znight/core`                   | `ErrorCode` + `ERROR_DESCRIPTIONS` for ZNIGHT030–034; `'schedule:run'` in `ZnightHooks` + `ScheduledRunEvent`                                                                                                                                                                                                                                                            | P0       |
| `@znight/compiler`               | `AnalyzeContext.addRoot()`, roots in reachability, `roots` in compiled-library fragments                                                                                                                                                                                                                                                                                 | P0       |
| `@znight/testing`                | `TestApp` default roots include `extensions.schedule.jobs[].token`; "everything when there is no controller, consumer **nor job**"                                                                                                                                                                                                                                       | P0       |
| `@znight/observability`          | `logging.jobs`, `metrics.schedule`, `tracing.schedule`, `job` / `runId` logger fields                                                                                                                                                                                                                                                                                    | P1       |
| `@znight/cli`                    | `znight new --features schedule` (dependency, plugin, a sample job and its test-clock test); `znight g job <name>`                                                                                                                                                                                                                                                       | P1       |
| `tests/boundaries.test.ts`       | Covers the new entries (`.`, `./testing`, `./compiler`): the compiler entry may only import `src/cron/*`, `src/duration.ts`, `src/names.ts` (import-free)                                                                                                                                                                                                                | P0       |
| `docs/internals/architecture.md` | §2 layout; §4.8 codes + range rule; §5 decorator catalogue; §6.5 `addRoot`; §7 manifest table; §8.3 four hooks; new §9.5 Schedule (metadata, pipeline, occurrences, locks, shutdown); §10 TestApp roots                                                                                                                                                                  | P0       |
| Docs site                        | `packages/schedule/README.md`, `docs/packages/schedule.md`, `docs/guide/scheduling.md` (recipes, DST, locks, testing), `docs/reference/decorators.md`, `docs/reference/error-codes.md` (030–034), the `@nestjs/schedule` table in `migrating-from-nestjs.md`; rename the fictional `SchedulerPlugin` (plugins guide) and `CronPlugin` (core README) to `HeartbeatPlugin` | P0       |
| Release                          | `@znight/schedule` joins the lockstep group; the npm org exists                                                                                                                                                                                                                                                                                                          | P0       |

Package layout:

```text
packages/schedule/
├─ package.json            exports ".", "./testing", "./compiler"; manifest below
├─ src/
│  ├─ index.ts             public runtime API
│  ├─ decorators.ts        Cron, Interval, Timeout (shared no-op markers)
│  ├─ metadata.ts          ScheduleMetadata + ZnightExtensionsMetadata augmentation
│  ├─ cron/                import-free: parse (spans), fields, match, next, zone (Intl), describe
│  ├─ duration.ts          import-free
│  ├─ names.ts             import-free: job name grammar
│  ├─ clock.ts             ScheduleClock, systemClock
│  ├─ scheduler.ts         heap, single timer, resync
│  ├─ run.ts               pipeline: overlap, lease, scope, hooks, abort, settle
│  ├─ registry.ts          SchedulerRegistry, ScheduledJob
│  ├─ lock.ts              ScheduleLockStore, leases, heartbeat, memoryLockStore
│  ├─ context.ts           JobContext
│  ├─ errors.ts            InvalidScheduleError, JobAbortedError
│  ├─ tokens.ts            ScheduleTokens
│  ├─ plugin.ts            SchedulePlugin
│  ├─ testing/index.ts     createTestClock, createJobContext, lockStoreScenarios
│  └─ compiler/            index, analyze, options, validate, generate, data, constants
└─ test/                   see §12.2
```

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/schedule/compiler",
  "provides": [
    { "export": "SchedulerRegistry", "plugin": "SchedulePlugin", "scope": "singleton" },
    { "export": "JobContext", "plugin": "SchedulePlugin", "scope": "request" }
  ]
}
```

## 10. Alternatives considered

| Alternative                                                                           | Verdict                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `croner` as runtime engine                                                            | Fallback only (§8): no field spans, a semantics we would have to pin, a dependency for 700 lines we can test against it                          |
| `cron` (the `@nestjs/schedule` engine)                                                | Rejected: luxon, its own timers, no lock or hook integration                                                                                     |
| `Temporal` for zones                                                                  | Not on Node 24 (verified). Revisit when the Node floor has it                                                                                    |
| `Bun.cron`                                                                            | Bun only, OS-level, local zone, 5 fields                                                                                                         |
| A mandatory class decorator (`@Schedulable()`) that registers hosts, like `@Consumer` | Rejected: one more decorator, incompatible with `@Injectable` / `@Controller` on the same class. `addRoot` is a 30-line additive compiler change |
| Requiring `@Injectable()` on hosts (NestJS)                                           | Rejected: Znight already auto-registers helper classes (guards). `@Injectable` remains the way to choose a scope                                 |
| Start-anchored intervals (`setInterval`)                                              | Rejected: restarts and rolling deploys starve long intervals, and instances disagree on occurrences, which breaks locks                          |
| A plain mutex with `lockAtLeastFor` (ShedLock)                                        | Rejected: the hold time is a guess that bounds both skew tolerance and job frequency. Occurrence fencing needs neither                           |
| Two lock keys (an occurrence claim plus a run mutex)                                  | Rejected: two round trips; one record `{ owner, occurrence, expires_at }` does both                                                              |
| Abort jobs at the drain deadline instead of at stop                                   | Rejected: jobs cannot checkpoint early; it differs from messaging                                                                                |
| Overlap `allow` by default (NestJS)                                                   | Rejected: concurrent runs of a job that took longer than usual are the classic production surprise                                               |
| A local default time zone (NestJS, Spring)                                            | Rejected: a laptop in Paris and a UTC container would run the same job at different times                                                        |
| `CronExpression` enum                                                                 | Rejected: package constants are not readable from `.d.ts` by the static evaluator; nicknames cover the common cases                              |
| Unsilenceable DST warnings (`30 2 * * *` in a DST zone)                               | Rejected: legitimate jobs would warn forever. The rules are specified and documented instead                                                     |

## 11. Open questions (with recommended answers)

1. **Built-in engine or croner?** Built in, with croner as oracle and fallback (§8). Decide at the
   end of M1: if the differential suite is not green on both runtimes, switch to the fallback.
2. **Default zone UTC or local?** UTC. `timeZone: 'local'` keeps NestJS behaviour one option away.
3. **Auto-register hosts, or require `@Injectable()`?** Auto-register as a singleton, like guards;
   `@Injectable({ scope })` when another scope is needed.
4. **Inherit jobs from base classes?** Not in v0.1, the HTTP route rule: jobs on an abstract class
   are ZNIGHT005. A concrete base extended by another host would otherwise double-schedule. Revisit
   with a clear rule (the most derived provider owns the job) if users ask.
5. **Lock jobs by default once a store exists?** Yes. Running "send invoices" on every replica is
   worse than refreshing a cache on one; `lock: false` is explicit.
6. **Ship Redis and Postgres stores?** Not in v0.1: recipes, conformance scenarios and the tested
   Postgres store of the example. Promote them to `@znight/schedule/postgres` and
   `@znight/schedule/redis` subpaths in v0.2 if the recipes get copied around.
7. **Catch-up of missed occurrences?** No (non-goal). The store already keeps the last claimed
   occurrence per job, so a v0.2 `catchUp: 'latest'` could run one missed occurrence at start.
8. **Fixed-delay intervals, jitter, a global concurrency cap?** Not in v0.1. `overlap: 'skip'`
   covers polling. Add `@Interval(every, { after: 'completion' })` and
   `SchedulePlugin.configure({ concurrency })` when asked.
9. **Should `trigger()` work when `enabled: false`?** Yes. Manual runs are explicit and go through
   locks; it also makes tests simple.
10. **A `znight schedule` CLI listing jobs and their next runs?** v0.2. Cheap on top of
    `CompileResult.graph` and `parseCron`, not needed for v0.1.
11. **Error code block.** 030–039 for schedule. If RFC 0002 or 0003 claims it too, the first merged
    keeps it (§5.4).
12. **When to use `Temporal`?** When both supported runtimes ship it unflagged. Swap the internals
    of `cron/zone.ts`; nothing public changes.

## 12. Implementation plan

### 12.1 Milestones and tasks (one developer)

| #   | Task                                                                                                                                                               | Priority | Days       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------- |
| T1  | Core: ZNIGHT030–034, `schedule:run` + `ScheduledRunEvent`, error codes page entries                                                                                | P0       | 0.5        |
| T2  | Compiler: `addRoot`, reachability, library `roots`, spec §6.4/§6.5                                                                                                 | P0       | 1          |
| T3  | Engine: parser with spans, matcher, `next` / `nextRuns`, zones and DST, durations, names, never-fires, warnings; oracle and property tests; Node/Bun runtime check | P0       | 3.5        |
| T4  | Compiler extension: specs, analyze, validate, generate, diagnostics, snapshots, e2e                                                                                | P0       | 2.5        |
| T5  | Runtime: plugin, scheduler, run pipeline, overlap, `maxDuration`, abort, shutdown, keep-alive, options / overrides / metadata validation                           | P0       | 3          |
| T6  | Registry: dynamic jobs, pause / resume / reschedule / trigger / idle                                                                                               | P0       | 1          |
| T7  | Locks: interface, leases and heartbeat, `memoryLockStore`, `lockStoreScenarios`                                                                                    | P0       | 1.5        |
| T8  | Testing: `createTestClock`, `createJobContext`, TestApp roots                                                                                                      | P0       | 1          |
| T9  | Observability: logs, metrics, spans, logger fields                                                                                                                 | P1       | 1.5        |
| T10 | Docs: README, spec, guide, reference pages, NestJS table, renames                                                                                                  | P0       | 1.5        |
| T11 | CLI: `--features schedule`, `znight g job`                                                                                                                         | P1       | 0.5        |
| T12 | Wave 7: `examples/uptime-monitor` (§13)                                                                                                                            | P0       | 3          |
|     | **Total** (P0 ≈ 18.5)                                                                                                                                              |          | **≈ 20.5** |

| Milestone      | Tasks      | Exit criteria                                                                                                                      |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| M1 Foundations | T1, T2, T3 | Engine merged; oracle and DST suites green on Node and Bun; `addRoot` keeps a host alive under `prune`                             |
| M2 Build time  | T4         | Every row of §5.2 covered by a fixture with its location; snapshot of the section; generated module byte-identical on Node and Bun |
| M3 Runtime     | T5–T8      | Lifecycle matrix, lock conformance and the §4.8 tests green on both runtimes                                                       |
| M4 Ecosystem   | T9–T11     | Observability wrappers tested; docs build; `znight new --features schedule` e2e                                                    |
| M5 Wave 7      | T12        | Example tests and e2e (built bundle on Node and Bun) green; golden test includes the example                                       |

Pull requests: T1+T2 (prerequisites), T3, T4, T5+T6+T7+T8 (runtime), T10, T9, T11, T12.

### 12.2 Test plan

**Engine (`test/cron/*.test.ts`, `test/duration.test.ts`)**

- Grammar tables: every accepted form, every error with its `field`, `start` and `end`.
- Matching and `next()` in UTC: ranges, steps, lists, names, nicknames, `L`, `5L`, `MON#2`, the
  OR rule, leap years (`0 0 29 2 *`), a 5th Monday in February only (`0 0 * 2 1#5`: the search
  crosses decades).
- DST tables (the expected values are part of the tests):
  - Europe/Paris: both 2026–2027 transitions, gap and fold rules;
  - America/New_York;
  - Australia/Lord_Howe (30-minute DST);
  - Asia/Kathmandu (+05:45);
  - America/Sao_Paulo (DST abolished in 2019);
  - Pacific/Apia (2011-12-30 skipped);
  - fixed offsets, `local` under `TZ`.
- Never-fires detection and the "every minute of a single hour" warning; durations and names.
- **Differential**: `fast-check` generates expressions without `W` or year and with croner's OR
  mode, plus zones and instants; `next()` must equal croner's `nextRun()`. Divergences fall in two
  classes: DST folds (where our rule is specified) and known croner differences. Both are listed in
  the test as explicit exceptions, not silenced.
- **Runtime check**: `test/fixtures/zone-check.ts` prints a table of occurrences; `runtime.test.ts`
  runs it with `node --conditions=@znight/source` and with `bun` (the http pattern) and compares
  both outputs to the expected table.
- Non-gating benchmark: 10,000 `next()` calls on random expressions and zones; report the time on
  both runtimes.

**Compiler (`test/compiler/*`)**

- Analysis fixtures for every row of §5.2, with code, severity, location, related location and
  hints. That includes the caret inside the string, and the fallback to the argument for a `const`
  reference.
- Hosts: auto-registered, `@Injectable` with each scope, `@Controller`, `@Consumer` and `@Factory`
  hosts; a route + job conflict; an abstract host.
- `reportUnused` reports no host, and `prune` keeps hosts. A source library and a compiled library
  with jobs: roots preserved, ZNIGHT031 across the library and the application.
- Snapshot of the generated section (`invoke` with and without `ctx`, omissions, sorting).
- Determinism: the module is byte-identical with and without `@znight/source`, and in the golden
  test (Node and Bun, `build` and `serve`).
- **e2e** (`test/compiler/e2e.test.ts`, like messaging): compile a fixture application, boot it
  with the plugin and a test clock, and assert the runs.

**Runtime (`test/*.test.ts`, test clock unless noted)**

- **Scheduler**: deadlines in order, name tie-break, 60 s resync after a wall-clock jump, a late
  wake-up runs once (latest occurrence), a backward jump never repeats, timers above 2^31 − 1 ms
  without overflow (system clock, fake `setTimeout`).
- **Occurrences**: epoch-aligned intervals, `runOnStart`, timeouts.
- **Overlap**: `skip` (outcome and log), `queue` (coalescing, `trigger` semantics), `allow`;
  `maxDuration` aborts and does not free the slot.
- **Locks** with `memoryLockStore`:
  - two schedulers on one clock, one run per occurrence;
  - lease extension and loss (abort `lock-lost`);
  - store failure (fail closed);
  - abandoned leases kept;
  - `lockStoreScenarios` against the memory store;
  - ZNIGHT033.
- **Shutdown**: abort at stop, drain, abandon after `drainTimeoutMs`, `stop()` from inside a run
  (no deadlock), keep-alive held only while running, nothing armed with `enabled: false` or when
  stopped during start.
- **Scopes**:
  - `JobContext` injection;
  - request-scoped host: one instance per run, disposed after;
  - `Lazy<JobContext>`;
  - `HttpContext` in a run throws ZNIGHT013;
  - interceptors on job methods (sync and async).
- **Hooks**:
  - wrappers see executed runs only, listeners see every outcome;
  - a wrapper without `next()` gives `skipped`;
  - logging with and without wrappers (stack logged once).
- **Registry**: add / remove / pause / resume / reschedule / trigger / idle, ZNIGHT021, ZNIGHT031,
  ZNIGHT032; validation of options, overrides and hand-written metadata (ZNIGHT030, 032, 033,
  ZNIGHT001); plugin reuse across applications (ZNIGHT004).

**Integration (`test/integration`, `ZNIGHT_INTEGRATION=1`)**: `lockStoreScenarios` against the
Redis recipe (`redis-lock-store.ts`, the file the guide imports) on a Redis container, through Bun's
`RedisClient`.

**Observability (`packages/observability/test`)**: log entries per outcome, metrics names and
labels (including the `_OTHER` cap), spans (root vs child of a request), logger `job` / `runId`
fields.

**Node and Bun**: the package tests run under `bun test`, like every package. Node coverage comes
from the runtime-check fixture (engine and system-clock scheduler) and from the example's e2e on
the built bundle under Node and Bun.

## 13. Wave 7 example: `examples/uptime-monitor`

**Purpose.** The reference answer to "how do I run scheduled work with Znight", covering every
feature of this RFC, and the tested source of the guide's recipes (Postgres lock store, admin
endpoints, health).

**Domain.** An uptime monitor:

- monitors (URL, expected status, interval) are probed on their own schedules;
- results are stored, and old ones purged every night;
- a weekday digest is mailed at 08:00 Paris time;
- a public status page is served from a per-instance cache.

**Stack.**

- `@znight/http` with `honoAdapter()`: `Bun.serve()` on Bun, `@hono/node-server` on Node.
- `@znight/config`, `@znight/observability` and `@znight/schedule`.
- PGlite for the database and the lock store. Its SQL is plain Postgres, so the same store runs on
  `pg` in production.
- Runs on Node 24 and Bun.

| Job                    | Declaration                                                                  | Shows                                                                          |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `monitor.<id>`         | `registry.addInterval(...)` per monitor, at `onReady` and through the API    | Dynamic jobs, `ctx.signal` passed to `fetch`, `maxDuration`, locks per monitor |
| `digest.daily`         | `@Cron('0 8 * * MON-FRI', { timeZone: 'Europe/Paris', maxDuration: '10m' })` | Zones, DST, single runner, `jobs` override from `DIGEST_CRON`                  |
| `probes.purge`         | `@Cron('0 30 3 * * *', { maxDuration: '10m' })`                              | 6 fields, batches with `ctx.signal.throwIfAborted()`                           |
| `status-cache.refresh` | `@Interval('1m', { lock: false, runOnStart: true })`                         | Per-instance work, epoch alignment                                             |
| `status-cache.warm`    | `@Timeout('2s', { lock: false })`                                            | One-shot at start                                                              |

| Route                                                                                                            | Access                                                            | Shows                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /status`                                                                                                    | public                                                            | Reads the cache                                                                          |
| `GET /monitors`, `POST /monitors`, `DELETE /monitors/:id`                                                        | API key (rest-api guard pattern; RFC 0001 groups if merged first) | Dynamic jobs; schedules validated with `parseDuration` / `parseCron` in a Zod refinement |
| `GET /admin/jobs`, `POST /admin/jobs/:name/run`, `POST /admin/jobs/:name/pause`, `POST /admin/jobs/:name/resume` | admin                                                             | Registry, manual triggers (202)                                                          |
| `GET /health`                                                                                                    | public                                                            | Scheduler state; jobs whose last success is older than two periods                       |

```text
examples/uptime-monitor/
├─ src/
│  ├─ main.ts                    Application.create() with plugins()
│  ├─ plugins.ts                 Observability, Config, Schedule, Http, with { clock?, enabled? } for the tests
│  ├─ config/                    ScheduleConfig (SCHEDULE_ENABLED, SCHEDULE_TIME_ZONE, DIGEST_CRON), HttpConfig, DatabaseConfig, AuthConfig
│  ├─ db/                        @Factory: PGlite (dispose), schema and migrations (locks table included)
│  ├─ schedule/
│  │  ├─ postgres-lock-store.ts  the §4.7 recipe on a { query } client
│  │  └─ jobs.controller.ts      /admin/jobs
│  ├─ monitors/                  controller, MonitorScheduler (dynamic jobs), Prober (fetch port), repositories
│  ├─ status/                    StatusCache (@Interval, @Timeout), StatusController
│  ├─ digest/                    DigestJobs (@Cron), ReportService, Mailer port + outbox implementation
│  ├─ maintenance/purge.jobs.ts  @Cron with seconds, batched purge
│  ├─ auth/                      API-key guard, Roles / Public
│  └─ health/                    HealthController
├─ test/
├─ .env.development              SCHEDULE_TIME_ZONE=Europe/Paris, DIGEST_CRON unset (decorator default)
└─ README.md                     What it shows; "Try breaking it": '0 25 * * *' → ZNIGHT030, a duplicated name → ZNIGHT031
```

**Tests** (`bun test`, plus e2e runs gated by `ZNIGHT_E2E`):

- `digest.jobs.test.ts`: `TestBed` and `createJobContext`; the job reads `ctx.scheduledAt`, not the
  current time.
- `digest.schedule.test.ts`: `TestApp` and a test clock across the March 2027 DST switch (runs on
  Friday at 07:00Z and Monday at 06:00Z, none on the weekend), then a `DIGEST_CRON` override.
- `single-runner.test.ts`: two `TestApp`s sharing one PGlite database and one clock; each
  occurrence runs once. When the first app stops mid-run, its lease expires and the second takes
  the next occurrence.
- `postgres-lock-store.test.ts`: `lockStoreScenarios` against PGlite.
- `monitors.http.test.ts`: `POST /monitors` registers `monitor.<id>`; advancing the clock records a
  probe (fake `Prober`); `DELETE` removes the job and aborts its run.
- `admin.http.test.ts`: list, trigger (202, then `lastRun.outcome === 'completed'`), pause and
  resume, 401 and 403.
- `shutdown.test.ts`: a running purge receives `shutdown` and returns between batches; the drain
  completes.
- `build-check.test.ts`: compiles fixtures through `compile()` from `@znight/compiler` and asserts
  ZNIGHT030 (field location), ZNIGHT031 and ZNIGHT005. This keeps "Try breaking it" honest.
- `e2e.test.ts`: builds, then runs `dist/main.js` on Node and on Bun with a 2-second interval
  monitor against a local HTTP target. It checks the run logs (`job`, `runId`), `/admin/jobs`, and a
  SIGTERM while a run is in flight (graceful drain, exit code 0).

The guide (`docs/guide/scheduling.md`) links each recipe to its file and test in this example.
