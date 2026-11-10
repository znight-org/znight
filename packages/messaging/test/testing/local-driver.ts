/** A minimal messaging driver over an in-process broker, conformant (`describeDriverConformance()`). */
import type {
  DeadLetterRequest,
  DeliveryHandler,
  DriverCapabilities,
  DriverContext,
  DriverDelivery,
  MessagingDriver,
  OutboundMessage,
  RetryRequest,
  SubscribeOptions,
  Subscription,
} from '@znight/messaging'

import { attemptFromHeaders, deadLetterHeaders, MessagingHeaders } from '@znight/messaging'

/** The "broker": queues shared by every driver created on it (a real driver holds a client instead). */
export class LocalBroker {
  readonly #queues = new Map<string, OutboundMessage[]>()

  /** The messages of a queue, oldest first. */
  queue(name: string): OutboundMessage[] {
    const messages = this.#queues.get(name) ?? []
    this.#queues.set(name, messages)
    return messages
  }

  /** Stores a message, now or after `delayMs` (the broker's delayed delivery). */
  enqueue(name: string, message: OutboundMessage, delayMs: number): Promise<void> {
    if (delayMs <= 0) this.queue(name).push(message)
    else setTimeout(() => this.queue(name).push(message), delayMs)
    return Promise.resolve() // a real broker confirms the write
  }
}

export interface LocalDriverOptions {
  /** Longest retry delay the runtime waits in-process. Default: 1000 ms. */
  readonly maxInProcessDelayMs?: number
}

export function localDriver(broker: LocalBroker, options: LocalDriverOptions = {}): MessagingDriver {
  return new LocalDriver(broker, options)
}

const MAX_DELAY_MS = 2 ** 31 - 1

class LocalDriver implements MessagingDriver {
  readonly name = 'local'
  readonly capabilities: DriverCapabilities
  readonly #broker: LocalBroker
  readonly #subscriptions = new Set<LocalSubscription>()
  #context: DriverContext | undefined

  constructor(broker: LocalBroker, options: LocalDriverOptions) {
    this.#broker = broker
    this.capabilities = {
      nativeDelay: true, // retries are enqueued again after their delay
      maxNativeDelayMs: MAX_DELAY_MS,
      maxInProcessDelayMs: options.maxInProcessDelayMs ?? 1000,
      deliveryCount: 'header', // attempts travel in the x-znight-attempt header of the copies
      maxPublishDelayMs: MAX_DELAY_MS,
    }
  }

  connect(context: DriverContext): Promise<void> {
    this.#context = context // a real driver opens its connection here
    return Promise.resolve()
  }

  deadLetterName(queue: string): string {
    return `${queue}.dlq`
  }

  publish(queue: string, message: OutboundMessage): Promise<void> {
    return this.#broker.enqueue(queue, message, message.delayMs)
  }

  subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    // a real driver verifies here that `queue` and `options.deadLetterQueue` exist
    const logger = this.#context?.logger
    const subscription = new LocalSubscription(this.#broker, queue, options.concurrency, delivery =>
      handler(delivery).catch((error: unknown) => logger?.error('[local] delivery failed', { error })),
    )
    this.#subscriptions.add(subscription)
    return Promise.resolve(subscription)
  }

  async close(): Promise<void> {
    for (const subscription of this.#subscriptions) await subscription.close()
    this.#subscriptions.clear()
  }
}

class LocalSubscription implements Subscription {
  readonly #inflight = new Set<Promise<void>>()
  readonly #timer: ReturnType<typeof setInterval>

  constructor(broker: LocalBroker, queue: string, concurrency: number, handle: DeliveryHandler) {
    this.#timer = setInterval(() => {
      const messages = broker.queue(queue)
      // back-pressure: never more than `concurrency` deliveries in flight
      while (this.#inflight.size < concurrency && messages.length > 0) {
        const delivery = toDelivery(broker, queue, messages.shift() as OutboundMessage)
        const handled: Promise<void> = handle(delivery).finally(() => this.#inflight.delete(handled))
        this.#inflight.add(handled)
      }
    }, 10)
  }

  cancel(): Promise<void> {
    clearInterval(this.#timer) // stop receiving
    return Promise.resolve()
  }

  async close(): Promise<void> {
    clearInterval(this.#timer)
    await Promise.all(this.#inflight) // the runtime settles what it received
  }
}

function toDelivery(broker: LocalBroker, queue: string, message: OutboundMessage): DriverDelivery {
  return {
    id: message.id,
    body: message.body,
    contentType: message.contentType,
    headers: message.headers,
    type: message.type,
    key: message.key,
    attempt: attemptFromHeaders(message.headers),
    redelivered: false,
    timestamp: message.timestamp,
    raw: message,
    // a received message left the queue: nothing to acknowledge
    ack: () => Promise.resolve(),
    retry: ({ attempt, delayMs }: RetryRequest) => {
      const headers = { ...message.headers, [MessagingHeaders.Attempt]: String(attempt) }
      return broker.enqueue(queue, { ...message, headers }, delayMs)
    },
    deadLetter: (request: DeadLetterRequest) => {
      // `request.queue` is undefined when dead-lettering is disabled: the message is dropped
      if (request.queue === undefined) return Promise.resolve()
      const headers = deadLetterHeaders(message.headers, request, queue)
      return broker.enqueue(request.queue, { ...message, headers }, 0)
    },
    release: () => {
      broker.queue(queue).unshift(message) // back at the head, for a later redelivery
      return Promise.resolve()
    },
  }
}
