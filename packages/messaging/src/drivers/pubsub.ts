/**
 * `@znight/messaging/pubsub`: Google Cloud Pub/Sub driver built on `@google-cloud/pubsub` 6 (optional
 * peer dependency). Design: RFC 0012.
 *
 * - `publish(queue)` publishes to the topic `topics(queue)`, `@Consumer(queue)` pulls the subscription
 *   `subscriptions(queue)`; both default to the queue name (a topic and a subscription of the same
 *   name behave like a queue). Short names live in the driver's project, full resource names
 *   (`projects/<p>/topics/<t>`) are used as they are.
 * - Unary Pull through the generated `v1.SubscriberClient`: one outstanding Pull per subscription, for
 *   at most the free concurrency slots. Received messages get `ackDeadlineSeconds` at once, then every
 *   half of it while they are handled; the lease stops (once any extension in flight landed) before a
 *   settlement that sets a deadline.
 * - Acks are `Acknowledge`, releases `ModifyAckDeadline(0)`, retries `ModifyAckDeadline(delay)` (at
 *   most 600 s). Attempts come from `deliveryAttempt` (subscriptions with a dead-letter policy), or
 *   from the retries the driver requested (in memory) without one.
 * - `retries: 'znight'` (default): `@Retry` applies and dead letters are published to `<queue>-dlq`
 *   (or the topic of the subscription's dead-letter policy). `retries: 'subscription'`: every failure
 *   is an immediate nack, the subscription's retry and dead-letter policies own redelivery.
 * - Headers are message attributes; the body is the message data. The `key` is the ordering key:
 *   messages of a key are handled one after the other on ordered subscriptions.
 * - No delayed publishing. Topics and subscriptions are never created unless `provision: true`.
 */
import type { ClientConfig, protos } from '@google-cloud/pubsub'
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

import { PubSub, v1 } from '@google-cloud/pubsub'

import { bodyToBytes } from '../codec.ts'
import { brokerUnavailableError, consumerError } from '../errors.ts'
import { headerRecord, MessagingHeaders } from '../headers.ts'
import { errorMessage, sleep, truncate } from '../internal/async.ts'
import { deadLetterHeaders, durationOption } from './shared.ts'

type PubsubMessage = protos.google.pubsub.v1.IPubsubMessage
type ReceivedMessage = protos.google.pubsub.v1.IReceivedMessage
type SubscriptionResource = protos.google.pubsub.v1.ISubscription
type DeadLetterPolicy = protos.google.pubsub.v1.IDeadLetterPolicy

/** Names of topics or subscriptions by queue: a record (unlisted queues keep their name) or a function. */
export type PubSubNames = Readonly<Record<string, string>> | ((queue: string) => string)

/**
 * Who retries and dead-letters failed messages: Znight (`@Retry`, Znight dead-letter topic) or the
 * subscription (its retry policy and dead-letter policy; every failure is an immediate nack).
 */
export type PubSubRetries = 'znight' | 'subscription'

/** Options of {@link pubsub}. */
export interface PubSubDriverOptions {
  /** Project of short topic and subscription names. Default: the project the client resolves. */
  readonly projectId?: string
  /**
   * An existing client whose configuration (project, credentials, endpoint, emulator) the driver
   * reuses for its RPC clients. You keep ownership: it is not closed.
   */
  readonly client?: PubSub
  /**
   * Configuration of the `PubSub` client created by the driver (`projectId`, `credentials`,
   * `apiEndpoint`...). `PUBSUB_EMULATOR_HOST` is honoured.
   */
  readonly clientConfig?: ClientConfig
  /** An existing publisher client (you keep ownership). */
  readonly publisherClient?: v1.PublisherClient
  /** An existing subscriber client (you keep ownership). */
  readonly subscriberClient?: v1.SubscriberClient
  /** Topic of each queue published to. Default: the queue name. */
  readonly topics?: PubSubNames
  /** Subscription of each `@Consumer` queue. Default: the queue name. */
  readonly subscriptions?: PubSubNames
  /**
   * Who retries and dead-letters (RFC 0012 §5). Default: `'znight'`. Under `'subscription'`, a
   * consumer can take the ownership back with `@Consumer({ queue, retries: 'znight' })`.
   */
  readonly retries?: PubSubRetries
  /** Ack deadline kept on messages while they are handled, in seconds (10–600). Default: 60. */
  readonly ackDeadlineSeconds?: number
  /**
   * Longest retry delay waited in-process (Pub/Sub deadlines have a 1 s granularity). Default: 1000 ms
   * (`0` with `retries: 'subscription'`).
   */
  readonly maxInProcessDelayMs?: number
  /** Longest wait of a Pull for messages, in milliseconds. Default: 30 000. */
  readonly pullTimeoutMs?: number
  /** Default dead-letter queue (a topic) of a queue. Default: `<queue>-dlq`. */
  readonly deadLetterName?: (queue: string) => string
  /**
   * Creates the missing topics and subscriptions: the topic and subscription of a consumer, the
   * dead-letter topic with a subscription of the same name, and the topics published to. With
   * `retries: 'subscription'`, a created subscription gets a dead-letter policy to that topic. For
   * development and the emulator. Default: `false`.
   */
  readonly provision?: boolean
}

/** Creates a {@link PubSubDriver}. */
export function pubsub(options: PubSubDriverOptions = {}): PubSubDriver {
  return new PubSubDriver(options)
}

/** Longest ack deadline Pub/Sub accepts, in seconds. */
const MAX_ACK_DEADLINE_SECONDS = 600
const MIN_ACK_DEADLINE_SECONDS = 10
const MAX_PULL_MESSAGES = 1000
/** Ack ids per `ModifyAckDeadline` request (the request size is limited). */
const MAX_ACK_IDS_PER_REQUEST = 1000
const MAX_ATTRIBUTES = 100
const MAX_ATTRIBUTE_KEY_BYTES = 256
const MAX_ATTRIBUTE_VALUE_BYTES = 1024
/** Retry attempts remembered for subscriptions without a dead-letter policy. */
const MAX_REMEMBERED_ATTEMPTS = 10_000
/** Default `maxDeliveryAttempts` of a dead-letter policy. */
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5
/** Largest `maxDeliveryAttempts` of a dead-letter policy. */
const MAX_DELIVERY_ATTEMPTS = 100
/** Trace context written by the Google client library's OpenTelemetry instrumentation. */
const GOOGLE_TRACEPARENT = 'googclient_traceparent'
const TRACEPARENT = 'traceparent'
/** Message attributes carrying transport fields (not exposed as headers). */
const TRANSPORT_ATTRIBUTES = new Set<string>([MessagingHeaders.Id, MessagingHeaders.Type, MessagingHeaders.ContentType])
/** gRPC status codes the driver handles. */
const Status = { DeadlineExceeded: 4, NotFound: 5, AlreadyExists: 6, PermissionDenied: 7 } as const
const ABORTED: unique symbol = Symbol('aborted')

interface PullSubscription {
  /** The `@Consumer` queue (logical name). */
  readonly queue: string
  /** Subscription resource name. */
  readonly path: string
  readonly handler: DeliveryHandler
  readonly options: SubscribeOptions
  readonly retries: PubSubRetries
  /** Topic of the Znight dead letters (`retries: 'znight'`), `undefined` when disabled. */
  readonly deadLetterTopic: string | undefined
  /** Whether the subscription has a dead-letter policy, `undefined` when unknown. */
  readonly deadLetterPolicy: boolean | undefined
  /** Messages of an ordering key are handled one after the other. */
  readonly ordered: boolean
  /** Ack ids of the messages whose deadline is extended. */
  readonly leased: Set<string>
  /** Last delivery of each ordering key. */
  readonly groups: Map<string, Promise<void>>
  /** Deliveries not finished yet (including messages waiting for their ordering key). */
  readonly handling: Set<Promise<void>>
  readonly abort: AbortController
  inflight: number
  active: boolean
  wake: (() => void) | undefined
  loop: Promise<void> | undefined
  timer: ReturnType<typeof setInterval> | undefined
  /** Deadline modifications of the lease in flight (initial and periodic), awaited by settlements. */
  extending: Promise<void> | undefined
  /** Periodic extension in flight: the next tick is skipped only while it has not landed. */
  periodic: Promise<void> | undefined
}

/** Google Cloud Pub/Sub {@link MessagingDriver}. See the module documentation. */
export class PubSubDriver implements MessagingDriver {
  readonly name = 'pubsub'
  readonly capabilities: DriverCapabilities
  readonly #options: PubSubDriverOptions
  readonly #retries: PubSubRetries
  readonly #ackDeadline: number
  readonly #pullTimeoutMs: number
  readonly #subscriptions = new Set<PullSubscription>()
  /** Attempt of the next delivery of each retried message (`<subscription>\0<message id>`). */
  readonly #attempts = new Map<string, number>()
  #publisher: v1.PublisherClient | undefined
  #subscriber: v1.SubscriberClient | undefined
  #client: PubSub | undefined
  readonly #owned: { close(): Promise<unknown> }[] = []
  #project = ''
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #closed = false

  constructor(options: PubSubDriverOptions = {}) {
    const retries = options.retries ?? 'znight'
    if (!isRetries(retries)) {
      throw new TypeError(`[znight] pubsub(): retries must be 'znight' or 'subscription', got ${String(retries)}`)
    }
    const deadline = options.ackDeadlineSeconds ?? 60
    if (!(Number.isInteger(deadline) && deadline >= MIN_ACK_DEADLINE_SECONDS && deadline <= MAX_ACK_DEADLINE_SECONDS)) {
      throw new TypeError(
        `[znight] pubsub(): ackDeadlineSeconds must be an integer between 10 and 600, got ${String(deadline)}`,
      )
    }
    const inProcess = durationOption(options.maxInProcessDelayMs, 1000, 'pubsub maxInProcessDelayMs')
    const pullTimeout = durationOption(options.pullTimeoutMs, 30_000, 'pubsub pullTimeoutMs')
    this.#options = options
    this.#retries = retries
    this.#ackDeadline = deadline
    this.#pullTimeoutMs = Math.max(1, pullTimeout)
    this.capabilities = Object.freeze({
      nativeDelay: true,
      maxNativeDelayMs: MAX_ACK_DEADLINE_SECONDS * 1000,
      maxInProcessDelayMs: retries === 'subscription' ? 0 : inProcess,
      deliveryCount: 'native',
      maxPublishDelayMs: 0,
    })
  }

  /** The project of short names (available once connected). */
  get projectId(): string | undefined {
    return this.#project === '' ? undefined : this.#project
  }

  /** The publisher client (available once connected). */
  get publisherClient(): v1.PublisherClient | undefined {
    return this.#publisher
  }

  /** The subscriber client (available once connected). */
  get subscriberClient(): v1.SubscriberClient | undefined {
    return this.#subscriber
  }

  async connect(context: DriverContext): Promise<void> {
    await Promise.resolve()
    this.#logger = context.logger
    if (this.#closed) throw brokerUnavailableError('Pub/Sub: the driver is closed, create a new one')
    if (this.#publisher !== undefined) return
    const options = this.#options
    /** Options of the generated clients: the resolved `PubSub` configuration (documented usage). */
    let config: ConstructorParameters<typeof v1.PublisherClient>[0]
    let project = options.projectId
    if (options.publisherClient === undefined || options.subscriberClient === undefined) {
      const client =
        options.client ??
        new PubSub({ ...options.clientConfig, ...(project === undefined ? {} : { projectId: project }) })
      if (options.client === undefined) this.#owned.push(client)
      try {
        config = (await client.getClientConfig()) as ConstructorParameters<typeof v1.PublisherClient>[0]
      } catch (error) {
        throw brokerUnavailableError(`Pub/Sub: cannot configure the client (${errorMessage(error)})`, error)
      }
      project ??= client.projectId
      this.#client = client
    }
    const publisher = options.publisherClient ?? new v1.PublisherClient(config)
    const subscriber = options.subscriberClient ?? new v1.SubscriberClient(config)
    if (options.publisherClient === undefined) this.#owned.push(publisher)
    if (options.subscriberClient === undefined) this.#owned.push(subscriber)
    project ??= await subscriber.getProjectId()
    if (project === undefined || project === '' || project.includes('{{')) {
      throw brokerUnavailableError(
        'Pub/Sub: no project id (set pubsub({ projectId }), GOOGLE_CLOUD_PROJECT, or PUBSUB_PROJECT_ID with the emulator)',
      )
    }
    this.#project = project
    this.#publisher = publisher
    this.#subscriber = subscriber
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const subscriptions = [...this.#subscriptions]
    this.#subscriptions.clear()
    for (const subscription of subscriptions) this.#stopPulling(subscription)
    await Promise.allSettled(subscriptions.map(subscription => subscription.loop))
    await Promise.all(subscriptions.map(subscription => this.#settled(subscription)))
    this.#publisher = undefined
    this.#subscriber = undefined
    this.#client = undefined
    const owned = this.#owned.splice(0)
    await Promise.allSettled(owned.map(client => client.close()))
  }

  deadLetterName(queue: string): string {
    return this.#options.deadLetterName?.(queue) ?? `${queue}-dlq`
  }

  #pub(action: string): v1.PublisherClient {
    const client = this.#publisher
    if (client === undefined) throw this.#unavailable(action)
    return client
  }

  #sub(action: string): v1.SubscriberClient {
    const client = this.#subscriber
    if (client === undefined) throw this.#unavailable(action)
    return client
  }

  #unavailable(action: string): Error {
    return brokerUnavailableError(
      this.#closed ? `Pub/Sub: cannot ${action}, the driver is closed` : `Pub/Sub: cannot ${action} before connect()`,
    )
  }

  #topicPath(queue: string): string {
    const name = mapName(this.#options.topics, queue)
    return name.startsWith('projects/') ? name : `projects/${this.#project}/topics/${name}`
  }

  #subscriptionPath(queue: string): string {
    const name = mapName(this.#options.subscriptions, queue)
    return name.startsWith('projects/') ? name : `projects/${this.#project}/subscriptions/${name}`
  }

  // -----------------------------------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------------------------------

  async publish(queue: string, message: OutboundMessage): Promise<void> {
    if (message.delayMs > 0) {
      throw new RangeError(`[znight] Pub/Sub topic "${queue}": the pubsub driver does not support delayed publishing`)
    }
    const attributes = headerRecord()
    attributes[MessagingHeaders.Id] = message.id
    if (message.type !== undefined) attributes[MessagingHeaders.Type] = message.type
    attributes[MessagingHeaders.ContentType] = message.contentType
    for (const [name, value] of Object.entries(message.headers)) {
      if (!TRANSPORT_ATTRIBUTES.has(name)) attributes[name] = value
    }
    checkAttributes(attributes, queue)
    const data: PubsubMessage = { data: bodyToBytes(message.body), attributes }
    if (message.key !== undefined && message.key !== '') data.orderingKey = message.key
    await this.#publishTo(this.#topicPath(queue), queue, data)
  }

  async #publishTo(topic: string, label: string, message: PubsubMessage): Promise<void> {
    const publisher = this.#pub(`publish to "${label}"`)
    try {
      await publisher.publish({ topic, messages: [message] })
    } catch (error) {
      if (statusOf(error) !== Status.NotFound) throw error
      if (this.#options.provision !== true) {
        throw consumerError(`Pub/Sub: topic "${label}" not found (${topic})`, [
          'Create the topic, or map the queue to an existing one with pubsub({ topics })',
          'Or set pubsub({ provision: true }) in development',
        ])
      }
      await this.#ensureTopic(topic)
      await publisher.publish({ topic, messages: [message] })
    }
  }

  async #ensureTopic(topic: string): Promise<void> {
    try {
      await this.#pub(`create the topic ${topic}`).createTopic({ name: topic })
      this.#logger.info(`Pub/Sub: created topic ${topic}`)
    } catch (error) {
      if (statusOf(error) !== Status.AlreadyExists) throw error
    }
  }

  async #ensureSubscription(subscription: string, topic: string, deadLetterPolicy?: DeadLetterPolicy): Promise<void> {
    try {
      await this.#sub(`create the subscription ${subscription}`).createSubscription({
        name: subscription,
        topic,
        ackDeadlineSeconds: this.#ackDeadline,
        ...(deadLetterPolicy === undefined ? {} : { deadLetterPolicy }),
      })
      this.#logger.info(`Pub/Sub: created subscription ${subscription} on ${topic}`)
    } catch (error) {
      if (statusOf(error) !== Status.AlreadyExists) throw error
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Subscribing
  // -----------------------------------------------------------------------------------------------

  async subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    const retries = this.#consumerRetries(options)
    const path = this.#subscriptionPath(queue)
    const resource = await this.#readSubscription(queue, path, retries, options)
    const policy = resource?.deadLetterPolicy ?? undefined
    const policyTopic = policy?.deadLetterTopic ?? ''
    const hasPolicy = resource === undefined ? undefined : policyTopic !== ''
    const maxDeliveries = policy?.maxDeliveryAttempts || DEFAULT_MAX_DELIVERY_ATTEMPTS
    const forwards = `subscription "${queue}" forwards messages to its dead-letter topic after ${maxDeliveries} delivery attempt(s), but ${options.consumer} allows ${options.maxAttempts} attempt(s)`
    let deadLetterTopic: string | undefined
    if (retries === 'subscription') {
      if (hasPolicy === false) {
        throw consumerError(
          `Pub/Sub: subscription "${queue}" has no dead-letter policy, which ${options.consumer} needs with retries: 'subscription' (failed messages would be redelivered forever)`,
          [
            'Add a dead-letter policy to the subscription',
            "Or let Znight retry and dead-letter: @Consumer({ queue, retries: 'znight' })",
          ],
        )
      }
      if (hasPolicy === true && maxDeliveries !== options.maxAttempts) {
        this.#logger.warn(
          `Pub/Sub: ${forwards}: set the @Retry attempts to ${maxDeliveries} so that the handler runs on every delivery`,
        )
      }
    } else {
      if (hasPolicy === true && maxDeliveries < options.maxAttempts) {
        throw consumerError(`Pub/Sub: ${forwards}`, [
          `Raise the maxDeliveryAttempts of the dead-letter policy of "${queue}" to at least ${options.maxAttempts}`,
          "Or lower the @Retry attempts, or let the subscription own retries: pubsub({ retries: 'subscription' })",
        ])
      }
      if (hasPolicy === false && options.maxAttempts > 1) {
        this.#logger.warn(
          `Pub/Sub: subscription "${queue}" has no dead-letter policy, so Pub/Sub does not count delivery attempts: the retries of ${options.consumer} are counted in memory, per process`,
        )
      }
      const dlq = options.deadLetterQueue
      if (dlq !== undefined) {
        if (hasPolicy === true && dlq === this.deadLetterName(queue)) deadLetterTopic = policyTopic
        else {
          deadLetterTopic = this.#topicPath(dlq)
          if (hasPolicy === true && deadLetterTopic !== policyTopic) {
            this.#logger.warn(
              `Pub/Sub: ${options.consumer} dead-letters to "${dlq}" but the dead-letter policy of "${queue}" targets ${policyTopic}`,
            )
          }
        }
        await this.#checkDeadLetterTopic(dlq, deadLetterTopic, deadLetterTopic === policyTopic)
      }
    }

    const subscription: PullSubscription = {
      queue,
      path,
      handler,
      options,
      retries,
      deadLetterTopic,
      deadLetterPolicy: hasPolicy,
      ordered: resource === undefined || resource.enableMessageOrdering === true,
      leased: new Set(),
      groups: new Map(),
      handling: new Set(),
      abort: new AbortController(),
      inflight: 0,
      active: true,
      wake: undefined,
      loop: undefined,
      timer: undefined,
      extending: undefined,
      periodic: undefined,
    }
    this.#subscriptions.add(subscription)
    subscription.timer = setInterval(
      () => {
        // the initial deadlines of new batches never delay this extension: only a periodic one in flight does
        if (subscription.periodic !== undefined || subscription.leased.size === 0) return
        const periodic = this.#extend(subscription, [...subscription.leased])
        subscription.periodic = periodic
        void periodic.finally(() => {
          if (subscription.periodic === periodic) subscription.periodic = undefined
        })
      },
      (this.#ackDeadline * 1000) / 2,
    )
    subscription.timer.unref?.()
    subscription.loop = this.#pull(subscription)
    return {
      nativeDeadLetter: retries === 'subscription',
      cancel: async (): Promise<void> => {
        this.#stopPulling(subscription)
        await subscription.loop
      },
      close: async (): Promise<void> => {
        this.#stopPulling(subscription)
        this.#subscriptions.delete(subscription)
        await subscription.loop
        await this.#settled(subscription)
      },
    }
  }

  #consumerRetries(options: SubscribeOptions): PubSubRetries {
    const value = options.options['retries']
    if (value === undefined) return this.#retries
    if (!isRetries(value)) {
      throw consumerError(
        `${options.consumer}: the Pub/Sub option retries must be 'znight' or 'subscription', got ${String(value)}`,
      )
    }
    if (value === 'subscription' && this.#retries === 'znight') {
      // the in-process retry budget and the @Retry checks are driver-wide: they follow pubsub({ retries })
      throw consumerError(
        `${options.consumer}: @Consumer({ retries: 'subscription' }) needs a driver created with pubsub({ retries: 'subscription' })`,
        [
          "Set pubsub({ retries: 'subscription' }), and give the ownership back to Znight where needed with @Consumer({ queue, retries: 'znight' })",
          "Or remove retries: 'subscription' from the consumer",
        ],
      )
    }
    return value
  }

  /** The subscription's configuration, `undefined` when it cannot be read. */
  async #readSubscription(
    queue: string,
    path: string,
    retries: PubSubRetries,
    options: SubscribeOptions,
  ): Promise<SubscriptionResource | undefined> {
    const subscriber = this.#sub(`subscribe to "${queue}"`)
    try {
      const [resource] = await subscriber.getSubscription({ subscription: path })
      return resource
    } catch (error) {
      const status = statusOf(error)
      if (status === Status.NotFound) {
        if (this.#options.provision === true) return await this.#provision(queue, path, retries, options)
        throw consumerError(`Pub/Sub: subscription "${queue}" not found (${path})`, [
          'Create the subscription, or map the queue to an existing one with pubsub({ subscriptions })',
          'Or set pubsub({ provision: true }) in development',
        ])
      }
      if (status === Status.PermissionDenied) {
        this.#logger.warn(
          `Pub/Sub: cannot read subscription "${queue}" (permission denied, pubsub.subscriptions.get): its dead-letter policy and ordering are not checked`,
        )
        return undefined
      }
      throw brokerUnavailableError(`Pub/Sub: cannot read subscription "${queue}" (${errorMessage(error)})`, error)
    }
  }

  /**
   * Creates the topic and the subscription of a consumer. With `retries: 'subscription'`, which
   * requires a dead-letter policy, the subscription gets one to the consumer's dead-letter topic
   * (created with a subscription of the same name).
   */
  async #provision(
    queue: string,
    path: string,
    retries: PubSubRetries,
    options: SubscribeOptions,
  ): Promise<SubscriptionResource> {
    const topic = this.#topicPath(queue)
    await this.#ensureTopic(topic)
    let deadLetterPolicy: DeadLetterPolicy | undefined
    if (retries === 'subscription') {
      const dlq = options.deadLetterQueue ?? this.deadLetterName(queue)
      const deadLetterTopic = this.#topicPath(dlq)
      await this.#ensureTopic(deadLetterTopic)
      await this.#ensureSubscription(this.#subscriptionPath(dlq), deadLetterTopic)
      const attempts = Math.max(DEFAULT_MAX_DELIVERY_ATTEMPTS, options.maxAttempts)
      deadLetterPolicy = { deadLetterTopic, maxDeliveryAttempts: Math.min(MAX_DELIVERY_ATTEMPTS, attempts) }
    }
    await this.#ensureSubscription(path, topic, deadLetterPolicy)
    return {
      name: path,
      topic,
      ackDeadlineSeconds: this.#ackDeadline,
      enableMessageOrdering: false,
      deadLetterPolicy: deadLetterPolicy ?? null,
    }
  }

  async #checkDeadLetterTopic(queue: string, topic: string, policy: boolean): Promise<void> {
    try {
      await this.#pub(`check the dead-letter topic "${queue}"`).getTopic({ topic })
    } catch (error) {
      const status = statusOf(error)
      if (status === Status.NotFound) {
        if (this.#options.provision === true && !policy) {
          await this.#ensureTopic(topic)
          await this.#ensureSubscription(this.#subscriptionPath(queue), topic)
          return
        }
        throw consumerError(`Pub/Sub: dead-letter topic "${queue}" not found (${topic})`, [
          'Create the topic and a subscription on it (a topic without subscription drops its messages)',
          'Or disable dead-lettering: @Consumer({ queue, deadLetter: false })',
          'Or set pubsub({ provision: true }) in development',
        ])
      }
      if (status === Status.PermissionDenied) {
        this.#logger.warn(`Pub/Sub: cannot read the dead-letter topic "${queue}" (permission denied): not checked`)
        return
      }
      throw brokerUnavailableError(`Pub/Sub: cannot read the dead-letter topic "${queue}"`, error)
    }
  }

  #stopPulling(subscription: PullSubscription): void {
    subscription.active = false
    subscription.abort.abort()
    subscription.wake?.()
  }

  /** Resolves once every delivery of `subscription` finished (they never reject), then stops its lease. */
  async #settled(subscription: PullSubscription): Promise<void> {
    while (subscription.handling.size > 0) await Promise.allSettled([...subscription.handling])
    if (subscription.timer !== undefined) clearInterval(subscription.timer)
    subscription.timer = undefined
    await subscription.extending
  }

  async #pull(subscription: PullSubscription): Promise<void> {
    const { options, path } = subscription
    const signal = subscription.abort.signal
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
      const started = Date.now()
      let received: ReceivedMessage[]
      try {
        const pulled = this.#sub(`pull from "${subscription.queue}"`).pull(
          { subscription: path, maxMessages: Math.min(MAX_PULL_MESSAGES, free) },
          { timeout: this.#pullTimeoutMs },
        )
        const outcome = await raceAbort(pulled, signal)
        if (outcome === ABORTED) {
          // a unary call cannot be cancelled: give back what it may still return
          pulled.then(
            ([response]) => this.#releaseAll(subscription, response.receivedMessages ?? []),
            () => undefined,
          )
          break
        }
        received = outcome[0].receivedMessages ?? []
        errorDelay = 500
      } catch (error) {
        if (!subscription.active) break
        if (statusOf(error) === Status.DeadlineExceeded) continue
        this.#logger.warn(`Pub/Sub: pulling "${subscription.queue}" failed, retrying in ${errorDelay} ms`, {
          err: error,
        })
        try {
          await sleep(errorDelay, signal)
        } catch {
          break
        }
        errorDelay = Math.min(errorDelay * 2, 30_000)
        continue
      }
      if (!subscription.active) {
        this.#releaseAll(subscription, received)
        break
      }
      if (received.length === 0) {
        // an empty answer well before the timeout: do not spin
        if (Date.now() - started < 1000) await sleep(250, signal).catch(() => undefined)
        continue
      }
      const ackIds = received.map(message => message.ackId).filter((ackId): ackId is string => !!ackId)
      for (const ackId of ackIds) subscription.leased.add(ackId)
      void this.#extend(subscription, ackIds)
      for (const message of received) this.#deliver(subscription, message)
    }
  }

  /**
   * Sets the lease deadline of `ackIds` (tracked in `subscription.extending`, failures logged).
   * Resolves once this extension landed.
   */
  #extend(subscription: PullSubscription, ackIds: readonly string[]): Promise<void> {
    const run = this.#modifyDeadline(subscription, ackIds, this.#ackDeadline).catch((error: unknown) => {
      this.#logger.warn(`Pub/Sub: failed to extend the ack deadline of ${ackIds.length} message(s)`, { err: error })
    })
    const previous = subscription.extending
    const all = previous === undefined ? run : Promise.all([previous, run]).then(() => undefined)
    subscription.extending = all
    void all.finally(() => {
      if (subscription.extending === all) subscription.extending = undefined
    })
    return run
  }

  async #modifyDeadline(subscription: PullSubscription, ackIds: readonly string[], seconds: number): Promise<void> {
    const subscriber = this.#sub('modify an ack deadline')
    for (let index = 0; index < ackIds.length; index += MAX_ACK_IDS_PER_REQUEST) {
      await subscriber.modifyAckDeadline({
        subscription: subscription.path,
        ackIds: ackIds.slice(index, index + MAX_ACK_IDS_PER_REQUEST),
        ackDeadlineSeconds: seconds,
      })
    }
  }

  #releaseAll(subscription: PullSubscription, received: readonly ReceivedMessage[]): void {
    const ackIds = received.map(message => message.ackId).filter((ackId): ackId is string => !!ackId)
    if (ackIds.length === 0 || this.#subscriber === undefined) return
    this.#modifyDeadline(subscription, ackIds, 0).catch((error: unknown) => {
      this.#logger.debug(`Pub/Sub: failed to release ${ackIds.length} message(s) pulled while stopping`, {
        err: error,
      })
    })
  }

  #deliver(subscription: PullSubscription, received: ReceivedMessage): void {
    const ackId = received.ackId as string
    const message = received.message ?? {}
    const subscriber = this.#sub('handle a message')
    const transport = headerRecord()
    const headers = headerRecord()
    for (const [name, value] of Object.entries(message.attributes ?? {})) {
      if (TRANSPORT_ATTRIBUTES.has(name)) transport[name] = value
      else headers[name] = value
    }
    const googleTrace = headers[GOOGLE_TRACEPARENT]
    if (googleTrace !== undefined && !Object.hasOwn(headers, TRACEPARENT)) headers[TRACEPARENT] = googleTrace
    const data = message.data
    const body: Uint8Array | string = data === undefined || data === null ? new Uint8Array() : toBytes(data)
    const messageId = message.messageId ?? ackId
    const memo = `${subscription.path}\u0000${messageId}`
    const native = Number(received.deliveryAttempt ?? 0)
    const attempt = native > 0 ? native : (this.#attempts.get(memo) ?? 1)
    const key =
      message.orderingKey === undefined || message.orderingKey === null || message.orderingKey === ''
        ? undefined
        : message.orderingKey
    const id = transport[MessagingHeaders.Id] ?? messageId

    subscription.inflight++
    let settled = false
    const settle = async (action: string, run: () => Promise<void>): Promise<void> => {
      if (settled) throw new Error(`[pubsub] message ${id} was already settled (${action})`)
      // stop the lease, and let an extension in flight land first: it must not override the settlement
      subscription.leased.delete(ackId)
      await subscription.extending
      await run()
      settled = true
    }
    const setDeadline = (seconds: number): Promise<void> =>
      subscriber
        .modifyAckDeadline({ subscription: subscription.path, ackIds: [ackId], ackDeadlineSeconds: seconds })
        .then(() => undefined)
    const acknowledge = (): Promise<void> =>
      subscriber.acknowledge({ subscription: subscription.path, ackIds: [ackId] }).then(() => {
        this.#attempts.delete(memo)
      })
    const delivery: DriverDelivery = {
      id,
      body,
      contentType: transport[MessagingHeaders.ContentType],
      headers,
      type: transport[MessagingHeaders.Type],
      key,
      attempt,
      redelivered: attempt > 1,
      timestamp: timestampOf(message.publishTime),
      raw: received,
      ack: (): Promise<void> => settle('ack', acknowledge),
      release: (): Promise<void> => settle('release', () => setDeadline(0)),
      retry: (request: RetryRequest): Promise<void> =>
        settle('retry', () => {
          if (native === 0) this.#rememberAttempt(memo, request.attempt)
          const seconds =
            subscription.retries === 'subscription'
              ? 0
              : Math.min(MAX_ACK_DEADLINE_SECONDS, Math.ceil(request.delayMs / 1000))
          return setDeadline(seconds)
        }),
      deadLetter: (request: DeadLetterRequest): Promise<void> =>
        settle('dead-letter', async () => {
          if (subscription.retries === 'subscription') return setDeadline(0)
          if (request.queue === undefined) {
            // no Znight dead letter: the subscription's policy applies, or the message is dropped
            return subscription.deadLetterPolicy === false ? acknowledge() : setDeadline(0)
          }
          const topic = subscription.deadLetterTopic ?? this.#topicPath(request.queue)
          await this.#publishTo(
            topic,
            request.queue,
            this.#deadLetterCopy(subscription, message, transport, headers, request),
          )
          await acknowledge()
        }),
    }
    const serialKey = subscription.ordered ? key : undefined
    const previous = serialKey === undefined ? undefined : subscription.groups.get(serialKey)
    const run = (): Promise<void> => subscription.handler(delivery)
    const handled = (previous === undefined ? run() : previous.then(run, run))
      .catch((error: unknown) => {
        this.#logger.error(`Pub/Sub: unexpected failure handling message ${id}`, { err: error })
      })
      .finally(() => {
        subscription.handling.delete(handled)
        subscription.leased.delete(ackId)
        subscription.inflight--
        if (serialKey !== undefined && subscription.groups.get(serialKey) === handled) {
          subscription.groups.delete(serialKey)
        }
        subscription.wake?.()
      })
    subscription.handling.add(handled)
    if (serialKey !== undefined) subscription.groups.set(serialKey, handled)
  }

  #rememberAttempt(memo: string, attempt: number): void {
    this.#attempts.delete(memo)
    this.#attempts.set(memo, attempt)
    if (this.#attempts.size > MAX_REMEMBERED_ATTEMPTS) {
      const oldest = this.#attempts.keys().next().value
      if (oldest !== undefined) this.#attempts.delete(oldest)
    }
  }

  /**
   * The dead-letter copy of a message: its data, ordering key and transport attributes, the headers
   * and the dead-letter attributes (`x-znight-error` truncated to fit an attribute). Headers beyond
   * the attribute limit are dropped (a warning is logged).
   */
  #deadLetterCopy(
    subscription: PullSubscription,
    message: PubsubMessage,
    transport: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>>,
    request: DeadLetterRequest,
  ): PubsubMessage {
    const extra = deadLetterHeaders(headers, request, subscription.queue)
    extra[MessagingHeaders.Error] = truncateBytes(extra[MessagingHeaders.Error] ?? '', MAX_ATTRIBUTE_VALUE_BYTES)
    const attributes = headerRecord()
    Object.assign(attributes, transport)
    const dropped: string[] = []
    const reserved = [
      MessagingHeaders.DeadLetterReason,
      MessagingHeaders.Error,
      MessagingHeaders.OriginalQueue,
      MessagingHeaders.Attempts,
    ]
    for (const name of reserved) attributes[name] = extra[name] ?? ''
    for (const [name, value] of Object.entries(extra)) {
      if (Object.hasOwn(attributes, name)) continue
      if (Object.keys(attributes).length >= MAX_ATTRIBUTES) dropped.push(name)
      else attributes[name] = value
    }
    if (dropped.length > 0) {
      this.#logger.warn(
        `Pub/Sub: dead-letter copy of message ${message.messageId ?? ''} exceeds ${MAX_ATTRIBUTES} attributes, dropped: ${dropped.join(', ')}`,
      )
    }
    const copy: PubsubMessage = { data: message.data ?? new Uint8Array(), attributes }
    if (message.orderingKey) copy.orderingKey = message.orderingKey
    return copy
  }
}

function isRetries(value: unknown): value is PubSubRetries {
  return value === 'znight' || value === 'subscription'
}

function mapName(names: PubSubNames | undefined, queue: string): string {
  if (names === undefined) return queue
  if (typeof names === 'function') return names(queue)
  return Object.hasOwn(names, queue) ? (names[queue] as string) : queue
}

/** gRPC status code of an error, `undefined` when it has none. */
function statusOf(error: unknown): number | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

/** Resolves with `promise`, or with {@link ABORTED} as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Checks Pub/Sub attribute limits (count, key and value sizes, reserved `goog` prefix). */
function checkAttributes(attributes: Readonly<Record<string, string>>, queue: string): void {
  const entries = Object.entries(attributes)
  if (entries.length > MAX_ATTRIBUTES) {
    throw new RangeError(
      `[znight] Pub/Sub messages carry at most ${MAX_ATTRIBUTES} attributes (Znight uses up to 3): too many headers for "${queue}"`,
    )
  }
  for (const [name, value] of entries) {
    if (name === '' || name.startsWith('goog') || Buffer.byteLength(name) > MAX_ATTRIBUTE_KEY_BYTES) {
      throw new TypeError(
        `[znight] "${truncate(name, 64)}" is not a valid Pub/Sub attribute name (1–${MAX_ATTRIBUTE_KEY_BYTES} bytes, not starting with "goog")`,
      )
    }
    if (Buffer.byteLength(value) > MAX_ATTRIBUTE_VALUE_BYTES) {
      throw new RangeError(
        `[znight] Pub/Sub attribute "${name}" is longer than ${MAX_ATTRIBUTE_VALUE_BYTES} bytes (header of a message for "${queue}")`,
      )
    }
  }
}

/** Truncates `text` to at most `max` UTF-8 bytes (with an ellipsis). */
function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let chars = max
  let result = truncate(text, chars)
  while (Buffer.byteLength(result) > max && chars > 1) {
    chars = Math.floor(chars * 0.9)
    result = truncate(text, chars)
  }
  return result
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'base64') : data
}

/** Epoch milliseconds of a protobuf timestamp. */
function timestampOf(time: protos.google.protobuf.ITimestamp | null | undefined): number | undefined {
  if (time === undefined || time === null) return undefined
  const seconds = Number(time.seconds ?? 0)
  const millis = seconds * 1000 + Math.floor((time.nanos ?? 0) / 1_000_000)
  return Number.isFinite(millis) && millis > 0 ? millis : undefined
}
