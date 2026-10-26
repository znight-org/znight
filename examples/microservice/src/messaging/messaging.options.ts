import type { MessagingPluginOptions } from '@znight/messaging'
import type { MessagingConfig } from '../config/messaging.config.js'

import { memory } from '@znight/messaging/memory'
import { rabbitmq } from '@znight/messaging/rabbitmq'

/**
 * Options of MessagingPlugin, computed from the configuration: RabbitMQ when `RABBITMQ_URL` is set,
 * otherwise the in-memory broker. Consumers and publishers do not change: only the driver does.
 *
 * - The in-memory broker lives in the process: perfect for development and tests, but messages are
 *   lost on restart and never shared between instances.
 * - With RabbitMQ the queues (`orders.created`, `orders.created.dlq` and the retry delay queues) are
 *   declared at startup; publications are confirmed by the broker.
 */
export function messagingOptions(config: MessagingConfig): MessagingPluginOptions {
  const url = config.rabbitmqUrl?.trim() ?? '' // `RABBITMQ_URL=` (blank) also means "no RabbitMQ"
  const driver =
    url === '' ? memory() : rabbitmq({ url, queueType: config.queueType, connectionName: 'orders-service' })
  return { driver, defaults: { concurrency: config.concurrency } }
}
