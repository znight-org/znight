import type { Logger } from '@znight/observability'
import type { NotificationService } from '../notifications/notification.service.js'
import type { WorkerConfig } from '../worker.config.js'

import { Injectable, type OnStart, type OnStop } from '@znight/core'

/**
 * Liveness of the worker: a log line every `WORKER_HEARTBEAT_MS`, and a summary on shutdown.
 *
 * Its timer also keeps the process alive with the in-memory broker (a real broker connection does
 * that in production). `onStop` runs on SIGTERM after MessagingPlugin stopped the consumers and
 * waited for the messages in flight.
 */
@Injectable()
export class Heartbeat implements OnStart, OnStop {
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly config: WorkerConfig,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
  ) {}

  onStart(): void {
    this.#timer = setInterval(
      () => this.logger.info('Worker alive', { sent: this.notifications.sent }),
      this.config.heartbeatMs,
    )
  }

  onStop(): void {
    clearInterval(this.#timer)
    this.logger.info('Notifications worker stopped', { sent: this.notifications.sent })
  }
}
