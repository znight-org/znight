import type { HttpPlugin } from '@znight/http'
import type { Logger } from '@znight/observability'
import type { OpenApi } from '@znight/openapi'

import { Injectable, type OnReady, type OnStop } from '@znight/core'

/**
 * Lifecycle hooks are duck-typed: any singleton implementing `onStart`, `onReady` or `onStop` is
 * called by the application, no registration needed.
 *
 * - `onReady` runs once everything listens: the HTTP plugin knows its actual address (even with
 *   `PORT=0`), and `OpenApi` (provided by `OpenApiPlugin`) its operations.
 * - `onStop` runs on shutdown (SIGINT / SIGTERM), once the HTTP server stopped accepting requests
 *   and drained the in-flight ones (streamed NDJSON exports included).
 */
@Injectable()
export class AppLifecycle implements OnReady, OnStop {
  constructor(
    private readonly http: HttpPlugin,
    private readonly openapi: OpenApi,
    private readonly logger: Logger,
  ) {}

  onReady(): void {
    this.logger.info('Storefront API ready', {
      url: this.http.address?.url,
      operations: this.openapi.operations.length,
    })
  }

  onStop(): void {
    this.logger.info('Storefront API stopping')
  }
}
