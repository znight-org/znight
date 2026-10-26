import type { Hooks } from '@znight/core'
import type { MessageCodec } from './codec.ts'
import type { MessagingDriver } from './driver.ts'
import type { MessagePublishEvent } from './hooks.ts'
import type { OutboundMessage, PublishOptions, PublishResult } from './message.ts'

import { randomUUID } from 'node:crypto'

import { brokerUnavailableError } from './errors.ts'
import { headerRecord } from './headers.ts'

/**
 * Publishes messages. Inject it in any provider (it is a singleton external provided by
 * `MessagingPlugin`):
 *
 * ```ts
 * @Injectable()
 * export class OrderService {
 *   constructor(private readonly broker: MessageBroker) {}
 *
 *   async place(order: Order) {
 *     await this.broker.publish('orders', order, { type: 'order.placed', key: order.customerId })
 *   }
 * }
 * ```
 *
 * `publish()` resolves once the broker confirmed the message (publisher confirms, SQS response,
 * Kafka acknowledgement). It is usable from `onBootstrap` of the messaging plugin until the
 * application is disposed (including providers' `onStart` / `onStop`).
 */
export abstract class MessageBroker {
  /**
   * Publishes `payload` to `queue` (a queue for RabbitMQ/SQS, a topic for Kafka). The payload is
   * encoded by the plugin codec (JSON by default; `Uint8Array` is sent as binary).
   */
  abstract publish(queue: string, payload: unknown, options?: PublishOptions): Promise<PublishResult>
}

const HEADER_NAME = /^[\x21-\x7e]+$/

/** The {@link MessageBroker} registered by `MessagingPlugin` (internal). */
export class DriverMessageBroker extends MessageBroker {
  #driver: MessagingDriver | undefined
  #codec: MessageCodec | undefined
  #hooks: Hooks | undefined
  #closed = false

  /** Connects the broker to the driver (plugin `onBootstrap`). */
  bind(driver: MessagingDriver, codec: MessageCodec, hooks: Hooks): void {
    this.#driver = driver
    this.#codec = codec
    this.#hooks = hooks
    this.#closed = false
  }

  /** Rejects further publications (plugin `onDispose`). */
  unbind(): void {
    this.#closed = true
  }

  override async publish(queue: string, payload: unknown, options: PublishOptions = {}): Promise<PublishResult> {
    const driver = this.#driver
    const codec = this.#codec
    if (driver === undefined || codec === undefined) {
      throw brokerUnavailableError(
        `MessageBroker.publish('${queue}'): the messaging plugin is not bootstrapped yet (publish from onStart or later)`,
      )
    }
    if (this.#closed) {
      throw brokerUnavailableError(`MessageBroker.publish('${queue}'): the messaging plugin has been disposed`)
    }
    const message = this.#prepare(queue, payload, options, codec, driver)
    const hooks = this.#hooks
    const wrapped = hooks?.hasWrappers('messaging:publish') ?? false
    const observed = hooks?.hasListeners('messaging:publish') ?? false
    if (hooks === undefined || (!wrapped && !observed)) {
      await driver.publish(queue, message.outbound())
      return { id: message.id }
    }
    const event: MessagePublishEvent = {
      queue,
      type: options.type,
      messageId: message.id,
      headers: message.headers,
      startTime: performance.now(),
    }
    const send = async (): Promise<void> => {
      try {
        await driver.publish(queue, message.outbound())
      } catch (error) {
        event.error = error // visible to the wrappers before the rejection reaches them
        throw error
      }
    }
    try {
      if (wrapped) await hooks.run('messaging:publish', event, send)
      else await send()
    } finally {
      if (observed) hooks.emit('messaging:publish', event)
    }
    return { id: message.id }
  }

  #prepare(
    queue: string,
    payload: unknown,
    options: PublishOptions,
    codec: MessageCodec,
    driver: MessagingDriver,
  ): { readonly id: string; readonly headers: Record<string, string>; outbound(): OutboundMessage } {
    if (typeof queue !== 'string' || queue === '') {
      throw new TypeError(
        `[znight] MessageBroker.publish(): the queue must be a non-empty string, got ${String(queue)}`,
      )
    }
    const delayMs = options.delay ?? 0
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError(`[znight] MessageBroker.publish('${queue}'): "delay" must be a number of milliseconds >= 0`)
    }
    if (delayMs > driver.capabilities.maxPublishDelayMs) {
      throw new RangeError(
        driver.capabilities.maxPublishDelayMs === 0
          ? `[znight] MessageBroker.publish('${queue}'): the ${driver.name} driver does not support delayed publishing`
          : `[znight] MessageBroker.publish('${queue}'): the ${driver.name} driver supports delays up to ${driver.capabilities.maxPublishDelayMs} ms (got ${delayMs})`,
      )
    }
    const headers = headerRecord()
    if (options.headers !== undefined) {
      for (const [name, value] of Object.entries(options.headers)) {
        if (!HEADER_NAME.test(name))
          throw new TypeError(`[znight] MessageBroker.publish('${queue}'): invalid header name "${name}"`)
        if (typeof value !== 'string') {
          throw new TypeError(`[znight] MessageBroker.publish('${queue}'): header "${name}" must be a string`)
        }
        headers[name] = value
      }
    }
    const id = options.id ?? randomUUID()
    const encoded = codec.encode(payload, options.contentType)
    const timestamp = Date.now()
    return {
      id,
      headers,
      outbound: () => ({
        id,
        type: options.type,
        key: options.key,
        headers: { ...headers },
        body: encoded.body,
        contentType: encoded.contentType,
        timestamp,
        delayMs,
      }),
    }
  }
}
