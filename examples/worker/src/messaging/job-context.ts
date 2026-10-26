import type { InboundMessage } from '@znight/messaging'
import type { Logger } from '@znight/observability'

import { Injectable } from '@znight/core'

/** Header carrying the id of the business operation a job belongs to (set by producers). */
export const CORRELATION_HEADER = 'x-correlation-id'

/**
 * Per-message context. `scope: 'request'`: MessagingPlugin runs every delivery in its own request
 * scope, so each message gets its own JobContext (created on first use, disposed when the delivery
 * ends). It is built from the `InboundMessage`, a request-scoped value provided by MessagingPlugin.
 *
 * - request-scoped providers (ReportConsumer) inject it directly;
 * - singletons (EmailService) inject `Lazy<JobContext>` and call `.get()` while handling a message
 *   (injecting it directly would be a build error: ZNIGHT003, scope mismatch).
 */
@Injectable({ scope: 'request' })
export class JobContext {
  /** A logger whose entries all carry the job id, queue, attempt and correlation id. */
  readonly logger: Logger

  constructor(
    readonly message: InboundMessage,
    logger: Logger,
  ) {
    this.logger = logger.child({
      jobId: message.id,
      queue: message.queue,
      attempt: message.attempt,
      correlationId: this.correlationId,
    })
  }

  /** The id of the operation this job belongs to: the producer's correlation id, else the message id. */
  get correlationId(): string {
    return this.message.headers[CORRELATION_HEADER] ?? this.message.id
  }

  /** Whether a failure now sends the message to the dead-letter queue instead of retrying it. */
  get isLastAttempt(): boolean {
    return this.message.attempt >= this.message.maxAttempts
  }

  /** Aborted when the worker shuts down (the handler still gets time to finish: graceful drain). */
  get shutdownSignal(): AbortSignal {
    return this.message.signal
  }
}
