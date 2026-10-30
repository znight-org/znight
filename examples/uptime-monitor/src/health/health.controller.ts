import type { Application } from '@znight/core'
import type { SchedulePluginInstance, SchedulerRegistry } from '@znight/schedule'
import type { Database } from '../db/database.js'
import type { JobHealth, OverdueJob } from './job-health.js'

import { Controller, Get, ServiceUnavailableException } from '@znight/http'
import { SCHEDULE_PLUGIN_NAME } from '@znight/schedule'

import { Public } from '../auth/auth.decorators.js'

/** The answer of `GET /health`. */
export interface Health {
  /** `degraded`: some jobs are overdue. The instance still serves: restarting it would not fix a job. */
  readonly status: 'ok' | 'degraded'
  readonly uptime: number
  readonly scheduler: {
    /** `running` once started; `stopping` during a graceful shutdown. */
    readonly state: string
    readonly jobs: number
    /** Jobs with a next run on this instance: `0` with `SCHEDULE_ENABLED=false` (manual runs only). */
    readonly armed: number
    /** Runs in flight on this instance. */
    readonly running: number
  }
  readonly overdue: readonly OverdueJob[]
}

/**
 * Liveness and readiness for load balancers and orchestrators: public (`@Public()`).
 *
 * `503` only when the database does not answer: the instance cannot serve. Overdue jobs make the
 * status `degraded` with a `200`: they are worth an alert (they are listed), not a restart.
 */
@Controller('/health')
@Public()
export class HealthController {
  constructor(
    private readonly db: Database,
    private readonly app: Application,
    private readonly registry: SchedulerRegistry,
    private readonly jobs: JobHealth,
  ) {}

  /** GET /health */
  @Get()
  async check(): Promise<Health> {
    try {
      await this.db.query('SELECT 1')
    } catch (error) {
      throw new ServiceUnavailableException('Database unavailable', undefined, { cause: error })
    }
    const plugin = this.app.getPlugin<SchedulePluginInstance>(SCHEDULE_PLUGIN_NAME)
    const jobs = this.registry.jobs()
    const overdue = this.jobs.overdue()
    return {
      status: overdue.length === 0 ? 'ok' : 'degraded',
      uptime: Math.round(process.uptime()),
      scheduler: {
        state: plugin?.state ?? 'absent',
        jobs: jobs.length,
        armed: jobs.filter(job => job.nextRun !== undefined).length,
        running: jobs.reduce((sum, job) => sum + job.running, 0),
      },
      overdue,
    }
  }
}
