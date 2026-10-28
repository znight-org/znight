import type { Application, OnReady, OnStop } from '@znight/core'
import type { HttpPlugin } from '@znight/http'
import type { Logger } from '@znight/observability'
import type { SchedulePluginInstance } from '@znight/schedule'

import { Injectable } from '@znight/core'
import { SCHEDULE_PLUGIN_NAME } from '@znight/schedule'

/**
 * Announces the service. Lifecycle hooks are duck-typed: any singleton implementing `onStart`,
 * `onReady` or `onStop` is called by the application, no registration needed.
 *
 * - `onReady` runs once every provider started and every plugin listens (the HTTP plugin knows its
 *   actual port, even with `PORT=0`), and **before** the plugins' own `onReady`: the scheduler arms
 *   its jobs right after, and logs `Schedule: N job(s), next: <job> at <date>`.
 * - `onStop` runs on shutdown, once HTTP drained its requests and the scheduler drained its jobs.
 */
@Injectable()
export class AppLifecycle implements OnReady, OnStop {
  constructor(
    private readonly app: Application,
    private readonly http: HttpPlugin,
    private readonly logger: Logger,
  ) {}

  onReady(): void {
    const schedule = this.app.getPlugin<SchedulePluginInstance>(SCHEDULE_PLUGIN_NAME)
    this.logger.info('Uptime monitor ready', {
      url: this.http.address?.url,
      jobs: schedule?.registry.jobs().length,
    })
  }

  onStop(): void {
    this.logger.info('Uptime monitor stopping')
  }
}
