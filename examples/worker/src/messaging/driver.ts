import type { MessagingDriver } from '@znight/messaging'
import type { WorkerConfig } from '../worker.config.js'

import { memory } from '@znight/messaging/memory'
import { rabbitmq } from '@znight/messaging/rabbitmq'

/**
 * The broker driver: RabbitMQ when RABBITMQ_URL is set, the in-memory broker otherwise (local runs,
 * tests: messages live in the process and are lost when it exits).
 *
 * Consumers are broker-agnostic: switching drivers changes nothing else. With RabbitMQ the driver
 * declares the queues it needs (quorum queues: "emails.send", "reports.generate", their dead-letter
 * and delay queues) and resumes the consumers after a connection loss.
 */
export function createDriver(config: WorkerConfig): MessagingDriver {
  if (config.rabbitmqUrl === undefined) return memory()
  return rabbitmq({ url: config.rabbitmqUrl.href, connectionName: 'znight-worker' })
}
