import type { ScheduledJob } from '@znight/schedule'
import type { Monitor, ProbeResult } from './monitor.js'
import type { MonitorRepository } from './monitor.repository.js'
import type { MonitorScheduler } from './monitor.scheduler.js'
import type { ProbeResultRepository } from './probe-result.repository.js'

import { Body, Controller, Delete, Get, HttpResponse, NotFoundException, Param, Post } from '@znight/http'

import { Roles } from '../auth/auth.decorators.js'
import { describeSchedule } from './monitor.js'
import { CreateMonitor } from './monitor.schemas.js'

/** Results returned with a monitor. */
const RECENT_RESULTS = 20

/** The scheduling state of a monitor's job on the instance that answers. */
export interface MonitorJobView {
  readonly name: string
  readonly state: ScheduledJob['state']
  /** The next occurrence; `null` while the scheduler does not run (`SCHEDULE_ENABLED=false`). */
  readonly nextRun: Date | null
  /** The last occurrence seen by this instance (`not-acquired`: another instance probed it). */
  readonly lastRun: { readonly outcome: string; readonly scheduledAt: Date } | null
}

/** A monitor as sent to clients. */
export interface MonitorView {
  readonly id: number
  readonly name: string
  readonly url: string
  readonly expectedStatus: number
  /** `'every 30s'` or `'0 * * * * (Europe/Paris)'`. */
  readonly schedule: string
  readonly timeoutMs: number
  readonly createdAt: Date
  /** `null` until the job exists on this instance (`monitors.sync` adds it within 30 s). */
  readonly job: MonitorJobView | null
}

function toView(monitor: Monitor, job: ScheduledJob | undefined): MonitorView {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    expectedStatus: monitor.expectedStatus,
    schedule: describeSchedule(monitor.schedule),
    timeoutMs: monitor.timeoutMs,
    createdAt: monitor.createdAt,
    job:
      job === undefined
        ? null
        : {
            name: job.name,
            state: job.state,
            nextRun: job.nextRun ?? null,
            lastRun:
              job.lastRun === undefined ? null : { outcome: job.lastRun.outcome, scheduledAt: job.lastRun.scheduledAt },
          },
  }
}

/**
 * The monitors. Creating one schedules its job (`monitor.<id>`) at once; deleting one removes the job
 * and aborts a probe in flight. Readers list, administrators change.
 */
@Controller('/monitors')
@Roles(['reader'])
export class MonitorController {
  constructor(
    private readonly scheduler: MonitorScheduler,
    private readonly monitors: MonitorRepository,
    private readonly results: ProbeResultRepository,
  ) {}

  /** GET /monitors */
  @Get()
  async list(): Promise<MonitorView[]> {
    const monitors = await this.monitors.all()
    return monitors.map(monitor => toView(monitor, this.scheduler.jobOf(monitor.id)))
  }

  /** GET /monitors/42: the monitor, its job and its latest results. */
  @Get('/:id')
  async get(@Param('id') id: number): Promise<MonitorView & { readonly results: ProbeResult[] }> {
    const monitor = await this.monitors.find(id)
    if (monitor === undefined) throw new NotFoundException(`Monitor ${id} not found`)
    const results = await this.results.recent(id, RECENT_RESULTS)
    return { ...toView(monitor, this.scheduler.jobOf(id)), results }
  }

  /**
   * POST /monitors: `{ name, url, every: '30s' }` or `{ name, url, cron: '*\/5 * * * *', timeZone }`.
   * The schedule is validated by the scheduler's own engine (`CreateMonitor`): an invalid one answers
   * 400 with the same message as a build error, before anything is stored.
   */
  @Post()
  @Roles(['admin'])
  async create(@Body(CreateMonitor) input: CreateMonitor): Promise<HttpResponse> {
    const monitor = await this.scheduler.create(input)
    return HttpResponse.created(toView(monitor, this.scheduler.jobOf(monitor.id)), `/monitors/${monitor.id}`)
  }

  /** DELETE /monitors/42: 204; the job is removed and a probe in flight is aborted. */
  @Delete('/:id')
  @Roles(['admin'])
  async remove(@Param('id') id: number): Promise<void> {
    if (!(await this.scheduler.delete(id))) throw new NotFoundException(`Monitor ${id} not found`)
  }
}
