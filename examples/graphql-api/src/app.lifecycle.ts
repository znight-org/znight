import type { OnReady, OnStop } from '@znight/core'
import type { HttpPlugin } from '@znight/http'
import type { Logger } from '@znight/observability'

import { Injectable } from '@znight/core'

/**
 * Announces the service. Lifecycle hooks are duck-typed: any singleton implementing `onStart`,
 * `onReady` or `onStop` is called by the application, no registration needed.
 *
 * - `onReady` runs once every provider started and every plugin listens: the HTTP plugin knows its
 *   actual port, even with `PORT=0`.
 * - `onStop` runs on shutdown, once HTTP drained its requests and closed the subscription streams.
 */
@Injectable()
export class AppLifecycle implements OnReady, OnStop {
  constructor(
    private readonly http: HttpPlugin,
    private readonly logger: Logger,
  ) {}

  onReady(): void {
    const url = this.http.address?.url
    this.logger.info('Book catalog ready', { url, graphql: url === undefined ? undefined : `${url}/graphql` })
  }

  onStop(): void {
    this.logger.info('Book catalog stopping')
  }
}
