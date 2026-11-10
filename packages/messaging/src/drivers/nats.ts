/**
 * `@znight/messaging/nats`: NATS JetStream driver built on `@nats-io/jetstream` 3 and
 * `@nats-io/transport-node` 3 (optional peer dependencies). Design: RFC 0014 §4.2.
 *
 * - `publish(queue)` publishes to the subject `subjects(queue)` (default: the queue name), which a
 *   stream must capture; the JetStream confirmation (`PubAck`) resolves it. The Znight id is the
 *   `Nats-Msg-Id`, so the stream deduplicates a republished message within its duplicate window.
 * - `@Consumer(queue)` reads a durable pull consumer (`<durablePrefix>-<queue>`, filter subject
 *   `subjects(queue)`, explicit acks) on the stream capturing the subject (or `streams(queue)`),
 *   created when missing, verified otherwise. One fetch at a time per subscription, for at most the
 *   free concurrency slots; `working()` extends the ack wait of the messages in flight.
 * - Acks are double acks (`ackAck()`), releases `nak()`, retries `nak(delay)`: JetStream redelivers
 *   the message and counts its deliveries, which are the attempts. Dead letters are a copy published
 *   to `<queue>.dlq` (deduplicated by stream sequence), then `term()`.
 * - A consumer with a finite `max_deliver` gets its `MAX_DELIVERIES` advisories: a message JetStream
 *   stopped delivering is dead-lettered from the stream (one replica per queue group handles it).
 * - Headers are NATS headers; `Nats-*` headers reach JetStream on publish and are hidden from
 *   handlers. No delayed publishing. Streams are only created with `provision: true`.
 */
import type {
  ConsumerConfig,
  ConsumerInfo,
  ConsumerMessages,
  JetStreamClient,
  JetStreamManager,
  JetStreamOptions,
  JsMsg,
  StreamConfig,
} from '@nats-io/jetstream'
import type {
  Msg,
  MsgHdrs,
  NatsConnection,
  Subscription as NatsSubscription,
  NodeConnectionOptions,
} from '@nats-io/transport-node'
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

import { jetstream } from '@nats-io/jetstream'
import { connect, headers as natsHeaders } from '@nats-io/transport-node'

import { bodyToBytes } from '../codec.ts'
import { brokerUnavailableError, consumerError } from '../errors.ts'
import { headerRecord, MessagingHeaders } from '../headers.ts'
import { errorMessage, sleep } from '../internal/async.ts'
import { deadLetterHeaders, durationOption } from './shared.ts'

/** Names by queue: a record (unlisted queues keep the default) or a function. */
export type NatsNames = Readonly<Record<string, string>> | ((queue: string) => string | undefined)

/** Options of {@link nats}. */
export interface NatsDriverOptions {
  /** Server URLs (`nats://host:4222`...). Default: the `connectionOptions` servers, else `127.0.0.1:4222`. */
  readonly servers?: string | readonly string[]
  /** Options of the connection created by the driver (authentication, TLS, name, reconnection...). */
  readonly connectionOptions?: NodeConnectionOptions
  /** An existing connection (you keep ownership: the driver flushes it on close, never closes it). */
  readonly connection?: NatsConnection
  /** An existing JetStream context created on `connection` (which it requires). */
  readonly jetstream?: JetStreamClient
  /** Options of the JetStream context created by the driver (`domain`, `apiPrefix`, `timeout`). */
  readonly jetstreamOptions?: JetStreamOptions
  /** Subject of each queue (published to, filtered by its consumer). Default: the queue name. */
  readonly subjects?: NatsNames
  /** Stream of each queue. Default: the stream capturing its subject. */
  readonly streams?: NatsNames
  /**
   * Prefix of the durable consumer names: `<durablePrefix>-<queue>` (characters other than letters,
   * digits, `-` and `_` become `_`). Give each service consuming a queue its own. Default: `'znight'`.
   */
  readonly durablePrefix?: string
  /** Ack wait of the consumers the driver creates, in ms (extended while handlers run). Default: 30 000. */
  readonly ackWaitMs?: number
  /** Other settings of the consumers the driver creates (`max_ack_pending`, `max_deliver`...). */
  readonly consumerConfig?: Partial<ConsumerConfig>
  /** Longest retry delay waited in-process before `nak()`. Default: 1000 ms. */
  readonly maxInProcessDelayMs?: number
  /** Longest wait of a fetch (pull request) for messages, in ms (at least 1000). Default: 30 000. */
  readonly fetchExpiresMs?: number
  /** Default dead-letter queue (a subject) of a queue. Default: `<queue>.dlq`. */
  readonly deadLetterName?: (queue: string) => string
  /**
   * Creates a stream for each subject no stream captures (consumed, dead-letter and published
   * subjects), named after the subject (`orders.dlq` → `orders_dlq`). For development. Default: `false`.
   */
  readonly provision?: boolean
  /** Other settings of the streams created by `provision` (`storage`, `max_age`, `num_replicas`...). */
  readonly streamConfig?: Partial<StreamConfig>
}

/** Creates a {@link NatsDriver}. */
export function nats(options: NatsDriverOptions = {}): NatsDriver {
  return new NatsDriver(options)
}

const NANOS_PER_MS = 1_000_000
/** Longest `nak` delay whose nanoseconds stay an exact JavaScript number (about 104 days). */
const MAX_NAK_DELAY_MS = Math.floor(Number.MAX_SAFE_INTEGER / NANOS_PER_MS)
const DEFAULT_ACK_WAIT_MS = 30_000
const MIN_ACK_WAIT_MS = 100
const MIN_FETCH_EXPIRES_MS = 1000
/** Header carrying the message key (NATS messages have none). */
const KEY_HEADER = 'x-znight-key'
/** Headers carrying transport fields (not exposed as application headers). */
const TRANSPORT_HEADERS = new Set<string>([
  MessagingHeaders.Id,
  MessagingHeaders.Type,
  MessagingHeaders.ContentType,
  KEY_HEADER,
])
/** Headers JetStream reads or writes (`Nats-Msg-Id`, `Nats-TTL`...), hidden from handlers. */
const JETSTREAM_HEADER_PREFIX = 'Nats-'
/** Characters NATS forbids in stream and consumer names. */
const INVALID_NAME = /[\s.*>/\\]/
const JetStreamCodes = { ConsumerNotFound: 10014, StreamNotFound: 10059, StreamNameInUse: 10058 } as const

/** What a `MAX_DELIVERIES` advisory carries. */
interface MaxDeliveriesAdvisory {
  readonly stream_seq?: unknown
  readonly deliveries?: unknown
}

interface PullSubscription {
  /** The `@Consumer` queue (logical name). */
  readonly queue: string
  readonly subject: string
  readonly stream: string
  readonly durable: string
  readonly handler: DeliveryHandler
  readonly options: SubscribeOptions
  /** Dead-letter queue and subject, `undefined` when disabled. */
  readonly deadLetter: { readonly queue: string; readonly subject: string } | undefined
  readonly fetcher: { fetch(options: { max_messages: number; expires: number }): Promise<ConsumerMessages> }
  /** Messages handed to the runtime and not settled yet: their ack wait is extended. */
  readonly leased: Set<JsMsg>
  /** Deliveries and advisory dead letters not finished yet. */
  readonly handling: Set<Promise<void>>
  readonly abort: AbortController
  inflight: number
  active: boolean
  wake: (() => void) | undefined
  batch: ConsumerMessages | undefined
  loop: Promise<void> | undefined
  timer: ReturnType<typeof setInterval> | undefined
  advisories: NatsSubscription | undefined
}

/** NATS JetStream {@link MessagingDriver}. See the module documentation. */
export class NatsDriver implements MessagingDriver {
  readonly name = 'nats'
  readonly capabilities: DriverCapabilities
  readonly #options: NatsDriverOptions
  readonly #durablePrefix: string
  readonly #ackWaitMs: number
  readonly #fetchExpiresMs: number
  readonly #subscriptions = new Set<PullSubscription>()
  #connection: NatsConnection | undefined
  #js: JetStreamClient | undefined
  #jsm: JetStreamManager | undefined
  #owned = false
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #closed = false

  constructor(options: NatsDriverOptions = {}) {
    if (options.jetstream !== undefined && options.connection === undefined) {
      throw new TypeError(
        '[znight] nats(): jetstream requires connection (the connection the JetStream context was created on)',
      )
    }
    const prefix = options.durablePrefix ?? 'znight'
    if (typeof prefix !== 'string' || prefix === '' || INVALID_NAME.test(prefix)) {
      throw new TypeError(
        `[znight] nats(): durablePrefix must be a non-empty consumer name prefix (no whitespace, ".", "*", ">", "/" or "\\"), got ${String(prefix)}`,
      )
    }
    const ackWait = durationOption(options.ackWaitMs, DEFAULT_ACK_WAIT_MS, 'nats ackWaitMs')
    if (ackWait < MIN_ACK_WAIT_MS) {
      throw new TypeError(`[znight] nats(): ackWaitMs must be at least ${MIN_ACK_WAIT_MS} ms, got ${ackWait}`)
    }
    const expires = durationOption(options.fetchExpiresMs, 30_000, 'nats fetchExpiresMs')
    if (expires < MIN_FETCH_EXPIRES_MS) {
      throw new TypeError(
        `[znight] nats(): fetchExpiresMs must be at least ${MIN_FETCH_EXPIRES_MS} ms (a JetStream pull request limit), got ${expires}`,
      )
    }
    this.#options = options
    this.#durablePrefix = prefix
    this.#ackWaitMs = ackWait
    this.#fetchExpiresMs = expires
    this.capabilities = Object.freeze({
      nativeDelay: true,
      maxNativeDelayMs: MAX_NAK_DELAY_MS,
      maxInProcessDelayMs: durationOption(options.maxInProcessDelayMs, 1000, 'nats maxInProcessDelayMs'),
      deliveryCount: 'native',
      maxPublishDelayMs: 0,
    })
  }

  /** The connection (available once connected). */
  get connection(): NatsConnection | undefined {
    return this.#connection
  }

  /** The JetStream context (available once connected). */
  get jetstreamClient(): JetStreamClient | undefined {
    return this.#js
  }

  async connect(context: DriverContext): Promise<void> {
    await Promise.resolve()
    this.#logger = context.logger
    if (this.#closed) throw brokerUnavailableError('NATS JetStream: the driver is closed, create a new one')
    if (this.#js !== undefined) return
    const options = this.#options
    let connection = options.connection
    let owned = false
    if (connection === undefined) {
      const servers = options.servers === undefined ? undefined : [options.servers].flat()
      try {
        connection = await connect({ ...options.connectionOptions, ...(servers === undefined ? {} : { servers }) })
      } catch (error) {
        throw brokerUnavailableError(`NATS JetStream: cannot connect (${errorMessage(error)})`, error)
      }
      owned = true
    }
    const js = options.jetstream ?? jetstream(connection, options.jetstreamOptions)
    let jsm: JetStreamManager
    try {
      jsm = await js.jetstreamManager()
    } catch (error) {
      if (owned) await connection.close().catch(() => undefined)
      throw brokerUnavailableError(`NATS JetStream: cannot reach JetStream (${errorMessage(error)})`, error)
    }
    this.#connection = connection
    this.#owned = owned
    this.#js = js
    this.#jsm = jsm
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const subscriptions = [...this.#subscriptions]
    this.#subscriptions.clear()
    for (const subscription of subscriptions) this.#stopFetching(subscription)
    await Promise.allSettled(subscriptions.map(subscription => subscription.loop))
    await Promise.all(subscriptions.map(subscription => this.#settled(subscription)))
    const connection = this.#connection
    this.#connection = undefined
    this.#js = undefined
    this.#jsm = undefined
    if (connection === undefined) return
    try {
      // drain flushes what is pending (settlements included) before closing
      await (this.#owned ? connection.drain() : connection.flush())
    } catch (error) {
      this.#logger.debug('NATS JetStream: failed to flush or drain the connection', { err: error })
    }
  }

  deadLetterName(queue: string): string {
    return this.#options.deadLetterName?.(queue) ?? `${queue}.dlq`
  }

  #unavailable(action: string): Error {
    return brokerUnavailableError(
      this.#closed
        ? `NATS JetStream: cannot ${action}, the driver is closed`
        : `NATS JetStream: cannot ${action} before connect()`,
    )
  }

  #client(action: string): JetStreamClient {
    if (this.#js === undefined) throw this.#unavailable(action)
    return this.#js
  }

  #manager(action: string): JetStreamManager {
    if (this.#jsm === undefined) throw this.#unavailable(action)
    return this.#jsm
  }

  #subject(queue: string): string {
    return mapName(this.#options.subjects, queue) ?? queue
  }

  /** Confirms that the server received what the connection sent (settlements are fire-and-forget). */
  async #flush(): Promise<void> {
    const connection = this.#connection
    if (connection === undefined) throw this.#unavailable('flush the connection')
    await connection.flush()
  }

  // -----------------------------------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------------------------------

  async publish(queue: string, message: OutboundMessage): Promise<void> {
    if (message.delayMs > 0) {
      throw new RangeError(`[znight] NATS subject "${queue}": the nats driver does not support delayed publishing`)
    }
    const headers = natsHeaders()
    try {
      headers.set(MessagingHeaders.Id, message.id)
      if (message.type !== undefined) headers.set(MessagingHeaders.Type, message.type)
      headers.set(MessagingHeaders.ContentType, message.contentType)
      if (message.key !== undefined && message.key !== '') headers.set(KEY_HEADER, message.key)
      for (const [name, value] of Object.entries(message.headers)) {
        if (!TRANSPORT_HEADERS.has(name)) headers.set(name, value)
      }
    } catch (error) {
      throw new TypeError(
        `[znight] NATS headers cannot carry a header of the message for "${queue}" (${errorMessage(error)})`,
      )
    }
    await this.#publishTo(this.#subject(queue), queue, bodyToBytes(message.body), headers, message.id)
  }

  async #publishTo(subject: string, label: string, data: Uint8Array, headers: MsgHdrs, msgID: string): Promise<void> {
    const js = this.#client(`publish to "${label}"`)
    try {
      await js.publish(subject, data, { msgID, headers })
    } catch (error) {
      if (!isNoStream(error)) throw error
      if (this.#options.provision !== true) {
        throw consumerError(`NATS JetStream: no stream captures the subject "${subject}" (publishing to "${label}")`, [
          'Create a stream whose subjects include it, or map the queue to a captured subject with nats({ subjects })',
          'Or set nats({ provision: true }) in development',
        ])
      }
      await this.#createStream(this.#manager(`create a stream for "${subject}"`), streamName(subject), subject)
      await js.publish(subject, data, { msgID, headers })
    }
  }

  async #createStream(jsm: JetStreamManager, name: string, subject: string): Promise<string> {
    try {
      await jsm.streams.add({ ...this.#options.streamConfig, name, subjects: [subject] })
      this.#logger.info(`NATS JetStream: created stream ${name} capturing "${subject}"`)
    } catch (error) {
      if (codeOf(error) !== JetStreamCodes.StreamNameInUse) throw error
    }
    return name
  }

  // -----------------------------------------------------------------------------------------------
  // Subscribing
  // -----------------------------------------------------------------------------------------------

  async subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    const consumerOptions = this.#consumerOptions(options)
    const subject = this.#subject(queue)
    const durable = consumerOptions.durable ?? `${this.#durablePrefix}-${queue.replace(/[^A-Za-z0-9_-]/g, '_')}`
    const jsm = this.#manager(`subscribe to "${queue}"`)
    const stream = await this.#resolveStream(
      jsm,
      subject,
      consumerOptions.stream ?? mapName(this.#options.streams, queue),
      'subject',
    )
    let deadLetter: PullSubscription['deadLetter']
    const dlq = options.deadLetterQueue
    if (dlq !== undefined) {
      const deadLetterSubject = this.#subject(dlq)
      await this.#resolveStream(jsm, deadLetterSubject, mapName(this.#options.streams, dlq), 'dead-letter subject')
      deadLetter = { queue: dlq, subject: deadLetterSubject }
    }
    const info = await this.#ensureConsumer(jsm, stream, durable, subject, options)
    const ackWaitMs = Number(info.config.ack_wait ?? DEFAULT_ACK_WAIT_MS * NANOS_PER_MS) / NANOS_PER_MS
    const subscription: PullSubscription = {
      queue,
      subject,
      stream,
      durable,
      handler,
      options,
      deadLetter,
      fetcher: this.#client(`subscribe to "${queue}"`).consumers.getConsumerFromInfo(info),
      leased: new Set(),
      handling: new Set(),
      abort: new AbortController(),
      inflight: 0,
      active: true,
      wake: undefined,
      batch: undefined,
      loop: undefined,
      timer: undefined,
      advisories: undefined,
    }
    const maxDeliver = info.config.max_deliver ?? -1
    if (maxDeliver > 0) subscription.advisories = this.#listenToAdvisories(subscription)
    this.#subscriptions.add(subscription)
    subscription.timer = setInterval(
      () => {
        for (const message of subscription.leased) {
          try {
            message.working()
          } catch (error) {
            this.#logger.debug('NATS JetStream: failed to extend an ack wait', { err: error })
          }
        }
      },
      Math.max(50, ackWaitMs / 2),
    )
    subscription.timer.unref?.()
    subscription.loop = this.#fetchLoop(subscription)
    return {
      cancel: async (): Promise<void> => {
        this.#stopFetching(subscription)
        await subscription.loop
      },
      close: async (): Promise<void> => {
        this.#stopFetching(subscription)
        this.#subscriptions.delete(subscription)
        await subscription.loop
        await this.#settled(subscription)
      },
    }
  }

  #consumerOptions(options: SubscribeOptions): { durable: string | undefined; stream: string | undefined } {
    const { durable, stream } = options.options
    if (durable !== undefined && (typeof durable !== 'string' || durable === '' || INVALID_NAME.test(durable))) {
      throw consumerError(
        `${options.consumer}: the NATS option durable must be a consumer name (no whitespace, ".", "*", ">", "/" or "\\"), got ${String(durable)}`,
      )
    }
    if (stream !== undefined && (typeof stream !== 'string' || stream === '' || INVALID_NAME.test(stream))) {
      throw consumerError(`${options.consumer}: the NATS option stream must be a stream name, got ${String(stream)}`)
    }
    return { durable, stream }
  }

  /** The stream of `subject`: `explicit` when given (verified), else the stream capturing it. */
  async #resolveStream(
    jsm: JetStreamManager,
    subject: string,
    explicit: string | undefined,
    what: string,
  ): Promise<string> {
    const provision = this.#options.provision === true
    if (explicit !== undefined) {
      try {
        await jsm.streams.info(explicit)
        return explicit
      } catch (error) {
        if (!isNotFound(error)) {
          throw brokerUnavailableError(
            `NATS JetStream: cannot read stream "${explicit}" (${errorMessage(error)})`,
            error,
          )
        }
        if (provision) return await this.#createStream(jsm, explicit, subject)
        throw consumerError(`NATS JetStream: stream "${explicit}" of the ${what} "${subject}" not found`, [
          'Create the stream, or fix nats({ streams })',
          'Or set nats({ provision: true }) in development',
        ])
      }
    }
    try {
      return await jsm.streams.find(subject)
    } catch (error) {
      if (!isNotFound(error)) {
        throw brokerUnavailableError(
          `NATS JetStream: cannot find the stream of "${subject}" (${errorMessage(error)})`,
          error,
        )
      }
      if (provision) return await this.#createStream(jsm, streamName(subject), subject)
      throw consumerError(`NATS JetStream: no stream captures the ${what} "${subject}"`, [
        `Create a stream whose subjects include "${subject}" (or a wildcard matching it)`,
        what === 'subject'
          ? 'Or map the queue with nats({ subjects, streams })'
          : 'Or disable dead-lettering: @Consumer({ queue, deadLetter: false })',
        'Or set nats({ provision: true }) in development',
      ])
    }
  }

  /** Reads the durable consumer, creating it when missing; refuses one the driver cannot use. */
  async #ensureConsumer(
    jsm: JetStreamManager,
    stream: string,
    durable: string,
    subject: string,
    options: SubscribeOptions,
  ): Promise<ConsumerInfo> {
    let info: ConsumerInfo
    try {
      info = await jsm.consumers.info(stream, durable)
    } catch (error) {
      if (!isNotFound(error)) {
        throw brokerUnavailableError(
          `NATS JetStream: cannot read consumer "${durable}" of stream "${stream}" (${errorMessage(error)})`,
          error,
        )
      }
      const created = await jsm.consumers.add(stream, {
        ack_wait: this.#ackWaitMs * NANOS_PER_MS,
        max_deliver: -1,
        deliver_policy: 'all',
        ...this.#options.consumerConfig,
        durable_name: durable,
        filter_subject: subject,
        ack_policy: 'explicit',
      })
      this.#logger.info(`NATS JetStream: created consumer ${durable} on stream ${stream} for "${subject}"`)
      info = created
    }
    const config = info.config
    const name = `NATS JetStream: consumer "${durable}" of stream "${stream}"`
    if (config.deliver_subject !== undefined && config.deliver_subject !== '') {
      throw consumerError(`${name} is a push consumer: ${options.consumer} needs a pull consumer`, [
        'Delete it so that the driver creates a pull consumer, or name another one with @Consumer({ queue, durable })',
      ])
    }
    if (config.ack_policy !== 'explicit') {
      throw consumerError(
        `${name} acknowledgement policy is '${String(config.ack_policy)}': ${options.consumer} needs 'explicit'`,
        ['Recreate the consumer with ack_policy explicit, or name another one with @Consumer({ queue, durable })'],
      )
    }
    const maxDeliver = config.max_deliver ?? -1
    if (maxDeliver > 0 && maxDeliver < options.maxAttempts) {
      throw consumerError(
        `${name} stops delivering a message after ${plural(maxDeliver, 'delivery', 'deliveries')}, but ${options.consumer} allows ${options.maxAttempts} attempt(s)`,
        [
          `Raise its max_deliver to at least ${options.maxAttempts} (or -1, unlimited: Znight counts the attempts)`,
          'Or lower the @Retry attempts',
        ],
      )
    }
    return info
  }

  #stopFetching(subscription: PullSubscription): void {
    subscription.active = false
    subscription.abort.abort()
    subscription.wake?.()
    subscription.batch?.stop()
    subscription.advisories?.unsubscribe()
    subscription.advisories = undefined
  }

  /** Resolves once every delivery of `subscription` finished (they never reject), then stops its lease. */
  async #settled(subscription: PullSubscription): Promise<void> {
    while (subscription.handling.size > 0) await Promise.allSettled([...subscription.handling])
    if (subscription.timer !== undefined) clearInterval(subscription.timer)
    subscription.timer = undefined
  }

  async #fetchLoop(subscription: PullSubscription): Promise<void> {
    const { options } = subscription
    let errorDelay = 500
    while (subscription.active) {
      const free = options.concurrency - subscription.inflight
      if (free <= 0) {
        await new Promise<void>(resolve => {
          subscription.wake = resolve
        })
        subscription.wake = undefined
        continue
      }
      try {
        const batch = await subscription.fetcher.fetch({ max_messages: free, expires: this.#fetchExpiresMs })
        subscription.batch = batch
        if (!subscription.active) batch.stop()
        for await (const message of batch) {
          if (subscription.active) this.#deliver(subscription, message)
          else this.#giveBack(message)
        }
        errorDelay = 500
      } catch (error) {
        if (!subscription.active) break
        this.#logger.warn(
          `NATS JetStream: fetching from "${subscription.queue}" failed, retrying in ${errorDelay} ms`,
          {
            err: error,
          },
        )
        await sleep(errorDelay, subscription.abort.signal).catch(() => undefined)
        errorDelay = Math.min(errorDelay * 2, 30_000)
      } finally {
        subscription.batch = undefined
      }
    }
  }

  /** Gives back a message received while stopping (JetStream redelivers it). */
  #giveBack(message: JsMsg): void {
    try {
      message.nak()
    } catch (error) {
      this.#logger.debug('NATS JetStream: failed to give back a message received while stopping', { err: error })
    }
  }

  #deliver(subscription: PullSubscription, message: JsMsg): void {
    const { transport, headers } = splitHeaders(message.headers)
    const info = message.info
    const id = transport[MessagingHeaders.Id] ?? `${info.stream}:${info.streamSequence}`
    const attempt = Math.max(1, info.deliveryCount)
    subscription.inflight++
    subscription.leased.add(message)
    let settled = false
    const settle = async (action: string, run: () => Promise<void>): Promise<void> => {
      if (settled) throw new Error(`[nats] message ${id} was already settled (${action})`)
      subscription.leased.delete(message)
      await run()
      settled = true
    }
    const terminate = async (request: DeadLetterRequest): Promise<void> => {
      message.term(`znight: dead-lettered (${request.reason})`)
      await this.#flush()
    }
    const delivery: DriverDelivery = {
      id,
      body: message.data,
      contentType: transport[MessagingHeaders.ContentType],
      headers,
      type: transport[MessagingHeaders.Type],
      key: transport[KEY_HEADER],
      attempt,
      redelivered: message.redelivered || attempt > 1,
      timestamp: timestampOf(info.timestampNanos),
      raw: message,
      ack: (): Promise<void> =>
        settle('ack', async () => {
          if (!(await message.ackAck())) {
            throw new Error(`NATS JetStream: the acknowledgement of message ${id} was not confirmed`)
          }
        }),
      release: (): Promise<void> =>
        settle('release', async () => {
          message.nak()
          await this.#flush()
        }),
      retry: (request: RetryRequest): Promise<void> =>
        settle('retry', async () => {
          // always an explicit delay: a consumer backoff never adds to the @Retry delay
          message.nak(Math.min(MAX_NAK_DELAY_MS, Math.max(1, request.delayMs)))
          await this.#flush()
        }),
      deadLetter: (request: DeadLetterRequest): Promise<void> =>
        settle('dead-letter', async () => {
          if (request.queue !== undefined) {
            const target = subscription.deadLetter?.subject ?? this.#subject(request.queue)
            await this.#publishTo(
              target,
              request.queue,
              message.data,
              deadLetterCopy(transport, headers, request, subscription.queue),
              deadLetterId(info.stream, info.streamSequence),
            )
          }
          await terminate(request)
        }),
    }
    const handled = subscription
      .handler(delivery)
      .catch((error: unknown) => {
        this.#logger.error(`NATS JetStream: unexpected failure handling message ${id}`, { err: error })
      })
      .finally(() => {
        subscription.handling.delete(handled)
        subscription.leased.delete(message)
        subscription.inflight--
        subscription.wake?.()
      })
    subscription.handling.add(handled)
  }

  // -----------------------------------------------------------------------------------------------
  // max_deliver advisories
  // -----------------------------------------------------------------------------------------------

  /**
   * Listens to the `MAX_DELIVERIES` advisories of a consumer with a finite `max_deliver`, in a queue
   * group so that one replica handles each.
   */
  #listenToAdvisories(subscription: PullSubscription): NatsSubscription | undefined {
    const connection = this.#connection
    if (connection === undefined) return undefined
    const { stream, durable } = subscription
    return connection.subscribe(`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.${durable}`, {
      queue: `znight-advisories-${stream}-${durable}`,
      callback: (error: Error | null, message: Msg): void => {
        if (error !== null) {
          this.#logger.warn(`NATS JetStream: max_deliver advisories of ${durable} failed`, { err: error })
          return
        }
        let advisory: MaxDeliveriesAdvisory
        try {
          advisory = message.json<MaxDeliveriesAdvisory>()
        } catch (parseError) {
          this.#logger.warn(`NATS JetStream: invalid max_deliver advisory for ${durable}`, { err: parseError })
          return
        }
        const handled = this.#onMaxDeliveries(subscription, advisory)
          .catch((handleError: unknown) => {
            this.#logger.error(
              `NATS JetStream: failed to dead-letter a message ${durable} stopped delivering (max_deliver); it stays in stream ${stream}`,
              { err: handleError, queue: subscription.queue, seq: advisory.stream_seq },
            )
          })
          .finally(() => {
            subscription.handling.delete(handled)
          })
        subscription.handling.add(handled)
      },
    })
  }

  async #onMaxDeliveries(subscription: PullSubscription, advisory: MaxDeliveriesAdvisory): Promise<void> {
    const { stream, durable, queue, deadLetter } = subscription
    const seq = Number(advisory.stream_seq)
    const deliveries = Number(advisory.deliveries)
    if (!Number.isSafeInteger(seq) || seq <= 0) return
    if (deadLetter === undefined) {
      this.#logger.error(
        `NATS JetStream: message ${seq} of stream ${stream} reached the max_deliver of ${durable} (${deliveries} deliveries): JetStream no longer delivers it, and dead-lettering is disabled for ${subscription.options.consumer}`,
        { queue },
      )
      return
    }
    const stored = await this.#manager('read a message').streams.getMessage(stream, { seq })
    if (stored === null) return
    const { transport, headers } = splitHeaders(stored.header)
    const request: DeadLetterRequest = {
      queue: deadLetter.queue,
      reason: 'max-attempts',
      error: new Error(
        `JetStream stopped delivering the message after ${deliveries} deliveries (max_deliver of consumer ${durable})`,
      ),
      attempt: Number.isSafeInteger(deliveries) && deliveries > 0 ? deliveries : 1,
    }
    await this.#publishTo(
      deadLetter.subject,
      deadLetter.queue,
      stored.data,
      deadLetterCopy(transport, headers, request, queue),
      deadLetterId(stream, seq),
    )
    this.#logger.warn(
      `NATS JetStream: message ${transport[MessagingHeaders.Id] ?? `${stream}:${seq}`} of "${queue}" reached the max_deliver of ${durable} (${deliveries} deliveries): dead-lettered to "${deadLetter.queue}"`,
      { queue },
    )
  }
}

/** Splits NATS headers into transport fields and application headers (`Nats-*` headers dropped). */
function splitHeaders(source: MsgHdrs | undefined): {
  transport: Record<string, string>
  headers: Record<string, string>
} {
  const transport = headerRecord()
  const headers = headerRecord()
  for (const [name, values] of source ?? []) {
    const value = values[0] ?? ''
    if (TRANSPORT_HEADERS.has(name)) transport[name] = value
    else if (!name.startsWith(JETSTREAM_HEADER_PREFIX)) headers[name] = value
  }
  return { transport, headers }
}

/** Headers of a dead-letter copy: the transport fields, the headers and the dead-letter headers. */
function deadLetterCopy(
  transport: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
  request: DeadLetterRequest,
  queue: string,
): MsgHdrs {
  const copy = natsHeaders()
  for (const [name, value] of Object.entries(transport)) copy.set(name, value)
  for (const [name, value] of Object.entries(deadLetterHeaders(headers, request, queue))) {
    // NATS header values are single lines
    copy.set(name, value.replace(/[\r\n]+/g, ' '))
  }
  return copy
}

/** `Nats-Msg-Id` of the dead-letter copy of a stream message: a repeated copy is deduplicated. */
function deadLetterId(stream: string, seq: number): string {
  return `znight-dlq-${stream}-${seq}`
}

/** Stream created by `provision` for a subject: its name with forbidden characters replaced. */
function streamName(subject: string): string {
  return subject.replace(/[\s.*>/\\]/g, '_')
}

function mapName(names: NatsNames | undefined, queue: string): string | undefined {
  if (names === undefined) return undefined
  if (typeof names === 'function') return names(queue)
  return Object.hasOwn(names, queue) ? names[queue] : undefined
}

/** JetStream error code (`err_code`) of an API error. */
function codeOf(error: unknown): number | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

function isNotFound(error: unknown): boolean {
  const code = codeOf(error)
  const name = (error as { readonly name?: unknown } | null)?.name
  return (
    code === JetStreamCodes.StreamNotFound ||
    code === JetStreamCodes.ConsumerNotFound ||
    name === 'StreamNotFoundError' ||
    name === 'ConsumerNotFoundError'
  )
}

/** A publication nobody answered: no stream captures the subject (or JetStream is disabled). */
function isNoStream(error: unknown): boolean {
  const name = (error as { readonly name?: unknown } | null)?.name
  return name === 'JetStreamNotEnabled' || name === 'NoRespondersError'
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Epoch milliseconds of a JetStream timestamp in nanoseconds. */
function timestampOf(nanos: number): number | undefined {
  const millis = Math.floor(Number(nanos) / NANOS_PER_MS)
  return Number.isFinite(millis) && millis > 0 ? millis : undefined
}
