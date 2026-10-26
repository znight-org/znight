import { MessagingConfig } from '../src/config/messaging.config.js'
import { messagingOptions } from '../src/messaging/messaging.options.js'
import { describe, expect, test as it } from 'bun:test'

function config(values: Partial<MessagingConfig>): MessagingConfig {
  return Object.assign(new MessagingConfig(), values)
}

describe('messagingOptions()', () => {
  it('uses the in-memory broker without RABBITMQ_URL', () => {
    const options = messagingOptions(config({}))

    expect(options.driver.name).toBe('memory')
    expect(options.defaults?.concurrency).toBe(4)
    expect(messagingOptions(config({ rabbitmqUrl: ' ' })).driver.name).toBe('memory')
  })

  it('uses RabbitMQ when RABBITMQ_URL is set (nothing connects before the application starts)', () => {
    const options = messagingOptions(config({ rabbitmqUrl: 'amqp://guest:guest@localhost:5672', concurrency: 8 }))

    expect(options.driver.name).toBe('rabbitmq')
    expect(options.driver.deadLetterName('orders.created')).toBe('orders.created.dlq')
    expect(options.defaults?.concurrency).toBe(8)
  })
})
