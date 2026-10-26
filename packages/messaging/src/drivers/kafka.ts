/**
 * `@znight/messaging/kafka`: Apache Kafka driver built on
 * [@platformatic/kafka](https://github.com/platformatic/kafka) 2.x (optional peer dependency).
 *
 * - Each `@Consumer` uses its own consumer group: `<groupId>.<topic>` (or `@Consumer({ groupId })`),
 *   with manual commits: an offset is committed once its record was settled.
 * - Records of a partition are handled one after the other (ordering), different partitions
 *   concurrently up to the consumer concurrency.
 * - Retries are non-blocking: the record is produced to the group's retry topic (`<group>.retry`) with
 *   `x-znight-attempt` and `x-znight-not-before`, then committed. A dedicated retry consumer waits
 *   until `not-before` (bounded by `maxRetryDelayMs`) without blocking the main topic (each stream has
 *   its own back-pressure). Retried records lose their ordering relative to the partition.
 * - After a rebalance, records fetched again from the committed offset of a partition this member kept
 *   are skipped (already buffered or handled); buffered records of the partitions it lost are dropped.
 * - Dead letters are produced to `<topic>.dlq` (acks from all in-sync replicas), then committed.
 * - On stop, unsettled records are not committed: they are consumed again after a restart or rebalance.
 * - Delayed publishing is not supported.
 */
import type { ConsumerOptions, Message, MessagesStream, ProducerOptions } from '@platformatic/kafka'
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

import {
  Admin,
  Consumer,
  MessagesStreamFallbackModes,
  MessagesStreamModes,
  ProduceAcks,
  Producer,
  stringDeserializer,
  stringSerializer,
} from '@platformatic/kafka'

import { brokerUnavailableError, consumerError } from '../errors.ts'
import { attemptFromHeaders, headerRecord, MessagingHeaders } from '../headers.ts'
import { errorMessage, MAX_TIMER_DELAY_MS, truncate } from '../internal/async.ts'
import { durationOption, MAX_ERROR_HEADER_LENGTH } from './shared.ts'

type KafkaRecord = Message<string, Buffer, string, string>

/** Topic creation settings. */
export interface KafkaTopicOptions {
  /** Partitions of created topics. Default: 1. */
  readonly partitions?: number
  /** Replication factor of created topics. Default: 1. */
  readonly replicas?: number
}

/** Options of {@link kafka}. */
export interface KafkaDriverOptions {
  /** `host:port` of the bootstrap brokers. */
  readonly bootstrapBrokers: readonly string[]
  /** Client id. Default: `znight`. */
  readonly clientId?: string
  /** Prefix of the consumer groups (`<groupId>.<topic>`), typically the service name. Default: `znight`. */
  readonly groupId?: string
  /** Options shared by the producer, the consumers and the admin client (tls, sasl, timeouts...). */
  readonly connection?: Readonly<Partial<ProducerOptions<string, Buffer, string, string>>>
  /** Extra consumer options (sessionTimeout, heartbeatInterval...). */
  readonly consumer?: Readonly<Partial<ConsumerOptions<string, Buffer, string, string>>>
  /** Start new consumer groups at the beginning of the topic (`earliest`). Default: `false` (latest). */
  readonly fromBeginning?: boolean
  /** Create missing topics at subscribe time; otherwise their existence is verified. Default: `false`. */
  readonly createTopics?: boolean | KafkaTopicOptions
  /** Name of the retry topic of a consumer group. Default: `${group}.retry`. */
  readonly retryTopicName?: (topic: string, group: string) => string
  /** Default dead-letter topic. Default: `${topic}.dlq`. */
  readonly deadLetterName?: (topic: string) => string
  /** Longest retry delay waited in-process before producing the retry (blocks the partition). Default: 0. */
  readonly maxInProcessDelayMs?: number
  /** Longest delay a retry record may wait in the retry consumer. Default: 15 minutes. */
  readonly maxRetryDelayMs?: number
}

const DEFAULT_MAX_RETRY_DELAY_MS = 15 * 60_000
/** Headers carrying transport fields (not exposed as message headers). */
const TRANSPORT_HEADERS = new Set<string>([
  MessagingHeaders.Id,
  MessagingHeaders.Type,
  MessagingHeaders.ContentType,
  MessagingHeaders.NotBefore,
])

/** Creates a {@link KafkaDriver}. */
export function kafka(options: KafkaDriverOptions): KafkaDriver {
  return new KafkaDriver(options)
}

/** Kafka {@link MessagingDriver}. See the module documentation. */
export class KafkaDriver implements MessagingDriver {
  readonly name = 'kafka'
  readonly capabilities: DriverCapabilities
  readonly #options: KafkaDriverOptions
  readonly #clientId: string
  readonly #subscriptions = new Set<KafkaSubscription>()
  /** Consumer group → topic, to refuse groups shared between topics. */
  readonly #groups = new Map<string, string>()
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #producer: Producer<string, Buffer, string, string> | undefined
  #closed = false

  constructor(options: KafkaDriverOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      !Array.isArray(options.bootstrapBrokers) ||
      options.bootstrapBrokers.length === 0
    ) {
      throw new TypeError('[znight] kafka(): the "bootstrapBrokers" option is required')
    }
    this.#options = options
    this.#clientId = options.clientId ?? 'znight'
    this.capabilities = Object.freeze({
      nativeDelay: true,
      maxNativeDelayMs: durationOption(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, 'kafka maxRetryDelayMs'),
      maxInProcessDelayMs: durationOption(options.maxInProcessDelayMs, 0, 'kafka maxInProcessDelayMs'),
      deliveryCount: 'header',
      maxPublishDelayMs: 0,
    })
  }

  async connect(context: DriverContext): Promise<void> {
    this.#logger = context.logger
    if (this.#closed) throw brokerUnavailableError('Kafka: the driver is closed, create a new one')
    if (this.#producer !== undefined) return
    const producer = new Producer<string, Buffer, string, string>({
      ...this.#options.connection,
      clientId: this.#clientId,
      bootstrapBrokers: [...this.#options.bootstrapBrokers],
      serializers: { key: stringSerializer, headerKey: stringSerializer, headerValue: stringSerializer },
    })
    try {
      await producer.metadata({ topics: [] })
    } catch (error) {
      await producer.close().catch(() => undefined)
      throw brokerUnavailableError(
        `Kafka: cannot reach ${this.#options.bootstrapBrokers.join(', ')}: ${errorMessage(error)}`,
        error,
      )
    }
    this.#producer = producer
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const subscriptions = [...this.#subscriptions]
    this.#subscriptions.clear()
    await Promise.allSettled(subscriptions.map(subscription => subscription.close()))
    const producer = this.#producer
    this.#producer = undefined
    if (producer !== undefined) await producer.close().catch(() => undefined)
  }

  deadLetterName(topic: string): string {
    return this.#options.deadLetterName?.(topic) ?? `${topic}.dlq`
  }

  #producerOrThrow(action: string): Producer<string, Buffer, string, string> {
    const producer = this.#producer
    if (producer === undefined) {
      throw brokerUnavailableError(
        this.#closed ? `Kafka: cannot ${action}, the driver is closed` : `Kafka: cannot ${action} before connect()`,
      )
    }
    return producer
  }

  /** Produces one record and waits for the acknowledgement of all in-sync replicas. */
  async produce(
    topic: string,
    value: Buffer,
    headers: Readonly<Record<string, string>>,
    key: string | undefined,
    timestamp?: number,
  ): Promise<void> {
    await this.#producerOrThrow(`produce to "${topic}"`).send({
      messages: [
        {
          topic,
          value,
          headers: { ...headers },
          ...(key === undefined ? {} : { key }),
          ...(timestamp === undefined ? {} : { timestamp: BigInt(timestamp) }),
        },
      ],
      acks: ProduceAcks.ALL,
    })
  }

  async publish(topic: string, message: OutboundMessage): Promise<void> {
    if (message.delayMs > 0) throw new RangeError('[znight] The kafka driver does not support delayed publishing')
    const headers = headerRecord()
    for (const [name, value] of Object.entries(message.headers)) if (!TRANSPORT_HEADERS.has(name)) headers[name] = value
    headers[MessagingHeaders.Id] = message.id
    if (message.type !== undefined) headers[MessagingHeaders.Type] = message.type
    headers[MessagingHeaders.ContentType] = message.contentType
    try {
      await this.produce(topic, Buffer.from(message.body), headers, message.key, message.timestamp)
    } catch (error) {
      throw brokerUnavailableError(`Kafka: producing to "${topic}" failed: ${errorMessage(error)}`, error)
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Consuming
  // -----------------------------------------------------------------------------------------------

  async subscribe(topic: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    this.#producerOrThrow(`subscribe to "${topic}"`)
    const configuredGroup = options.options['groupId']
    if (configuredGroup !== undefined && (typeof configuredGroup !== 'string' || configuredGroup === '')) {
      throw consumerError(`Kafka: the groupId of ${options.consumer} must be a non-empty string`)
    }
    const group = configuredGroup ?? `${this.#options.groupId ?? 'znight'}.${topic}`
    const owner = this.#groups.get(group)
    if (owner !== undefined && owner !== topic) {
      throw consumerError(`Kafka: consumer group "${group}" is used for "${owner}" and "${topic}"`, [
        'Each @Consumer needs its own consumer group: remove the groupId option or make it unique',
      ])
    }
    const retryTopic =
      options.maxAttempts > 1 ? (this.#options.retryTopicName?.(topic, group) ?? `${group}.retry`) : undefined
    const topics = [topic, retryTopic, options.deadLetterQueue].filter((name): name is string => name !== undefined)
    this.#groups.set(group, topic) // reserved before any await: subscriptions may start concurrently
    try {
      await this.#ensureTopics(topics, options.consumer)
    } catch (error) {
      this.#groups.delete(group)
      throw error
    }

    const subscription = new KafkaSubscription({
      driver: this,
      topic,
      group,
      retryTopic,
      handler,
      options,
      logger: this.#logger,
    })
    try {
      await subscription.start(
        groupId =>
          new Consumer<string, Buffer, string, string>({
            ...this.#options.connection,
            ...this.#options.consumer,
            clientId: this.#clientId,
            bootstrapBrokers: [...this.#options.bootstrapBrokers],
            groupId,
            autocommit: false,
            deserializers: { key: stringDeserializer, headerKey: stringDeserializer, headerValue: stringDeserializer },
          } as ConsumerOptions<string, Buffer, string, string>),
        this.#options.fromBeginning === true,
      )
    } catch (error) {
      this.#groups.delete(group)
      await subscription.close()
      throw brokerUnavailableError(`Kafka: cannot consume "${topic}": ${errorMessage(error)}`, error)
    }
    this.#subscriptions.add(subscription)
    return {
      cancel: async (): Promise<void> => {
        await subscription.cancel()
      },
      close: async (): Promise<void> => {
        this.#subscriptions.delete(subscription)
        this.#groups.delete(group)
        await subscription.close()
      },
    }
  }

  async #ensureTopics(topics: readonly string[], consumer: string): Promise<void> {
    const admin = new Admin({
      ...this.#options.connection,
      clientId: `${this.#clientId}-admin`,
      bootstrapBrokers: [...this.#options.bootstrapBrokers],
    })
    try {
      const existing = new Set(await admin.listTopics())
      const missing = topics.filter(topic => !existing.has(topic))
      if (missing.length === 0) return
      const create = this.#options.createTopics
      if (create === undefined || create === false) {
        throw consumerError(
          `Kafka: topic(s) ${missing.map(name => `"${name}"`).join(', ')} of ${consumer} do not exist`,
          ['Create them, or set kafka({ createTopics: true }) to let Znight create them'],
        )
      }
      const settings = create === true ? {} : create
      try {
        await admin.createTopics({
          topics: missing,
          partitions: settings.partitions ?? 1,
          replicas: settings.replicas ?? 1,
        })
      } catch (error) {
        // created concurrently by another instance
        const now = new Set(await admin.listTopics())
        if (missing.some(topic => !now.has(topic))) throw error
      }
    } finally {
      await admin.close().catch(() => undefined)
    }
  }
}

/**
 * A consumer of the subscription (main topic, or retry topic) with its stream and its back-pressure:
 * each stream is paused and resumed on its own, so that retries waiting for their `not-before` never
 * hold the main topic.
 */
interface StreamState {
  readonly topic: string
  readonly consumer: Consumer<string, Buffer, string, string>
  stream: MessagesStream<string, Buffer, string, string> | undefined
  /** Records of this stream in the partition queues (the ones being handled included). */
  buffered: number
  paused: boolean
  /** Partitions of `topic` assigned by the last group join (`undefined` before the first one). */
  assigned: ReadonlySet<number> | undefined
}

interface PartitionQueue {
  readonly key: string
  readonly source: StreamState
  readonly partition: number
  readonly records: KafkaRecord[]
  running: boolean
  queued: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  /**
   * Offset following the last record pushed. After a rebalance the stream fetches the partitions it
   * keeps again from their committed offset: older records were already buffered or handled.
   */
  next: bigint | undefined
}

interface KafkaSubscriptionConfig {
  readonly driver: KafkaDriver
  readonly topic: string
  readonly group: string
  readonly retryTopic: string | undefined
  readonly handler: DeliveryHandler
  readonly options: SubscribeOptions
  readonly logger: DriverContext['logger']
}

type Outcome = 'next' | 'again' | 'stop'

/**
 * The consumers of one `@Consumer`: the main topic and, with retries, the retry topic. Records are
 * queued per partition; at most `concurrency` partitions are handled at once, one record at a time.
 */
class KafkaSubscription {
  readonly #config: KafkaSubscriptionConfig
  readonly #partitions = new Map<string, PartitionQueue>()
  readonly #ready: PartitionQueue[] = []
  readonly #sources: StreamState[] = []
  readonly #highWater: number
  readonly #lowWater: number
  readonly #idle = new Set<() => void>()
  #running = 0
  #active = true
  #closed: Promise<void> | undefined

  constructor(config: KafkaSubscriptionConfig) {
    this.#config = config
    this.#highWater = Math.max(64, config.options.concurrency * 8)
    this.#lowWater = Math.floor(this.#highWater / 2)
  }

  async start(
    createConsumer: (groupId: string) => Consumer<string, Buffer, string, string>,
    fromBeginning: boolean,
  ): Promise<void> {
    const { topic, group, retryTopic } = this.#config
    await this.#consume(createConsumer(group), topic, fromBeginning)
    // the retry topic only holds records of this group: always read it from the beginning
    if (retryTopic !== undefined) await this.#consume(createConsumer(`${group}.retry`), retryTopic, true)
  }

  async #consume(
    consumer: Consumer<string, Buffer, string, string>,
    topic: string,
    fromBeginning: boolean,
  ): Promise<void> {
    const source: StreamState = { topic, consumer, stream: undefined, buffered: 0, paused: false, assigned: undefined }
    this.#sources.push(source)
    consumer.on('consumer:group:join', () => this.#onGroupJoin(source))
    const stream = await consumer.consume({
      topics: [topic],
      autocommit: false,
      mode: MessagesStreamModes.COMMITTED,
      fallbackMode: fromBeginning ? MessagesStreamFallbackModes.EARLIEST : MessagesStreamFallbackModes.LATEST,
    })
    source.stream = stream
    stream.on('data', (record: KafkaRecord) => this.#push(source, record))
    stream.on('error', (error: Error) => {
      this.#config.logger.error(`Kafka: consumer stream of "${topic}" failed`, { err: error })
    })
  }

  /** Stops dispatching: buffered records are dropped (not committed, consumed again later). */
  async cancel(): Promise<void> {
    await Promise.resolve()
    if (!this.#active) return
    this.#active = false
    for (const source of this.#sources) source.stream?.pause()
    for (const queue of this.#partitions.values()) this.#dropBuffered(queue)
    this.#ready.length = 0
  }

  /** Waits for the records being handled, then leaves the consumer groups. Idempotent. */
  close(): Promise<void> {
    this.#closed ??= this.#close()
    return this.#closed
  }

  async #close(): Promise<void> {
    await this.cancel()
    if (this.#running > 0) await new Promise<void>(resolve => this.#idle.add(resolve))
    await Promise.allSettled(this.#sources.map(source => source.stream?.close()))
    await Promise.allSettled(this.#sources.map(source => source.consumer.close()))
  }

  /**
   * A (re)join of the group, with its new assignment: the partitions this member lost belong to
   * another one now, so their buffered records are dropped (the record being handled finishes).
   */
  #onGroupJoin(source: StreamState): void {
    const assigned = new Set<number>()
    for (const assignment of source.consumer.assignments ?? []) {
      if (assignment.topic === source.topic) for (const partition of assignment.partitions) assigned.add(partition)
    }
    source.assigned = assigned
    for (const queue of this.#partitions.values()) {
      if (queue.source !== source || assigned.has(queue.partition)) continue
      this.#dropBuffered(queue)
      // records older than the one being handled come back if the partition is assigned again
      queue.next = queue.running ? (queue.records[0] as KafkaRecord).offset + 1n : undefined
    }
  }

  /** Drops the records of `queue` that are not being handled. */
  #dropBuffered(queue: PartitionQueue): void {
    if (queue.timer !== undefined) clearTimeout(queue.timer)
    queue.timer = undefined
    const keep = queue.running ? queue.records.slice(0, 1) : []
    this.#unbuffer(queue.source, queue.records.length - keep.length)
    queue.records.length = 0
    queue.records.push(...keep)
  }

  #push(source: StreamState, record: KafkaRecord): void {
    if (!this.#active) return
    // a late record of a partition revoked by the last rebalance
    if (source.assigned !== undefined && !source.assigned.has(record.partition)) return
    const key = `${record.topic}:${record.partition}`
    let queue = this.#partitions.get(key)
    if (queue === undefined) {
      queue = {
        key,
        source,
        partition: record.partition,
        records: [],
        running: false,
        queued: false,
        timer: undefined,
        next: undefined,
      }
      this.#partitions.set(key, queue)
    }
    // fetched again after a rebalance (from the committed offset): already buffered or handled
    if (queue.next !== undefined && record.offset < queue.next) return
    queue.next = record.offset + 1n
    queue.records.push(record)
    source.buffered++
    if (!queue.running && !queue.queued && queue.timer === undefined) this.#enqueue(queue)
    if (source.buffered >= this.#highWater) {
      // pause again even when paused: the client resumes its streams after a rebalance
      source.paused = true
      source.stream?.pause()
    }
    this.#pump()
  }

  /** `count` records of `source` left the partition queues: resume it below the low-water mark. */
  #unbuffer(source: StreamState, count: number): void {
    source.buffered -= count
    if (source.paused && this.#active && source.buffered <= this.#lowWater) {
      source.paused = false
      source.stream?.resume()
    }
  }

  #enqueue(queue: PartitionQueue): void {
    queue.queued = true
    this.#ready.push(queue)
  }

  #pump(): void {
    while (this.#active && this.#running < this.#config.options.concurrency && this.#ready.length > 0) {
      const queue = this.#ready.shift() as PartitionQueue
      queue.queued = false
      const head = queue.records[0]
      if (head === undefined) continue
      const wait = notBefore(head) - Date.now()
      if (wait > 0) {
        // a retry that is not due yet: wait without holding a slot (timers cannot wait more than 2^31 - 1 ms)
        queue.timer = setTimeout(
          () => {
            queue.timer = undefined
            if (!this.#active) return
            this.#enqueue(queue)
            this.#pump()
          },
          Math.min(wait, this.#config.driver.capabilities.maxNativeDelayMs, MAX_TIMER_DELAY_MS),
        )
        continue
      }
      queue.running = true
      this.#running++
      this.#work(queue, head).then(
        () => undefined,
        () => undefined,
      )
    }
  }

  async #work(queue: PartitionQueue, record: KafkaRecord): Promise<void> {
    let outcome: Outcome = 'stop'
    try {
      outcome = await this.#process(record)
    } catch (error) {
      this.#config.logger.error(`Kafka: unexpected failure handling a record of ${queue.key}`, { err: error })
      outcome = this.#active ? 'again' : 'stop'
    } finally {
      queue.running = false
      this.#running--
      const assigned = queue.source.assigned
      if (outcome === 'again' && assigned !== undefined && !assigned.has(queue.partition)) {
        // revoked meanwhile: the new owner of the partition handles it
        outcome = 'stop'
        queue.next = undefined
      }
      if (outcome === 'next') {
        queue.records.shift()
        this.#unbuffer(queue.source, 1)
      } else if (outcome === 'stop') {
        const dropped = queue.records.length
        queue.records.length = 0
        this.#unbuffer(queue.source, dropped)
      }
      if (this.#active && queue.records.length > 0) this.#enqueue(queue)
      if (this.#running === 0) {
        const waiters = [...this.#idle]
        this.#idle.clear()
        for (const waiter of waiters) waiter()
      }
      this.#pump()
    }
  }

  /** Hands one record to the runtime; resolves once it was settled. */
  async #process(record: KafkaRecord): Promise<Outcome> {
    const { driver, topic, retryTopic, group, logger } = this.#config
    const all = headerRecord()
    for (const [name, value] of record.headers) if (value !== undefined) all[name] = value
    const headers = headerRecord()
    for (const [name, value] of Object.entries(all)) if (!TRANSPORT_HEADERS.has(name)) headers[name] = value
    const id = all[MessagingHeaders.Id] ?? `${record.topic}-${record.partition}-${record.offset}`
    const value = record.value ?? Buffer.alloc(0)
    let settled = false
    let released = false
    const check = (action: string): void => {
      if (settled) throw new Error(`[kafka] record ${id} was already settled (${action})`)
    }
    /** Commits the offset. A failure (rebalance...) is not fatal: the record may be consumed again. */
    const commit = async (): Promise<void> => {
      try {
        await record.commit()
      } catch (error) {
        logger.warn(
          `Kafka: committing record ${id} of ${record.topic}:${record.partition} failed, it may be consumed again`,
          {
            err: error,
          },
        )
      }
    }
    const copyHeaders = (extra: Record<string, string>, drop: readonly string[]): Record<string, string> => {
      const result = headerRecord()
      for (const [name, headerValue] of Object.entries(all)) if (!drop.includes(name)) result[name] = headerValue
      return Object.assign(result, extra)
    }
    const delivery: DriverDelivery = {
      id,
      body: value,
      contentType: all[MessagingHeaders.ContentType],
      headers,
      type: all[MessagingHeaders.Type],
      key: record.key ?? undefined,
      attempt: attemptFromHeaders(all),
      redelivered: attemptFromHeaders(all) > 1,
      timestamp: Number(record.timestamp),
      raw: record,
      ack: async (): Promise<void> => {
        check('ack')
        settled = true
        await commit()
      },
      release: async (): Promise<void> => {
        await Promise.resolve()
        check('release')
        settled = true
        released = true
      },
      retry: async (request: RetryRequest): Promise<void> => {
        check('retry')
        if (retryTopic === undefined) throw new Error(`[kafka] ${topic} has no retry topic (single attempt)`)
        const extra: Record<string, string> = { [MessagingHeaders.Attempt]: String(request.attempt) }
        if (request.delayMs > 0) extra[MessagingHeaders.NotBefore] = String(Date.now() + request.delayMs)
        await driver.produce(
          retryTopic,
          value,
          copyHeaders(extra, [MessagingHeaders.NotBefore]),
          record.key ?? undefined,
        )
        settled = true
        await commit()
      },
      deadLetter: async (request: DeadLetterRequest): Promise<void> => {
        check('dead-letter')
        if (request.queue !== undefined) {
          await driver.produce(
            request.queue,
            value,
            copyHeaders(
              {
                [MessagingHeaders.DeadLetterReason]: request.reason,
                [MessagingHeaders.Error]: truncate(errorMessage(request.error), MAX_ERROR_HEADER_LENGTH),
                [MessagingHeaders.OriginalQueue]: topic,
                [MessagingHeaders.Attempts]: String(request.attempt),
                [MessagingHeaders.ConsumerGroup]: group,
              },
              [MessagingHeaders.Attempt, MessagingHeaders.NotBefore],
            ),
            record.key ?? undefined,
          )
        }
        settled = true
        await commit()
      },
    }
    try {
      await this.#config.handler(delivery)
    } catch (error) {
      logger.error(`Kafka: unexpected failure handling record ${id}`, { err: error })
    }
    if (released || !settled) return this.#active ? 'again' : 'stop'
    return 'next'
  }
}

/** `x-znight-not-before` of a retry record (epoch ms), 0 when absent. */
function notBefore(record: KafkaRecord): number {
  const value = record.headers.get(MessagingHeaders.NotBefore)
  const time = value === undefined ? 0 : Number(value)
  return Number.isFinite(time) ? time : 0
}
