import type { ConfigLoader } from '@znight/config'
import type { Plugin } from '@znight/core'
import type { JobOverride, ScheduleClock, SchedulePluginOptions } from '@znight/schedule'
import type { Database } from './db/database.js'

import { ConfigPlugin } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { honoAdapter } from '@znight/http/hono'
import { ObservabilityPlugin } from '@znight/observability'
import { parseDuration, SchedulePlugin } from '@znight/schedule'

import { AuthGuard } from './auth/auth.guard.js'
import { ScheduleConfig } from './config/schedule.config.js'
import { ServerConfig } from './config/server.config.js'
import { PostgresLockStore } from './schedule/postgres-lock-store.js'

/** What the tests change; `main.ts` passes nothing. */
export interface PluginsOptions {
  /**
   * Where the configuration comes from. Default: `.env` files, then the environment (which wins).
   * Tests pass `[inline({ ... })]`, so that they do not depend on the machine.
   */
  readonly config?: readonly ConfigLoader[]
  /** The scheduler's time source and timers. Default: the system clock. Tests: `createTestClock()`. */
  readonly clock?: ScheduleClock
  /** Replaces `SCHEDULE_ENABLED`: tests that only exercise HTTP pass `false` (jobs still run on `trigger()`). */
  readonly scheduleEnabled?: boolean
  /**
   * Job overrides, over those of the configuration (`DIGEST_CRON`): tests disable the jobs they do
   * not watch. Validated at boot like any override (an unknown name is ZNIGHT042).
   */
  readonly jobs?: Readonly<Record<string, JobOverride>>
}

/**
 * The plugins of the application, shared by `main.ts` and the tests so that both run the same
 * wiring. Called once per application: a plugin instance serves one application at a time.
 *
 * The order matters. Plugins start in this order and stop in the reverse one:
 *
 * 1. `ObservabilityPlugin` first, so that its hooks wrap everything: one log line, metrics and a span
 *    per HTTP request **and per scheduled run** (`job completed`, with `job`, `runId`, `durationMs`,
 *    `lateMs`), and `job` / `runId` on every line logged inside a run.
 * 2. `ConfigPlugin` loads and validates every `@Config` class before anything else needs them.
 * 3. `SchedulePlugin` **before** `HttpPlugin`: on shutdown, HTTP stops taking requests first (manual
 *    triggers from `/admin/jobs` included), then the scheduler aborts and drains the running jobs.
 * 4. `HttpPlugin` last.
 */
export function plugins(options: PluginsOptions = {}): Plugin[] {
  return [
    ObservabilityPlugin.configure(container => {
      const server = container.get(ServerConfig)
      return {
        logging: {
          level: server.logLevel,
          // the health checks of the load balancer would drown the interesting lines
          requests: { ignore: event => event.route === '/health' },
        },
        // Prometheus needs the optional peer dependency `prom-client` (`bun add prom-client`): off
        // unless METRICS_PORT asks for it. Then `schedule_runs_total{job, outcome}`,
        // `schedule_last_success_timestamp_seconds{job}`... are served on their own port.
        metrics: server.metricsPort === undefined ? false : { server: { port: server.metricsPort } },
      }
    }),

    ConfigPlugin.configure(options.config === undefined ? {} : { loaders: options.config }),

    // Options computed from the container: they run in `onBootstrap`, once the configuration is
    // validated and the singletons exist (the migrated database included).
    SchedulePlugin.configure((container): SchedulePluginOptions => {
      const schedule = container.get(ScheduleConfig)
      return {
        // SCHEDULE_ENABLED=false on replicas that only serve HTTP: nothing is scheduled there
        enabled: options.scheduleEnabled ?? schedule.enabled,
        // the zone of the cron jobs that do not name one (probes.purge); validated at boot (ZNIGHT040)
        timeZone: schedule.timeZone,
        // One runner per occurrence across the instances sharing the database: every job is locked
        // by default, except those declaring `lock: false` (per-instance work: caches, sync).
        lock: {
          store: new PostgresLockStore(container.get<Database>('Database')),
          // '30s', '1m'...: parsed by the scheduler's own rules (a typo fails the boot with ZNIGHT040)
          ttl: parseDuration(schedule.lockTtl),
        },
        // per-deployment schedule, validated at boot like the decorators are at build time
        jobs: {
          ...(schedule.digestCron === undefined ? {} : { 'digest.daily': { cron: schedule.digestCron } }),
          ...options.jobs,
        },
        // keep it below `shutdown.hookTimeoutMs` (main.ts): the plugin then reports the abandoned runs
        drainTimeoutMs: schedule.drainTimeoutMs,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }
    }),

    HttpPlugin.configure(container => {
      const server = container.get(ServerConfig)
      return {
        // Hono's router: `Bun.serve()` on Bun, `@hono/node-server` on Node.js
        adapter: honoAdapter(),
        port: server.port,
        host: server.host,
        // Global: runs before the guards of controllers and routes. It enforces the "access" decision
        // of every route (@Public / @Roles), the admin endpoints of the scheduler included.
        guards: [AuthGuard],
        exposeErrors: server.exposeErrors,
        bodyLimit: '16kb', // monitors are small JSON documents
        // responses depend on the caller's key (or change every minute): no shared cache
        securityHeaders: { cacheControl: 'no-store' },
      }
    }),
  ]
}
