/**
 * `@znight/messaging/rabbitmq`: RabbitMQ driver built on [amqplib](https://amqp-node.github.io/amqplib/)
 * 2.x (optional peer dependency).
 *
 * - Publishes through a confirm channel (`publish()` resolves on broker confirmation) with
 *   `mandatory` routing: publishing to a queue that does not exist fails instead of dropping the message.
 * - One channel per consumer, `prefetch = concurrency`, manual acknowledgements.
 * - Retries are republished copies carrying `x-znight-attempt`: immediately to the queue, or through a
 *   delay queue (`<queue>.delay.<ms>`, queue-level TTL dead-lettering back into the queue: no
 *   head-of-line blocking between delays). The original is acknowledged once the copy is confirmed.
 * - Attempts = `x-znight-attempt` + broker redeliveries (`x-delivery-count` of quorum queues, or the
 *   `redelivered` flag of classic queues).
 * - Dead letters are published (confirmed) to `<queue>.dlq`, then the original is acknowledged; without
 *   dead-letter queue the message is rejected (`nack` without requeue), so a queue DLX policy applies.
 * - Declares the queues it uses (`assertTopology`, default) or verifies they exist.
 * - Reconnects after a connection loss (exponential backoff) and resumes the subscriptions.
 */
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  MessageProperties,
  Options,
  SocketOptions,
} from 'amqplib'
import type {
  DeadLetterRequest,
  DeliveryHandler,
  DriverCapabilities,
  DriverContext,
  DriverDelivery,
  MessagingDriver,
  RetryRequest,
  SubscribeOptions,
  Subscription,
} from '../driver.ts'
import type { OutboundMessage } from '../message.ts'

import { connect as amqpConnect } from 'amqplib'

import { brokerUnavailableError, consumerError } from '../errors.ts'
import { attemptFromHeaders, MessagingHeaders } from '../headers.ts'
import { errorMessage, sleep, truncate } from '../internal/async.ts'
import { durationOption, MAX_ERROR_HEADER_LENGTH, readHeader, toHeaderRecord } from './shared.ts'

/** Reconnection settings. */
export interface RabbitMQReconnectOptions {
  /** First delay before reconnecting. Default: 100 ms. */
  readonly initialDelayMs?: number
  /** Longest delay between attempts. Default: 30 000 ms. */
  readonly maxDelayMs?: number
}

/** Options of {@link rabbitmq}. */
export interface RabbitMQDriverOptions {
  /** `amqp://user:pass@host:5672/vhost` or amqplib connection options. */
  readonly url: string | Options.Connect
  /** Socket / TLS options passed to amqplib. */
  readonly socketOptions?: SocketOptions
  /**
   * Declare the queues used by consumers (consumed, dead-letter and delay queues) and by delayed
   * publications. When `false`, consumed and dead-letter queues must exist (verified at subscribe).
   * Default: `true`.
   */
  readonly assertTopology?: boolean
  /** Type of the declared queues. Default: `quorum` (replicated, native `x-delivery-count`). */
  readonly queueType?: 'quorum' | 'classic'
  /** Extra arguments of declared consumed and dead-letter queues (`x-max-length`...). */
  readonly queueArguments?: Readonly<Record<string, unknown>>
  /** Longest retry delay waited in-process (holding the message). Default: 5000 ms. */
  readonly maxInProcessDelayMs?: number
  /** Name of the delay queue of `queue` for `delayMs`. Default: `${queue}.delay.${delayMs}`. */
  readonly delayQueueName?: (queue: string, delayMs: number) => string
  /** Default dead-letter queue name. Default: `${queue}.dlq`. */
  readonly deadLetterName?: (queue: string) => string
  /** Publish with `mandatory`: unroutable messages make `publish()` fail. Default: `true`. */
  readonly mandatory?: boolean
  /** Persistent messages (delivery mode 2). Default: `true`. */
  readonly persistent?: boolean
  /** Use the routing key as message type when the message has none (topic exchanges). Default: `false`. */
  readonly typeFromRoutingKey?: boolean
  /** Reconnect after a connection loss. `false` disables. Default: enabled. */
  readonly reconnect?: RabbitMQReconnectOptions | false
  /** Connection name shown in the management UI. Default: `znight`. */
  readonly connectionName?: string
}

/** Largest TTL RabbitMQ accepts (2^32 - 1 ms). */
const MAX_TTL_MS = 4_294_967_295
const DEFAULT_IN_PROCESS_DELAY_MS = 5000
/** Headers managed by the broker, removed from republished copies. */
const BROKER_HEADERS = new Set([
  'x-delivery-count',
  'x-death',
  'x-first-death-exchange',
  'x-first-death-queue',
  'x-first-death-reason',
  'x-last-death-exchange',
  'x-last-death-queue',
  'x-last-death-reason',
])

/** Creates a {@link RabbitMQDriver}. */
export function rabbitmq(options: RabbitMQDriverOptions): RabbitMQDriver {
  return new RabbitMQDriver(options)
}

interface PendingConfirm {
  returned: boolean
}

interface ConsumerSubscription {
  readonly queue: string
  readonly handler: DeliveryHandler
  readonly options: SubscribeOptions
  channel: Channel | undefined
  consumerTag: string | undefined
  active: boolean
  /** In-progress (re)subscription. */
  consuming: Promise<void> | undefined
}

/** RabbitMQ {@link MessagingDriver}. See the module documentation. */
export class RabbitMQDriver implements MessagingDriver {
  readonly name = 'rabbitmq'
  readonly capabilities: DriverCapabilities
  readonly #options: RabbitMQDriverOptions
  readonly #queueType: 'quorum' | 'classic'
  readonly #assertTopology: boolean
  readonly #subscriptions = new Set<ConsumerSubscription>()
  /** Delay queues already declared, by name. */
  readonly #delayQueues = new Map<string, Promise<void>>()
  /** Publications awaiting their confirmation, by message id (to detect returned messages). */
  readonly #pending = new Map<string, PendingConfirm[]>()
  readonly #abort = new AbortController()
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #model: ChannelModel | undefined
  #publisher: Promise<ConfirmChannel> | undefined
  #closing = false
  #reconnecting: Promise<void> | undefined

  constructor(options: RabbitMQDriverOptions) {
    if (options === null || typeof options !== 'object' || options.url === undefined) {
      throw new TypeError('[znight] rabbitmq(): the "url" option is required')
    }
    this.#options = options
    this.#queueType = options.queueType ?? 'quorum'
    this.#assertTopology = options.assertTopology ?? true
    this.capabilities = Object.freeze({
      nativeDelay: true,
      maxNativeDelayMs: MAX_TTL_MS,
      maxInProcessDelayMs: durationOption(
        options.maxInProcessDelayMs,
        DEFAULT_IN_PROCESS_DELAY_MS,
        'rabbitmq maxInProcessDelayMs',
      ),
      deliveryCount: this.#queueType === 'quorum' ? 'native' : 'header',
      maxPublishDelayMs: MAX_TTL_MS,
    })
  }

  // -----------------------------------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------------------------------

  async connect(context: DriverContext): Promise<void> {
    this.#logger = context.logger
    if (this.#model !== undefined) return
    if (this.#closing) throw brokerUnavailableError('RabbitMQ: the driver is closed, create a new one')
    await this.#open()
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    this.#abort.abort()
    for (const subscription of this.#subscriptions) {
      subscription.active = false
      const channel = subscription.channel
      subscription.channel = undefined
      if (channel !== undefined) await closeQuietly(channel)
    }
    this.#subscriptions.clear()
    const publisher = this.#publisher
    this.#publisher = undefined
    if (publisher !== undefined) {
      try {
        await closeQuietly(await publisher)
      } catch {
        // the channel never opened
      }
    }
    const model = this.#model
    this.#model = undefined
    if (model !== undefined) {
      try {
        await model.close()
      } catch {
        // already closed
      }
    }
  }

  deadLetterName(queue: string): string {
    return this.#options.deadLetterName?.(queue) ?? `${queue}.dlq`
  }

  async #open(): Promise<void> {
    const socketOptions: SocketOptions = {
      ...this.#options.socketOptions,
      clientProperties: {
        connection_name: this.#options.connectionName ?? 'znight',
        ...this.#options.socketOptions?.clientProperties,
      },
    }
    const model = await amqpConnect(this.#options.url, socketOptions)
    model.on('error', (error: Error) => {
      this.#logger.error('RabbitMQ connection error', { err: error })
    })
    model.on('close', (error?: Error) => this.#onConnectionClosed(model, error))
    model.on('blocked', (reason: string) => {
      this.#logger.warn(`RabbitMQ connection blocked: ${reason}`)
    })
    model.on('unblocked', () => {
      this.#logger.info('RabbitMQ connection unblocked')
    })
    this.#model = model
    this.#publisher = undefined
    this.#delayQueues.clear()
  }

  #onConnectionClosed(model: ChannelModel, error: Error | undefined): void {
    if (this.#model !== model) return
    this.#model = undefined
    this.#publisher = undefined
    for (const subscription of this.#subscriptions) {
      subscription.channel = undefined
      subscription.consumerTag = undefined
    }
    if (this.#closing) return
    const reconnect = this.#options.reconnect
    this.#logger.error(
      reconnect === false ? 'RabbitMQ connection lost' : 'RabbitMQ connection lost, reconnecting',
      error === undefined ? {} : { err: error },
    )
    if (reconnect !== false) this.#reconnecting ??= this.#reconnect(reconnect ?? {})
  }

  async #reconnect(options: RabbitMQReconnectOptions): Promise<void> {
    let delay = options.initialDelayMs ?? 100
    const maxDelay = options.maxDelayMs ?? 30_000
    try {
      while (!this.#closing) {
        try {
          await sleep(delay, this.#abort.signal)
        } catch {
          return
        }
        try {
          await this.#open()
        } catch (error) {
          delay = Math.min(delay * 2, maxDelay)
          this.#logger.warn(`RabbitMQ reconnection failed, next attempt in ${delay} ms`, { err: error })
          continue
        }
        for (const subscription of this.#subscriptions) {
          try {
            await this.#ensureConsuming(subscription)
          } catch (error) {
            this.#logger.error(`RabbitMQ: cannot consume "${subscription.queue}" after reconnecting`, { err: error })
          }
        }
        this.#logger.info('RabbitMQ connection restored')
        return
      }
    } finally {
      this.#reconnecting = undefined
    }
  }

  #connection(action: string): ChannelModel {
    const model = this.#model
    if (model === undefined) {
      throw brokerUnavailableError(
        this.#closing
          ? `RabbitMQ: cannot ${action}, the driver is closed`
          : `RabbitMQ: cannot ${action}, the connection is not available`,
      )
    }
    return model
  }

  /** Runs `fn` on a temporary channel (failed declarations close the channel they run on). */
  async #withChannel<T>(action: string, fn: (channel: Channel) => Promise<T>): Promise<T> {
    const channel = await this.#connection(action).createChannel()
    channel.on('error', () => {
      // reported through the rejected operation
    })
    try {
      return await fn(channel)
    } finally {
      await closeQuietly(channel)
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------------------------------

  async publish(queue: string, message: OutboundMessage): Promise<void> {
    const headers: Record<string, unknown> = { ...message.headers }
    const properties: Options.Publish = {
      messageId: message.id,
      contentType: message.contentType,
      timestamp: Math.floor(message.timestamp / 1000),
      headers,
      persistent: this.#options.persistent ?? true,
      ...(message.type === undefined ? {} : { type: message.type }),
    }
    const content = Buffer.from(message.body)
    if (message.delayMs > 0) {
      const delayQueue = await this.#delayQueue(queue, Math.round(message.delayMs))
      await this.#confirmPublish(delayQueue, content, properties)
      return
    }
    await this.#confirmPublish(queue, content, properties)
  }

  #publisherChannel(): Promise<ConfirmChannel> {
    const existing = this.#publisher
    if (existing !== undefined) return existing
    const model = this.#connection('publish')
    const opening = model.createConfirmChannel().then(channel => {
      channel.on('error', (error: Error) => {
        this.#logger.error('RabbitMQ publisher channel error', { err: error })
      })
      channel.on('close', () => {
        if (this.#publisher === opening) this.#publisher = undefined
      })
      channel.on('return', (returned: { properties: MessageProperties }) => {
        const id = returned.properties.messageId as string | undefined
        const waiting = id === undefined ? undefined : this.#pending.get(id)
        if (waiting !== undefined && waiting.length > 0) (waiting[0] as PendingConfirm).returned = true
      })
      return channel
    })
    opening.catch(() => {
      if (this.#publisher === opening) this.#publisher = undefined
    })
    this.#publisher = opening
    return opening
  }

  /** Publishes to `queue` through the default exchange and waits for the broker confirmation. */
  async #confirmPublish(queue: string, content: Buffer, properties: Options.Publish): Promise<void> {
    const channel = await this.#publisherChannel()
    const mandatory = this.#options.mandatory ?? true
    const id = properties.messageId as string
    const pending: PendingConfirm = { returned: false }
    let waiting = this.#pending.get(id)
    if (waiting === undefined) {
      waiting = []
      this.#pending.set(id, waiting)
    }
    waiting.push(pending)
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          channel.sendToQueue(queue, content, { ...properties, mandatory }, (error: unknown) => {
            if (error !== null && error !== undefined) reject(error instanceof Error ? error : new Error(String(error)))
            else resolve()
          })
        } catch (error) {
          reject(error)
        }
      })
    } catch (error) {
      throw brokerUnavailableError(
        `RabbitMQ: publishing to "${queue}" was not confirmed: ${errorMessage(error)}`,
        error,
      )
    } finally {
      const index = waiting.indexOf(pending)
      if (index !== -1) waiting.splice(index, 1)
      if (waiting.length === 0) this.#pending.delete(id)
    }
    if (pending.returned) {
      throw brokerUnavailableError(`RabbitMQ: message ${id} is unroutable, queue "${queue}" does not exist`)
    }
  }

  /** Declares (once per connection) the delay queue of `queue` for `delayMs` and returns its name. */
  async #delayQueue(queue: string, delayMs: number): Promise<string> {
    const name = this.#options.delayQueueName?.(queue, delayMs) ?? `${queue}.delay.${delayMs}`
    let declared = this.#delayQueues.get(name)
    if (declared === undefined) {
      const args: Record<string, unknown> = {
        'x-queue-type': this.#queueType,
        'x-message-ttl': delayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
      }
      if (this.#queueType === 'quorum') {
        // never lose a message while moving it back to its queue
        args['x-dead-letter-strategy'] = 'at-least-once'
        args['x-overflow'] = 'reject-publish'
      }
      declared = this.#withChannel(`declare the delay queue "${name}"`, async channel => {
        await channel.assertQueue(name, { durable: true, arguments: args })
      })
      this.#delayQueues.set(name, declared)
      declared.catch(() => this.#delayQueues.delete(name))
    }
    try {
      await declared
    } catch (error) {
      throw topologyError(name, error)
    }
    return name
  }

  // -----------------------------------------------------------------------------------------------
  // Consuming
  // -----------------------------------------------------------------------------------------------

  async subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    await this.#prepareTopology(queue, options)
    const subscription: ConsumerSubscription = {
      queue,
      handler,
      options,
      channel: undefined,
      consumerTag: undefined,
      active: true,
      consuming: undefined,
    }
    await this.#ensureConsuming(subscription)
    this.#subscriptions.add(subscription)
    return {
      cancel: async (): Promise<void> => {
        subscription.active = false
        const { channel, consumerTag } = subscription
        if (channel !== undefined && consumerTag !== undefined) {
          subscription.consumerTag = undefined
          try {
            await channel.cancel(consumerTag)
          } catch (error) {
            this.#logger.warn(`RabbitMQ: failed to cancel the consumer of "${queue}"`, { err: error })
          }
        }
      },
      close: async (): Promise<void> => {
        subscription.active = false
        this.#subscriptions.delete(subscription)
        const channel = subscription.channel
        subscription.channel = undefined
        if (channel !== undefined) await closeQuietly(channel)
      },
    }
  }

  async #prepareTopology(queue: string, options: SubscribeOptions): Promise<void> {
    const dlq = options.deadLetterQueue
    if (this.#assertTopology) {
      const queueOptions: Options.AssertQueue = {
        durable: true,
        arguments: { 'x-queue-type': this.#queueType, ...this.#options.queueArguments },
      }
      for (const name of dlq === undefined ? [queue] : [queue, dlq]) {
        try {
          await this.#withChannel(`declare the queue "${name}"`, async channel => {
            await channel.assertQueue(name, queueOptions)
          })
        } catch (error) {
          throw topologyError(name, error)
        }
      }
    } else {
      for (const name of dlq === undefined ? [queue] : [queue, dlq]) {
        try {
          await this.#withChannel(`check the queue "${name}"`, channel => channel.checkQueue(name))
        } catch (error) {
          throw consumerError(
            `RabbitMQ: queue "${name}" of consumer ${options.consumer} does not exist (${errorMessage(error)})`,
            ['Declare it, or set assertTopology: true to let Znight declare it'],
          )
        }
      }
    }
    for (const delay of options.retryDelays) await this.#delayQueue(queue, Math.round(delay))
  }

  /** Opens the consumer channel of `subscription` unless it is open or opening. */
  #ensureConsuming(subscription: ConsumerSubscription): Promise<void> {
    if (!subscription.active || subscription.channel !== undefined) return Promise.resolve()
    subscription.consuming ??= this.#consume(subscription).finally(() => {
      subscription.consuming = undefined
    })
    return subscription.consuming
  }

  async #consume(subscription: ConsumerSubscription): Promise<void> {
    const channel = await this.#connection(`consume "${subscription.queue}"`).createChannel()
    channel.on('error', (error: Error) => {
      this.#logger.error(`RabbitMQ consumer channel of "${subscription.queue}" failed`, { err: error })
    })
    channel.on('close', () => {
      if (subscription.channel !== channel) return
      subscription.channel = undefined
      subscription.consumerTag = undefined
      if (subscription.active && !this.#closing) this.#resubscribeLater(subscription)
    })
    try {
      await channel.prefetch(subscription.options.concurrency)
      subscription.channel = channel
      const { consumerTag } = await channel.consume(
        subscription.queue,
        message => {
          if (message === null) {
            this.#logger.error(`RabbitMQ cancelled the consumer of "${subscription.queue}" (queue deleted?)`)
            subscription.consumerTag = undefined
            return
          }
          this.#deliver(subscription, channel, message)
        },
        { noAck: false },
      )
      subscription.consumerTag = consumerTag
    } catch (error) {
      subscription.channel = undefined
      await closeQuietly(channel)
      throw brokerUnavailableError(`RabbitMQ: cannot consume "${subscription.queue}": ${errorMessage(error)}`, error)
    }
  }

  /** A consumer channel closed while its connection may still be up (channel error): consume again. */
  #resubscribeLater(subscription: ConsumerSubscription): void {
    sleep(250, this.#abort.signal).then(
      async () => {
        // after a connection loss, the reconnection loop resubscribes
        if (this.#model === undefined || this.#reconnecting !== undefined) return
        this.#logger.warn(`RabbitMQ: consumer channel of "${subscription.queue}" closed, consuming again`)
        try {
          await this.#ensureConsuming(subscription)
        } catch (error) {
          this.#logger.error(`RabbitMQ: cannot consume "${subscription.queue}" again`, { err: error })
        }
      },
      () => undefined,
    )
  }

  #deliver(subscription: ConsumerSubscription, channel: Channel, message: ConsumeMessage): void {
    const { queue } = subscription
    const properties = message.properties
    const rawHeaders: Record<string, unknown> = { ...(properties.headers ?? {}) }
    const headers = toHeaderRecord(Object.entries(rawHeaders))
    // quorum queues count redeliveries; classic queues only flag them
    const deliveryCount = Number(rawHeaders['x-delivery-count'])
    let redeliveries = message.fields.redelivered ? 1 : 0
    if (Number.isSafeInteger(deliveryCount) && deliveryCount > 0) redeliveries = deliveryCount
    const type =
      stringProperty(properties.type) ??
      readHeader(headers, MessagingHeaders.Type) ??
      (this.#options.typeFromRoutingKey === true && message.fields.exchange !== ''
        ? message.fields.routingKey
        : undefined)
    const id = stringProperty(properties.messageId) ?? `${queue}:${message.fields.deliveryTag}`
    const timestamp = typeof properties.timestamp === 'number' ? properties.timestamp * 1000 : undefined
    let settled = false
    const settle = (action: string): void => {
      if (settled) throw new Error(`[rabbitmq] message ${id} was already settled (${action})`)
      if (subscription.channel !== channel) {
        throw brokerUnavailableError(
          `RabbitMQ: cannot ${action} message ${id}, its channel is closed (it will be redelivered)`,
        )
      }
    }
    const copyProperties = (extraHeaders: Record<string, unknown>, removeAttempt: boolean): Options.Publish => {
      const copied: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(rawHeaders)) {
        if (BROKER_HEADERS.has(name) || (removeAttempt && name === MessagingHeaders.Attempt)) continue
        copied[name] = value
      }
      return {
        ...definedProperties(properties),
        messageId: id,
        headers: { ...copied, ...extraHeaders },
        persistent: this.#options.persistent ?? true,
      }
    }
    const delivery: DriverDelivery = {
      id,
      body: message.content,
      contentType: stringProperty(properties.contentType),
      headers,
      type,
      key: undefined,
      attempt: attemptFromHeaders(headers) + redeliveries,
      redelivered: message.fields.redelivered,
      timestamp,
      raw: message,
      ack: async (): Promise<void> => {
        await Promise.resolve()
        settle('ack')
        channel.ack(message)
        settled = true
      },
      release: async (): Promise<void> => {
        await Promise.resolve()
        settle('release')
        channel.nack(message, false, true)
        settled = true
      },
      retry: async (request: RetryRequest): Promise<void> => {
        settle('retry')
        const target = request.delayMs > 0 ? await this.#delayQueue(queue, Math.round(request.delayMs)) : queue
        await this.#confirmPublish(
          target,
          message.content,
          copyProperties({ [MessagingHeaders.Attempt]: String(request.attempt) }, false),
        )
        settle('retry')
        channel.ack(message)
        settled = true
      },
      deadLetter: async (request: DeadLetterRequest): Promise<void> => {
        settle('dead-letter')
        if (request.queue === undefined) {
          channel.nack(message, false, false)
          settled = true
          return
        }
        await this.#confirmPublish(
          request.queue,
          message.content,
          copyProperties(
            {
              [MessagingHeaders.DeadLetterReason]: request.reason,
              [MessagingHeaders.Error]: truncate(errorMessage(request.error), MAX_ERROR_HEADER_LENGTH),
              [MessagingHeaders.OriginalQueue]: queue,
              [MessagingHeaders.Attempts]: String(request.attempt),
            },
            true,
          ),
        )
        settle('dead-letter')
        channel.ack(message)
        settled = true
      },
    }
    subscription.handler(delivery).catch((error: unknown) => {
      this.#logger.error(`RabbitMQ: unexpected failure handling message ${id}`, { err: error })
    })
  }
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** AMQP properties of a received message, reusable for a republication. */
function definedProperties(properties: MessageProperties): Options.Publish {
  const result: Options.Publish = {}
  if (properties.contentType !== undefined) result.contentType = properties.contentType
  if (properties.contentEncoding !== undefined) result.contentEncoding = properties.contentEncoding
  if (properties.correlationId !== undefined) result.correlationId = properties.correlationId
  if (properties.replyTo !== undefined) result.replyTo = properties.replyTo
  if (properties.timestamp !== undefined) result.timestamp = properties.timestamp
  if (properties.type !== undefined) result.type = properties.type
  if (properties.appId !== undefined) result.appId = properties.appId
  if (properties.priority !== undefined) result.priority = properties.priority
  if (properties.userId !== undefined) result.userId = properties.userId
  return result
}

function topologyError(queue: string, error: unknown): Error {
  const message = errorMessage(error)
  const hints = message.includes('PRECONDITION_FAILED')
    ? ['The queue exists with different arguments: align queueType/queueArguments, or set assertTopology: false']
    : []
  return consumerError(`RabbitMQ: cannot declare the queue "${queue}": ${message}`, hints)
}

async function closeQuietly(channel: Channel): Promise<void> {
  try {
    await channel.close()
  } catch {
    // already closed
  }
}
