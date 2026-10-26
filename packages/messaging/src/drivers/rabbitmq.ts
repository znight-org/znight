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
 * - Delayed publications go through a fixed set of 32 delay levels shared by every queue
 *   (`znight.delays.<n>`: a topic exchange and a queue with a TTL of 2^n ms each). The delay is
 *   written in binary in the routing key: the message waits in the level of each set bit, then the last
 *   level dead-letters it to the default exchange, which routes it to its queue (`CC` header).
 * - Attempts = `x-znight-attempt` + broker redeliveries (`x-delivery-count` of quorum queues, or the
 *   `redelivered` flag of classic queues).
 * - Dead letters are published (confirmed) to `<queue>.dlq`, then the original is acknowledged; without
 *   dead-letter queue the message is rejected (`nack` without requeue), so a queue DLX policy applies.
 * - Declares the queues it uses (`assertTopology`, default) or verifies they exist. On RabbitMQ >= 4,
 *   quorum queues are declared with `x-delivery-limit: -1`: Znight counts the attempts itself, the
 *   broker's default limit (20 deliveries) would drop messages released repeatedly.
 * - Recovers from connection losses (reconnection with exponential backoff), closed consumer channels
 *   and consumers cancelled by the broker: every subscription is resumed, with backoff, until it
 *   consumes again.
 */
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Message,
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
  /**
   * Extra arguments of declared consumed and dead-letter queues (`x-max-length`...). Quorum queues get
   * `x-delivery-limit: -1` on RabbitMQ >= 4 unless this sets `x-delivery-limit`.
   */
  readonly queueArguments?: Readonly<Record<string, unknown>>
  /** Longest retry delay waited in-process (holding the message). Default: 5000 ms. */
  readonly maxInProcessDelayMs?: number
  /** Name of the retry delay queue of `queue` for `delayMs`. Default: `${queue}.delay.${delayMs}`. */
  readonly delayQueueName?: (queue: string, delayMs: number) => string
  /**
   * Prefix of the delay levels of delayed publications: `<prefix>.0` to `<prefix>.31` (one topic
   * exchange and one queue each, shared by every queue of the virtual host). Default: `znight.delays`.
   */
  readonly delayLevelPrefix?: string
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
const DEFAULT_DELAY_LEVEL_PREFIX = 'znight.delays'
/** Delay levels of delayed publications: level n waits 2^n ms, all of them together `MAX_TTL_MS`. */
const DELAY_LEVELS = 32
/** First word of the routing key of a delayed publication, followed by one bit per level (highest first). */
const DELAY_ROUTING_WORD = 'znight-delay'
/**
 * Headers never copied to republished messages (retries, dead letters): the ones managed by the broker,
 * and the sender-selected destinations (`CC`, `BCC`), which would route the copy to other queues.
 */
const UNCOPIED_HEADERS = new Set([
  'x-delivery-count',
  'x-death',
  'x-first-death-exchange',
  'x-first-death-queue',
  'x-first-death-reason',
  'x-last-death-exchange',
  'x-last-death-queue',
  'x-last-death-reason',
  'CC',
  'BCC',
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
  /** The broker cancelled the consumer (queue deleted...): declare the queues again before consuming. */
  redeclare: boolean
}

/** RabbitMQ {@link MessagingDriver}. See the module documentation. */
export class RabbitMQDriver implements MessagingDriver {
  readonly name = 'rabbitmq'
  readonly capabilities: DriverCapabilities
  readonly #options: RabbitMQDriverOptions
  readonly #queueType: 'quorum' | 'classic'
  readonly #assertTopology: boolean
  readonly #subscriptions = new Set<ConsumerSubscription>()
  /** Retry delay queues already declared, by name. */
  readonly #delayQueues = new Map<string, Promise<void>>()
  /** Publications awaiting their confirmation, by destination and message id (to detect returned messages). */
  readonly #pending = new Map<string, PendingConfirm[]>()
  readonly #abort = new AbortController()
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #model: ChannelModel | undefined
  #publisher: Promise<ConfirmChannel> | undefined
  /** Declaration of the delay levels on the current connection. */
  #delayLevels: Promise<void> | undefined
  #closing = false
  /** Running recovery loop (reconnection and resubscriptions). */
  #recovering: Promise<void> | undefined

  constructor(options: RabbitMQDriverOptions) {
    if (options === null || typeof options !== 'object' || options.url === undefined) {
      throw new TypeError('[znight] rabbitmq(): the "url" option is required')
    }
    if (
      options.delayLevelPrefix !== undefined &&
      (typeof options.delayLevelPrefix !== 'string' || options.delayLevelPrefix === '')
    ) {
      throw new TypeError('[znight] rabbitmq(): "delayLevelPrefix" must be a non-empty string')
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
    this.#delayLevels = undefined
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
    if (reconnect !== false) this.#recover()
  }

  /**
   * Starts the recovery loop unless it is running. The loop re-reads the whole state (connection,
   * subscriptions without channel) before it ends, so a failure happening while it runs is never lost.
   */
  #recover(): void {
    if (this.#closing) return
    this.#recovering ??= this.#recoverLoop()
  }

  /** Reconnects if needed, then resumes every subscription, with backoff, until everything consumes. */
  async #recoverLoop(): Promise<void> {
    const reconnect = this.#options.reconnect
    const settings = reconnect === false ? {} : (reconnect ?? {})
    const initialDelay = settings.initialDelayMs ?? 100
    const maxDelay = settings.maxDelayMs ?? 30_000
    let delay = initialDelay
    let reconnected = false
    try {
      while (!this.#closing) {
        try {
          await sleep(delay, this.#abort.signal)
        } catch {
          return
        }
        if (this.#model === undefined) {
          if (reconnect === false) return
          try {
            await this.#open()
            reconnected = true
          } catch (error) {
            delay = Math.min(delay * 2, maxDelay)
            this.#logger.warn(`RabbitMQ reconnection failed, next attempt in ${delay} ms`, { err: error })
            continue
          }
        }
        const model = this.#model
        for (const subscription of this.#subscriptions) {
          if (!subscription.active || subscription.channel !== undefined) continue
          try {
            if (subscription.redeclare) await this.#redeclare(subscription)
            await this.#ensureConsuming(subscription)
            if (!reconnected) this.#logger.info(`RabbitMQ: consuming "${subscription.queue}" again`)
          } catch (error) {
            this.#logger.error(`RabbitMQ: cannot consume "${subscription.queue}" again`, { err: error })
          }
        }
        if (this.#closing) return
        if (this.#model !== model) {
          // the connection was lost again while the consumers were resuming
          delay = Math.min(delay * 2, maxDelay)
          continue
        }
        const waiting = [...this.#subscriptions].filter(
          subscription => subscription.active && subscription.channel === undefined,
        )
        if (waiting.length > 0) {
          delay = Math.min(delay * 2, maxDelay)
          this.#logger.warn(
            `RabbitMQ: ${waiting.map(subscription => `"${subscription.queue}"`).join(', ')} not consumed yet, next attempt in ${delay} ms`,
          )
          continue
        }
        if (reconnected) this.#logger.info('RabbitMQ connection restored')
        return
      }
    } finally {
      this.#recovering = undefined
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
      await this.#publishDelayed(queue, content, properties, message.delayMs)
      return
    }
    await this.#confirmPublish('', queue, content, properties, queue)
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
      // a return precedes the confirmation of its publication: mark the oldest pending publication
      // of the same exchange, routing key and message id (never one already returned)
      channel.on('return', (returned: Message) => {
        const key = pendingKey(returned.fields.exchange, returned.fields.routingKey, returned.properties.messageId)
        const pending = this.#pending.get(key)?.find(entry => !entry.returned)
        if (pending !== undefined) pending.returned = true
      })
      return channel
    })
    opening.catch(() => {
      if (this.#publisher === opening) this.#publisher = undefined
    })
    this.#publisher = opening
    return opening
  }

  /**
   * Publishes to `exchange` with `routingKey` and waits for the broker confirmation. `destination`
   * names the target queue in errors.
   */
  async #confirmPublish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    properties: Options.Publish,
    destination: string,
  ): Promise<void> {
    const channel = await this.#publisherChannel()
    const mandatory = this.#options.mandatory ?? true
    const id = properties.messageId as string
    const key = pendingKey(exchange, routingKey, id)
    const pending: PendingConfirm = { returned: false }
    let waiting = this.#pending.get(key)
    if (waiting === undefined) {
      waiting = []
      this.#pending.set(key, waiting)
    }
    waiting.push(pending)
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          channel.publish(exchange, routingKey, content, { ...properties, mandatory }, (error: unknown) => {
            if (error !== null && error !== undefined) reject(error instanceof Error ? error : new Error(String(error)))
            else resolve()
          })
        } catch (error) {
          reject(error)
        }
      })
    } catch (error) {
      throw brokerUnavailableError(
        `RabbitMQ: publishing to "${destination}" was not confirmed: ${errorMessage(error)}`,
        error,
      )
    } finally {
      const index = waiting.indexOf(pending)
      if (index !== -1) waiting.splice(index, 1)
      if (waiting.length === 0 && this.#pending.get(key) === waiting) this.#pending.delete(key)
    }
    if (pending.returned) {
      throw brokerUnavailableError(
        exchange === ''
          ? `RabbitMQ: message ${id} is unroutable, queue "${destination}" does not exist`
          : `RabbitMQ: message ${id} to "${destination}" is unroutable through the exchange "${exchange}"`,
      )
    }
  }

  /**
   * Publishes through the delay levels: the delay, rounded up to an odd number of milliseconds (so
   * that every route ends with level 0, whose queue dead-letters to the default exchange), is written
   * in binary in the routing key; the `CC` header routes the message to `queue` at the end.
   */
  async #publishDelayed(queue: string, content: Buffer, properties: Options.Publish, delayMs: number): Promise<void> {
    const rounded = Math.min(MAX_TTL_MS, Math.ceil(delayMs))
    const delay = rounded % 2 === 0 ? rounded + 1 : rounded
    await this.#declareDelayLevels()
    let top = 0
    while (top < DELAY_LEVELS - 1 && 2 ** (top + 1) <= delay) top++
    try {
      await this.#confirmPublish(
        this.#delayLevelName(top),
        delayRoutingKey(delay),
        content,
        { ...properties, headers: { ...properties.headers, CC: [queue] } },
        queue,
      )
    } catch (error) {
      // the levels may have been deleted: declare them again on the next delayed publication
      this.#delayLevels = undefined
      throw error
    }
  }

  #delayLevelName(level: number): string {
    return `${this.#options.delayLevelPrefix ?? DEFAULT_DELAY_LEVEL_PREFIX}.${level}`
  }

  /**
   * Declares (once per connection) the delay levels: for each level n, a topic exchange routing the
   * messages whose bit n is set to the queue of the level (TTL 2^n ms, dead-lettering to the level
   * below), and the others straight to the level below.
   */
  async #declareDelayLevels(): Promise<void> {
    let declared = this.#delayLevels
    if (declared === undefined) {
      const levels: Promise<void> = this.#withChannel('declare the delay levels', async channel => {
        for (let level = 0; level < DELAY_LEVELS; level++) {
          const name = this.#delayLevelName(level)
          const below = level === 0 ? '' : this.#delayLevelName(level - 1)
          await channel.assertExchange(name, 'topic', { durable: true })
          await channel.assertQueue(name, { durable: true, arguments: this.#delayQueueArguments(2 ** level, below) })
          await channel.bindQueue(name, name, delayBindingKey(level, '1'))
          if (level > 0) await channel.bindExchange(below, name, delayBindingKey(level, '0'))
        }
      })
      declared = levels
      this.#delayLevels = levels
      levels.catch(() => {
        if (this.#delayLevels === levels) this.#delayLevels = undefined
      })
    }
    try {
      await declared
    } catch (error) {
      const message = errorMessage(error)
      throw consumerError(
        `RabbitMQ: cannot declare the delay levels "${this.#delayLevelName(0)}" to "${this.#delayLevelName(DELAY_LEVELS - 1)}": ${message}`,
        message.includes('PRECONDITION_FAILED')
          ? [
              'They exist with other arguments (another queueType?): set rabbitmq({ delayLevelPrefix }) to use other names',
            ]
          : [],
      )
    }
  }

  /** Arguments of a delay queue: TTL, then dead-lettering (at-least-once on quorum queues). */
  #delayQueueArguments(ttl: number, exchange: string, routingKey?: string): Record<string, unknown> {
    const args: Record<string, unknown> = {
      'x-queue-type': this.#queueType,
      'x-message-ttl': ttl,
      'x-dead-letter-exchange': exchange,
    }
    if (routingKey !== undefined) args['x-dead-letter-routing-key'] = routingKey
    if (this.#queueType === 'quorum') {
      // never lose a message while moving it on
      args['x-dead-letter-strategy'] = 'at-least-once'
      args['x-overflow'] = 'reject-publish'
    }
    return args
  }

  /** Declares (once per connection) the retry delay queue of `queue` for `delayMs` and returns its name. */
  async #delayQueue(queue: string, delayMs: number): Promise<string> {
    const name = this.#options.delayQueueName?.(queue, delayMs) ?? `${queue}.delay.${delayMs}`
    let declared = this.#delayQueues.get(name)
    if (declared === undefined) {
      const args = this.#delayQueueArguments(delayMs, '', queue)
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
      redeclare: false,
    }
    // registered first: a channel closing right after the subscription is resumed by the recovery
    this.#subscriptions.add(subscription)
    try {
      await this.#ensureConsuming(subscription)
    } catch (error) {
      subscription.active = false
      this.#subscriptions.delete(subscription)
      throw error
    }
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
    const names = dlq === undefined ? [queue] : [queue, dlq]
    if (this.#assertTopology) {
      for (const name of names) {
        try {
          await this.#declareQueue(name)
        } catch (error) {
          throw topologyError(name, error)
        }
      }
    } else {
      for (const name of names) {
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

  /**
   * Declares a consumed or dead-letter queue. Quorum queues get `x-delivery-limit: -1` on RabbitMQ >= 4
   * (whose default limit of 20 deliveries counts the releases); an existing queue declared without it
   * cannot be changed by a declaration: it is declared as it is, with a warning.
   */
  async #declareQueue(name: string): Promise<void> {
    const args: Record<string, unknown> = { 'x-queue-type': this.#queueType, ...this.#options.queueArguments }
    const declare = (queueArgs: Record<string, unknown>): Promise<void> =>
      this.#withChannel(`declare the queue "${name}"`, async channel => {
        await channel.assertQueue(name, { durable: true, arguments: queueArgs })
      })
    if (args['x-queue-type'] === 'quorum' && !Object.hasOwn(args, 'x-delivery-limit') && this.#serverMajor() >= 4) {
      try {
        await declare({ ...args, 'x-delivery-limit': -1 })
        return
      } catch (error) {
        if (!errorMessage(error).includes("'x-delivery-limit'")) throw error
        this.#logger.warn(
          `RabbitMQ: queue "${name}" exists without "x-delivery-limit": unless a policy sets "delivery-limit" to -1, RabbitMQ drops (or dead-letters through a queue DLX) a message delivered 20 times, releases included (shutdowns, failed dead-lettering). Apply such a policy, or re-create the queue`,
        )
      }
    }
    await declare(args)
  }

  /** Major version of the connected RabbitMQ (0 when unknown). */
  #serverMajor(): number {
    const version = this.#model?.connection?.serverProperties?.version
    const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN
    return Number.isNaN(major) ? 0 : major
  }

  /** After a consumer cancellation, declares its queues again (`assertTopology`) before consuming. */
  async #redeclare(subscription: ConsumerSubscription): Promise<void> {
    if (this.#assertTopology) {
      const dlq = subscription.options.deadLetterQueue
      for (const name of dlq === undefined ? [subscription.queue] : [subscription.queue, dlq]) {
        try {
          await this.#declareQueue(name)
        } catch (error) {
          throw topologyError(name, error)
        }
      }
    }
    subscription.redeclare = false
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
      // a channel error (or the loss of the connection, handled by the same loop): consume again
      if (subscription.active) this.#recover()
    })
    try {
      await channel.prefetch(subscription.options.concurrency)
      subscription.channel = channel
      const { consumerTag } = await channel.consume(
        subscription.queue,
        message => {
          if (message === null) {
            this.#onConsumerCancelled(subscription, channel)
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

  /**
   * The broker cancelled the consumer (`basic.cancel`: queue deleted, node down...). The channel stays
   * open, so nothing else would notice: close it (its unsettled messages go back to the queue, when it
   * still exists) and resume the subscription.
   */
  #onConsumerCancelled(subscription: ConsumerSubscription, channel: Channel): void {
    if (subscription.channel !== channel || !subscription.active) return
    this.#logger.error(`RabbitMQ cancelled the consumer of "${subscription.queue}" (queue deleted?), consuming again`)
    subscription.channel = undefined
    subscription.consumerTag = undefined
    subscription.redeclare = true
    closeQuietly(channel).then(
      () => undefined,
      () => undefined,
    )
    this.#recover()
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
    /** Properties of a republished copy: the original ones, with the type that selected the handler. */
    const copyProperties = (extraHeaders: Record<string, unknown>, removeAttempt: boolean): Options.Publish => {
      const copied: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(rawHeaders)) {
        if (UNCOPIED_HEADERS.has(name) || (removeAttempt && name === MessagingHeaders.Attempt)) continue
        copied[name] = value
      }
      return {
        ...definedProperties(properties),
        // a type read from the routing key would be lost: copies go through the default exchange
        ...(type === undefined ? {} : { type }),
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
        try {
          await this.#confirmPublish(
            '',
            target,
            message.content,
            copyProperties({ [MessagingHeaders.Attempt]: String(request.attempt) }, false),
            target,
          )
        } catch (error) {
          // the delay queue may have been deleted: declare it again on the next retry
          if (target !== queue) this.#delayQueues.delete(target)
          throw error
        }
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
          '',
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
          request.queue,
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

/** Key of the publications awaiting their confirmation (a returned message carries the same fields). */
function pendingKey(exchange: string, routingKey: string, messageId: unknown): string {
  return `${exchange}\u0000${routingKey}\u0000${String(messageId)}`
}

/** Routing key of a delayed publication: `znight-delay.<bit 31>.<bit 30>...<bit 0>`. */
function delayRoutingKey(delayMs: number): string {
  const words = [DELAY_ROUTING_WORD]
  for (let level = DELAY_LEVELS - 1; level >= 0; level--) {
    words.push(Math.floor(delayMs / 2 ** level) % 2 === 1 ? '1' : '0')
  }
  return words.join('.')
}

/** Binding key matching the delayed publications whose bit `level` is `bit` (exact word count). */
function delayBindingKey(level: number, bit: '0' | '1'): string {
  const words = [DELAY_ROUTING_WORD]
  for (let index = DELAY_LEVELS - 1; index >= 0; index--) words.push(index === level ? bit : '*')
  return words.join('.')
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
