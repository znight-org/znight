import { Config, Secret } from '@znight/config'

/**
 * Messaging settings (`MESSAGING_*` variables). The broker is chosen from them in
 * `src/messaging/messaging.options.ts`: RabbitMQ when `RABBITMQ_URL` is set, otherwise the
 * in-memory broker (a single process: development, tests, demos).
 */
@Config('messaging')
export class MessagingConfig {
  /**
   * AMQP URL of RabbitMQ (`RABBITMQ_URL`, e.g. `amqp://guest:guest@localhost:5672`). It usually
   * carries credentials: `@Secret` masks it whenever the configuration is printed or serialised.
   */
  @Secret('RABBITMQ_URL')
  rabbitmqUrl?: string

  /** Messages handled concurrently by each consumer (`MESSAGING_CONCURRENCY`, the RabbitMQ prefetch). */
  concurrency = 4

  /** Type of the queues declared on RabbitMQ (`MESSAGING_QUEUE_TYPE`): quorum queues are the safe default. */
  queueType: 'quorum' | 'classic' = 'quorum'
}
