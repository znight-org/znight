import type { HttpPlugin } from '@znight/http'
import type { Logger } from '@znight/observability'

import { Injectable, type OnReady, type OnStop } from '@znight/core'

/**
 * `onReady` runs once every plugin listens (the actual port is known, even with `PORT=0`); `onStop`
 * on shutdown, once the HTTP server has drained the in-flight requests.
 */
@Injectable()
export class AppLifecycle implements OnReady, OnStop {
  constructor(
    private readonly http: HttpPlugin,
    private readonly logger: Logger,
  ) {}

  onReady(): void {
    this.logger.info('Notes API ready', { url: this.http.address?.url, routes: this.http.routes.length })
  }

  onStop(): void {
    this.logger.info('Notes API stopping', { inflightRequests: this.http.inflight })
  }
}
