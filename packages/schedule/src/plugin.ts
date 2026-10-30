import type { Plugin, PluginContext, PluginOptions, PluginRootsContext, ProviderKey } from '@znight/core'
import type { ScheduleClock } from './clock.ts'
import type { JobHandler } from './context.ts'
import type { Duration } from './duration.ts'
import type { CronOptions, IntervalOptions, TimeoutOptions } from './options.ts'
import type { SchedulePluginOptions } from './prepare.ts'
import type { JobRunResult, ScheduledJob } from './registry.ts'
import type { JobInit, JobSchedule, RuntimeState } from './runtime.ts'
import type { JobKind } from './validate.ts'

import { ErrorCode, resolveOptions, ZnightError } from '@znight/core'

import { compileExpression } from './cron.ts'
import { duplicateJobError, notAvailableError, unknownJobError } from './errors.ts'
import { prepareJobs, resolvePluginOptions } from './prepare.ts'
import { SchedulerRegistry } from './registry.ts'
import { normalizeCron, ScheduleRuntime } from './runtime.ts'
import { ScheduleTokens } from './tokens.ts'
import { assertJobName, describe, durationMs, invalid, isRecord, normalizeJobOptions } from './validate.ts'

/** Lifecycle state of the plugin. */
export type SchedulePluginState = 'created' | RuntimeState

/** The plugin returned by {@link SchedulePlugin.configure}. */
export interface SchedulePluginInstance extends Plugin {
  readonly name: 'schedule'
  /** The registry (also injectable as `SchedulerRegistry`), usable from the end of `onBootstrap`. */
  readonly registry: SchedulerRegistry
  /** The scheduler clock, once the options are evaluated. */
  readonly clock: ScheduleClock | undefined
  readonly state: SchedulePluginState
  /** The hosts of the jobs of the metadata (read by `TestApp` of `@znight/testing`). */
  initRoots(context: PluginRootsContext): readonly ProviderKey[]
}

/** Name of the plugin (`app.getPlugin('schedule')`). */
export const SCHEDULE_PLUGIN_NAME = 'schedule'

/**
 * Cron, interval and timeout jobs (RFC 0004).
 *
 * ```ts
 * const app = await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [
 *     SchedulePlugin.configure({ timeZone: 'Europe/Paris', lock: new PostgresLockStore(db) }),
 *     HttpPlugin.configure({ adapter: honoAdapter(), port: 3000 }),
 *   ],
 * })
 * ```
 *
 * - `register`: provides `SchedulerRegistry` and the request-scoped external `JobContext`;
 * - `onBootstrap`: validates the options and the metadata (ZNIGHT040–043, ZNIGHT001), applies the
 *   `jobs` overrides, resolves singleton hosts and binds the registry;
 * - `onReady`: arms the scheduler (when `enabled`), runs `runOnStart` jobs and keeps the process alive;
 * - `onStop`: aborts the running runs (`shutdown`) and waits up to `drainTimeoutMs`;
 * - `onDispose`: clears the timers and unbinds the registry.
 *
 * List it before `HttpPlugin`: plugins stop in reverse order, so HTTP stops taking requests (manual
 * triggers included) before the running jobs are drained. Options may be a function of the container
 * (`SchedulePlugin.configure(c => ({ enabled: c.get(ScheduleConfig).enabled }))`), evaluated in
 * `onBootstrap`. An instance serves one running application at a time.
 */
export const SchedulePlugin: {
  readonly name: 'schedule'
  configure(options?: PluginOptions<SchedulePluginOptions>): SchedulePluginInstance
} = Object.freeze({
  name: SCHEDULE_PLUGIN_NAME,
  configure: (options: PluginOptions<SchedulePluginOptions> = {}): SchedulePluginInstance =>
    new SchedulePluginImpl(options),
})

class SchedulePluginImpl implements SchedulePluginInstance {
  readonly name = SCHEDULE_PLUGIN_NAME
  readonly registry: RegistryImpl
  readonly #options: PluginOptions<SchedulePluginOptions>
  #runtime: ScheduleRuntime | undefined
  #active = false

  constructor(options: PluginOptions<SchedulePluginOptions>) {
    this.#options = options
    this.registry = new RegistryImpl()
  }

  get clock(): ScheduleClock | undefined {
    return this.#runtime?.clock
  }

  get state(): SchedulePluginState {
    return this.#runtime?.state ?? 'created'
  }

  initRoots(context: PluginRootsContext): readonly ProviderKey[] {
    try {
      const section: unknown = context?.metadata?.extensions?.schedule
      if (!isRecord(section) || !Array.isArray(section['jobs'])) return []
      const roots = new Set<ProviderKey>()
      for (const job of section['jobs'] as unknown[]) {
        if (isRecord(job) && typeof job['token'] === 'string') roots.add(job['token'])
      }
      return [...roots]
    } catch {
      return [] // malformed metadata is reported by onBootstrap
    }
  }

  register(ctx: PluginContext): void {
    if (this.#active) {
      throw new ZnightError(ErrorCode.DuplicateProvider, 'This SchedulePlugin is already used by another application', {
        hints: ['Call SchedulePlugin.configure() once per application'],
      })
    }
    // an instance may serve several applications one after the other (shared test setups)
    this.#active = true
    this.#runtime = undefined
    this.registry.unbind('created')
    ctx.container.registerExternal({ token: ScheduleTokens.JobContext, scope: 'request', providedBy: 'SchedulePlugin' })
    ctx.container.registerValue(ScheduleTokens.SchedulerRegistry, this.registry)
  }

  onBootstrap(ctx: PluginContext): void {
    const options = resolvePluginOptions(resolveOptions(this.#options, ctx.container))
    const jobs = prepareJobs(ctx.metadata.extensions?.schedule, ctx.container, options)
    const runtime = new ScheduleRuntime(options.settings, {
      container: ctx.container,
      hooks: ctx.hooks,
      logger: ctx.logger,
    })
    for (const job of jobs) runtime.add(job)
    this.#runtime = runtime
    this.registry.bind(runtime)
  }

  onReady(ctx: PluginContext): void {
    const runtime = this.#runtime
    if (runtime === undefined) return
    runtime.start()
    const jobs = runtime.jobs().length
    if (!runtime.settings.enabled) {
      ctx.logger.info(`Schedule: disabled (${jobs} job(s) declared, none scheduled)`)
      return
    }
    const next = runtime.nextDeadline()
    ctx.logger.info(
      `Schedule: ${jobs} job(s)${next === undefined ? '' : `, next: ${next.job} at ${new Date(next.at).toISOString()}`}`,
      { jobs },
    )
  }

  async onStop(): Promise<void> {
    await this.#runtime?.stop()
  }

  onDispose(): void {
    this.#runtime?.dispose()
    this.registry.unbind('stopped')
    this.#active = false
  }
}

/** The registry of one plugin instance, bound to its runtime from the end of `onBootstrap`. */
class RegistryImpl extends SchedulerRegistry {
  #runtime: ScheduleRuntime | undefined
  #state = 'created'

  bind(runtime: ScheduleRuntime): void {
    this.#runtime = runtime
  }

  unbind(state: 'created' | 'stopped'): void {
    this.#state = state
    this.#runtime = undefined
  }

  #require(action: string): ScheduleRuntime {
    const runtime = this.#runtime
    if (runtime === undefined) throw notAvailableError(action, this.#state)
    return runtime
  }

  jobs(): readonly ScheduledJob[] {
    return this.#require('jobs()')
      .jobs()
      .map(job => job.handle)
  }

  get(name: string): ScheduledJob | undefined {
    return this.#require('get()').get(name)?.handle
  }

  has(name: string): boolean {
    return this.#require('has()').get(name) !== undefined
  }

  addCron(name: string, expression: string, handler: JobHandler, options?: Omit<CronOptions, 'name'>): ScheduledJob {
    const runtime = this.#require(`addCron('${name}')`)
    const where = `addCron('${name}')`
    const normalized = this.#check(runtime, 'cron', name, handler, options, where)
    if (typeof expression !== 'string')
      throw invalid(`${where}: the expression must be a string, got ${describe(expression)}`)
    const ownZone = normalized.timeZone
    const timeZone = ownZone ?? runtime.settings.timeZone
    const schedule: JobSchedule = {
      kind: 'cron',
      cron: normalizeCron(expression),
      timeZone,
      ownZone,
      engine: compileExpression(expression, timeZone, `${where}: invalid cron expression`),
    }
    return this.#add(runtime, name, schedule, handler, normalized)
  }

  addInterval(
    name: string,
    every: Duration,
    handler: JobHandler,
    options?: Omit<IntervalOptions, 'name'>,
  ): ScheduledJob {
    const runtime = this.#require(`addInterval('${name}')`)
    const where = `addInterval('${name}')`
    const normalized = this.#check(runtime, 'interval', name, handler, options, where)
    const schedule: JobSchedule = { kind: 'interval', every: durationMs(every, `${where}: the interval`, 1) }
    return this.#add(runtime, name, schedule, handler, normalized)
  }

  addTimeout(name: string, delay: Duration, handler: JobHandler, options?: Omit<TimeoutOptions, 'name'>): ScheduledJob {
    const runtime = this.#require(`addTimeout('${name}')`)
    const where = `addTimeout('${name}')`
    const normalized = this.#check(runtime, 'timeout', name, handler, options, where)
    const schedule: JobSchedule = { kind: 'timeout', delay: durationMs(delay, `${where}: the delay`, 0) }
    return this.#add(runtime, name, schedule, handler, normalized)
  }

  remove(name: string, options?: { readonly abort?: boolean }): void {
    const runtime = this.#require(`remove('${name}')`)
    if (
      options !== undefined &&
      (!isRecord(options) || (options.abort !== undefined && typeof options.abort !== 'boolean'))
    ) {
      throw invalid(`remove('${name}'): options must be { abort?: boolean }`)
    }
    runtime.remove(name, options?.abort === true)
  }

  trigger(name: string): Promise<JobRunResult> {
    try {
      const runtime = this.#require(`trigger('${name}')`)
      const job = runtime.get(name)
      if (job === undefined)
        throw unknownJobError(
          name,
          runtime.jobs().map(entry => entry.name),
        )
      return job.handle.trigger()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  idle(): Promise<void> {
    const runtime = this.#runtime
    return runtime === undefined ? Promise.resolve() : runtime.idle()
  }

  #check(
    runtime: ScheduleRuntime,
    kind: JobKind,
    name: string,
    handler: JobHandler,
    options: unknown,
    where: string,
  ): ReturnType<typeof normalizeJobOptions> {
    runtime.assertOpen(where)
    assertJobName(name, where)
    if (runtime.get(name) !== undefined) throw duplicateJobError(name)
    if (typeof handler !== 'function')
      throw invalid(`${where}: the handler must be a function, got ${describe(handler)}`)
    return normalizeJobOptions(kind, options, where)
  }

  #add(
    runtime: ScheduleRuntime,
    name: string,
    schedule: JobSchedule,
    handler: JobHandler,
    options: ReturnType<typeof normalizeJobOptions>,
  ): ScheduledJob {
    const init: JobInit = {
      name,
      origin: 'dynamic',
      host: undefined,
      method: undefined,
      token: undefined,
      schedule,
      overlap: options.overlap,
      lock: options.lock,
      maxDuration: options.maxDuration,
      enabled: options.enabled,
      runOnStart: options.runOnStart,
      invoke: handler,
    }
    return runtime.add(init).handle
  }
}
