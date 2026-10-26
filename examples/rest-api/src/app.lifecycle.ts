import type { HttpPlugin } from '@znight/http'
import type { Logger, ObservabilityPluginInstance } from '@znight/observability'

import { type Application, Injectable, type OnReady, type OnStop } from '@znight/core'

/**
 * Lifecycle hooks are duck-typed: any singleton implementing `onStart`, `onReady` or `onStop` is
 * called by the application, no registration needed.
 *
 * - `onReady` runs once every provider started and every plugin is listening: the right moment to
 *   announce the service (the HTTP plugin knows its actual port, even with `PORT=0`).
 * - `onStop` runs on shutdown (SIGINT / SIGTERM), once the HTTP plugin stopped accepting requests
 *   and drained the in-flight ones. Providers stop in reverse dependency order: each one before the
 *   providers it depends on (the repository before the database it uses), so a provider that needs
 *   the database in `onStop` simply injects it.
 */
@Injectable()
export class AppLifecycle implements OnReady, OnStop {
  constructor(
    private readonly app: Application,
    private readonly http: HttpPlugin,
    private readonly logger: Logger,
  ) {}

  onReady(): void {
    const observability = this.app.getPlugin<ObservabilityPluginInstance>('observability')
    this.logger.info('Bookshelf API ready', {
      url: this.http.address?.url,
      metricsUrl: observability?.metricsServer?.url,
      routes: this.http.routes.length,
    })
  }

  onStop(): void {
    this.logger.info('Bookshelf API stopping')
  }
}
