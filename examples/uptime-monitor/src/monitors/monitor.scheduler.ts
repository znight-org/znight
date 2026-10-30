import type { OnReady } from '@znight/core'
import type { Logger } from '@znight/observability'
import type { JobContext, ScheduledJob, SchedulerRegistry } from '@znight/schedule'
import type { Monitor, NewMonitor } from './monitor.js'
import type { MonitorRepository } from './monitor.repository.js'
import type { ProbeService } from './probe.service.js'

import { Injectable } from '@znight/core'
import { Interval } from '@znight/schedule'

import { monitorIdOf, monitorJobName } from './monitor.js'

/**
 * The monitors and their jobs: one **dynamic** job per monitor, `monitor.<id>`, added to the
 * `SchedulerRegistry` at runtime since monitors live in the database, not in decorators.
 *
 * - `onReady` schedules every monitor of the database. Providers' `onReady` runs before the plugins'
 *   one: the jobs are armed when the scheduler starts, with the static ones.
 * - The API (`MonitorController`) creates and deletes monitors through `create()` and `delete()`:
 *   the job is added or removed at once, on this instance.
 * - `monitors.sync` reconciles the registry with the database every 30 s **on every instance**
 *   (`lock: false`): dynamic jobs are not persisted nor shared, so a monitor created through another
 *   instance gets its job here within 30 s, and a deleted one loses it.
 *
 * Each monitor job is locked by default (the plugin has a lock store): with several instances, each
 * occurrence of each monitor is probed once, by whichever instance claims it first. The lock key is
 * per job (`znight:schedule:monitor.42`), so monitors spread over the fleet.
 */
@Injectable()
export class MonitorScheduler implements OnReady {
  /** Changes of the jobs, one at a time: the API and `monitors.sync` never interleave. */
  #tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly monitors: MonitorRepository,
    private readonly probes: ProbeService,
    private readonly logger: Logger,
  ) {}

  async onReady(): Promise<void> {
    const { added } = await this.sync()
    this.logger.info('Monitors scheduled', { monitors: added })
  }

  /** Adds the jobs of the new monitors and removes the jobs of the deleted ones. */
  @Interval('30s', { name: 'monitors.sync', lock: false })
  sync(): Promise<{ added: number; removed: number }> {
    return this.#exclusive(async () => {
      const monitors = await this.monitors.all()
      const wanted = new Set(monitors.map(monitor => monitorJobName(monitor.id)))
      let removed = 0
      for (const job of this.registry.jobs()) {
        if (monitorIdOf(job.name) === undefined || wanted.has(job.name)) continue
        this.registry.remove(job.name, { abort: true })
        removed++
      }
      let added = 0
      for (const monitor of monitors) {
        if (this.registry.has(monitorJobName(monitor.id))) continue
        this.#schedule(monitor)
        added++
      }
      if (added + removed > 0) this.logger.debug('Monitor jobs synchronised', { added, removed })
      return { added, removed }
    })
  }

  /** Stores a monitor and schedules its job. */
  create(input: NewMonitor): Promise<Monitor> {
    return this.#exclusive(async () => {
      const monitor = await this.monitors.create(input)
      this.#schedule(monitor)
      return monitor
    })
  }

  /**
   * Removes a monitor's job, aborting a probe in flight (`ctx.signal`, reason `'removed'`), then the
   * monitor and its results. `false` when there was no such monitor.
   */
  delete(id: number): Promise<boolean> {
    return this.#exclusive(async () => {
      const name = monitorJobName(id)
      if (this.registry.has(name)) this.registry.remove(name, { abort: true })
      return await this.monitors.delete(id)
    })
  }

  /** The job of a monitor, `undefined` when it has none on this instance (yet). */
  jobOf(id: number): ScheduledJob | undefined {
    return this.registry.get(monitorJobName(id))
  }

  #schedule(monitor: Monitor): ScheduledJob {
    const name = monitorJobName(monitor.id)
    const probe = (ctx: JobContext): Promise<void> => this.probes.run(monitor, ctx)
    // the monitor's timeout bounds the run: ctx.signal aborts after it, and fetch with it
    const options = { maxDuration: monitor.timeoutMs }
    // validated by the API with the same engine (monitor.schemas.ts): these calls cannot throw ZNIGHT040
    return 'every' in monitor.schedule
      ? this.registry.addInterval(name, monitor.schedule.every, probe, options)
      : this.registry.addCron(name, monitor.schedule.cron, probe, { ...options, timeZone: monitor.schedule.timeZone })
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task)
    this.#tail = run.catch(() => undefined)
    return run
  }
}
