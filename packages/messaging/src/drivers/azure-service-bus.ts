/**
 * `@znight/messaging/azure-service-bus`: Azure Service Bus driver built on `@azure/service-bus` 7
 * (optional peer dependency). Design: RFC 0014 §4.1.
 *
 * - `publish(queue)` sends to the queue or topic `entities(queue)`; `@Consumer(queue)` receives from
 *   `subscriptions(queue)`: a queue, a topic subscription (`topic/subscription`) or the dead-letter
 *   sub-queue of either (`<entity>/$deadletterqueue`). Names default to the queue name.
 * - Peek-lock receives (`receiveMessages`), never more messages locked than the free concurrency
 *   slots. The SDK renews the lock of a message while it is handled
 *   (`maxAutoLockRenewalDurationInMs`). `ack` completes, `release` abandons.
 * - `retries: 'znight'` (default): a retry without delay abandons the message; a delayed retry
 *   schedules a copy on the queue (`scheduledEnqueueTimeUtc`, with `x-znight-attempt`), then
 *   completes the original (the JS SDK has no transactions: a crash in between duplicates, never
 *   loses). On a subscription (a copy sent to the topic would reach every subscription) or a
 *   dead-letter sub-queue, the message stays locked during the delay, then is abandoned. Attempts
 *   combine `x-znight-attempt` and the delivery count. Dead letters go to the
 *   entity's dead-letter sub-queue (`deadLetterMessage()` with the Znight properties) or, for another
 *   name, are sent there before the original is completed. `retries: 'entity'`: every failure
 *   abandons, the entity's `maxDeliveryCount` and dead-letter sub-queue own redelivery; only
 *   non-retryable failures are dead-lettered at once.
 * - Headers are application properties; the id is the message id, the type the subject, the key the
 *   session id and partition key. Delayed publishing schedules the message.
 * - Session-enabled entities are refused (session receivers are planned). Entities are checked with
 *   the administration client when it is allowed to read them, and created only with
 *   `provision: true`.
 */
import type {
  ServiceBusClientOptions,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusReceiverOptions,
  ServiceBusSender,
  TokenCredential,
} from '@azure/service-bus'
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

import { randomUUID } from 'node:crypto'
import { ServiceBusAdministrationClient, ServiceBusClient } from '@azure/service-bus'

import { bodyToBytes } from '../codec.ts'
import { brokerUnavailableError, consumerError } from '../errors.ts'
import { attemptFromHeaders, headerRecord, MessagingHeaders } from '../headers.ts'
import { errorMessage, sleep } from '../internal/async.ts'
import { deadLetterHeaders, durationOption, headerValueToString } from './shared.ts'

/** Entities by queue: a record (unlisted queues keep their name) or a function. */
export type AzureServiceBusNames = Readonly<Record<string, string>> | ((queue: string) => string)

/**
 * Who retries and dead-letters failed messages: Znight (`@Retry`, scheduled copies, Znight dead
 * letters) or the entity (`maxDeliveryCount` and its dead-letter sub-queue; every failure abandons).
 */
export type AzureServiceBusRetries = 'znight' | 'entity'

/** Options of {@link azureServiceBus}. One of `connectionString`, `fullyQualifiedNamespace` or `client` is required. */
export interface AzureServiceBusDriverOptions {
  /** Connection string of the namespace (a shared access policy, or the emulator's). */
  readonly connectionString?: string
  /** Namespace host (`<namespace>.servicebus.windows.net`), authenticated with `credential`. */
  readonly fullyQualifiedNamespace?: string
  /**
   * Microsoft Entra ID credential used with `fullyQualifiedNamespace`. Default: `DefaultAzureCredential`
   * of `@azure/identity` (an optional peer dependency, loaded on connect).
   */
  readonly credential?: TokenCredential
  /** An existing client (you keep ownership: it is not closed). */
  readonly client?: ServiceBusClient
  /** Options of the client created by the driver (retries, web sockets...). */
  readonly clientOptions?: ServiceBusClientOptions
  /**
   * Administration client checking (and, with `provision`, creating) entities. Default: one built
   * from the connection string or the namespace and credential (none with `client` only). `false`
   * skips the checks; a missing entity is then detected by a peek. With the emulator, point it at its
   * administration port (5300).
   */
  readonly administrationClient?: ServiceBusAdministrationClient | false
  /** Queue or topic of each queue published to. Default: the queue name. */
  readonly entities?: AzureServiceBusNames
  /**
   * Entity each `@Consumer` queue receives from: `queue`, `topic/subscription` (or
   * `topic/subscriptions/subscription`), optionally followed by `/$deadletterqueue`. Default: the
   * queue name.
   */
  readonly subscriptions?: AzureServiceBusNames
  /**
   * Who retries and dead-letters (RFC 0014 §4.1). Default: `'znight'`. Under `'entity'`, a consumer
   * can take the ownership back with `@Consumer({ queue, retries: 'znight' })`.
   */
  readonly retries?: AzureServiceBusRetries
  /** Longest retry delay waited in-process. Default: 1000 ms (`0` with `retries: 'entity'`). */
  readonly maxInProcessDelayMs?: number
  /** Longest wait of a receive for messages, in milliseconds. Default: 30 000. */
  readonly maxWaitTimeMs?: number
  /** How long the SDK keeps renewing the lock of a message being handled, in milliseconds. Default: 300 000. */
  readonly maxAutoLockRenewalDurationInMs?: number
  /** Default dead-letter queue of a queue. Default: `<queue>/$deadletterqueue` (the native sub-queue). */
  readonly deadLetterName?: (queue: string) => string
  /**
   * Creates the missing queues (with `maxDeliveryCount` covering the consumer's attempts), topics and
   * subscriptions, the queues published to and the dead-letter queues named after another entity.
   * For development and the emulator. Default: `false`.
   */
  readonly provision?: boolean
}

/** Creates an {@link AzureServiceBusDriver}. */
export function azureServiceBus(options: AzureServiceBusDriverOptions): AzureServiceBusDriver {
  return new AzureServiceBusDriver(options)
}

/** Name of the dead-letter sub-queue in an entity path. */
const DEAD_LETTER_QUEUE = '$deadletterqueue'
/** Longest native delay: scheduled messages have no practical limit, ten years is one. */
const MAX_SCHEDULE_DELAY_MS = 10 * 365 * 24 * 3600 * 1000
/** Longest session id and partition key. */
const MAX_KEY_LENGTH = 128
/** Delivery counts remembered for the messages of dead-letter sub-queues the driver did not dead-letter. */
const MAX_REMEMBERED_BASES = 10_000
/** Wait of the receive that probes an entity the administration client could not read. */
const PROBE_WAIT_MS = 50
/** `maxDeliveryCount` of the entities the driver creates (Service Bus default). */
const DEFAULT_MAX_DELIVERY_COUNT = 10
/**
 * Delivery count of a message when the driver dead-lettered it: the dead-letter sub-queue keeps the
 * count, attempts on it start over from there.
 */
const DELIVERY_BASE = 'x-znight-delivery-base'
/** Trace context written by the Azure SDK's instrumentation. */
const DIAGNOSTIC_ID = 'Diagnostic-Id'
const TRACEPARENT = 'traceparent'
/** Application properties carrying transport fields (not exposed as headers). */
const TRANSPORT_PROPERTIES = new Set<string>([
  MessagingHeaders.Id,
  MessagingHeaders.Type,
  MessagingHeaders.ContentType,
  DELIVERY_BASE,
])
/** Specifier of the optional peer providing `DefaultAzureCredential` (a variable: loaded lazily). */
const IDENTITY_PACKAGE: string = '@azure/identity'
const NATIVE: unique symbol = Symbol('native dead-letter sub-queue')

type PropertyValue = number | boolean | string | Date | null
type Properties = Record<string, PropertyValue>

/** Where a consumer receives from. */
interface Source {
  /** Queue or topic. */
  readonly entity: string
  /** Subscription of the topic, `undefined` for a queue. */
  readonly subscription: string | undefined
  /** The dead-letter sub-queue of the entity. */
  readonly deadLetter: boolean
  /** `queue`, `topic/subscription`, with `/$deadletterqueue` when it is the sub-queue. */
  readonly path: string
}

/** Settings of an entity read (or created) by the administration client. */
interface EntitySettings {
  readonly maxDeliveryCount: number
  readonly requiresSession: boolean
}

interface ReceiveSubscription {
  /** The `@Consumer` queue (logical name). */
  readonly queue: string
  readonly source: Source
  readonly receiver: ServiceBusReceiver
  readonly handler: DeliveryHandler
  readonly options: SubscribeOptions
  readonly retries: AzureServiceBusRetries
  /** Destination of Znight dead letters: the native sub-queue, another entity, or none. */
  readonly deadLetter: typeof NATIVE | string | undefined
  /** Deliveries not finished yet. */
  readonly handling: Set<Promise<void>>
  /** Messages kept locked until their retry delay elapses (subscriptions and dead-letter sub-queues). */
  readonly held: Map<ServiceBusReceivedMessage, ReturnType<typeof setTimeout>>
  readonly abort: AbortController
  inflight: number
  active: boolean
  closed: boolean
  wake: (() => void) | undefined
  loop: Promise<void> | undefined
}

/** Azure Service Bus {@link MessagingDriver}. See the module documentation. */
export class AzureServiceBusDriver implements MessagingDriver {
  readonly name = 'azure-service-bus'
  readonly capabilities: DriverCapabilities
  readonly #options: AzureServiceBusDriverOptions
  readonly #retries: AzureServiceBusRetries
  readonly #maxWaitTimeMs: number
  readonly #lockRenewalMs: number
  readonly #subscriptions = new Set<ReceiveSubscription>()
  readonly #senders = new Map<string, ServiceBusSender>()
  /** First delivery count seen of the messages of dead-letter sub-queues (`<path>\0<sequence number>`). */
  readonly #deliveryBases = new Map<string, number>()
  #client: ServiceBusClient | undefined
  #ownsClient = false
  #admin: ServiceBusAdministrationClient | undefined
  #credential: TokenCredential | undefined
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #closed = false

  constructor(options: AzureServiceBusDriverOptions) {
    if (
      options?.connectionString === undefined &&
      options?.fullyQualifiedNamespace === undefined &&
      options?.client === undefined
    ) {
      throw new TypeError('[znight] azureServiceBus() needs a connectionString, a fullyQualifiedNamespace or a client')
    }
    const retries = options.retries ?? 'znight'
    if (!isRetries(retries)) {
      throw new TypeError(`[znight] azureServiceBus(): retries must be 'znight' or 'entity', got ${String(retries)}`)
    }
    const inProcess = durationOption(options.maxInProcessDelayMs, 1000, 'azureServiceBus maxInProcessDelayMs')
    this.#maxWaitTimeMs = Math.max(1, durationOption(options.maxWaitTimeMs, 30_000, 'azureServiceBus maxWaitTimeMs'))
    this.#lockRenewalMs = durationOption(
      options.maxAutoLockRenewalDurationInMs,
      300_000,
      'azureServiceBus maxAutoLockRenewalDurationInMs',
    )
    this.#options = options
    this.#retries = retries
    this.capabilities = Object.freeze({
      nativeDelay: true,
      maxNativeDelayMs: MAX_SCHEDULE_DELAY_MS,
      maxInProcessDelayMs: retries === 'entity' ? 0 : inProcess,
      deliveryCount: 'native',
      maxPublishDelayMs: MAX_SCHEDULE_DELAY_MS,
    })
  }

  /** The Service Bus client (available once connected). */
  get client(): ServiceBusClient | undefined {
    return this.#client
  }

  /** The administration client checking entities (available once connected, unless disabled). */
  get administrationClient(): ServiceBusAdministrationClient | undefined {
    return this.#admin
  }

  /** The credential authenticating with the namespace, when one is used (available once connected). */
  get credential(): TokenCredential | undefined {
    return this.#credential
  }

  async connect(context: DriverContext): Promise<void> {
    this.#logger = context.logger
    if (this.#closed) throw brokerUnavailableError('Azure Service Bus: the driver is closed, create a new one')
    if (this.#client !== undefined) return
    const options = this.#options
    const namespace = options.fullyQualifiedNamespace
    let credential = options.credential
    if (options.client === undefined && options.connectionString === undefined) credential ??= await defaultCredential()
    let client: ServiceBusClient
    try {
      client = options.client ?? this.#createClient(namespace, credential)
      if (options.administrationClient !== false) {
        this.#admin = options.administrationClient ?? this.#createAdministrationClient(namespace, credential)
      }
    } catch (error) {
      throw brokerUnavailableError(`Azure Service Bus: cannot create the client (${errorMessage(error)})`, error)
    }
    this.#ownsClient = options.client === undefined
    this.#credential = credential
    this.#client = client
  }

  #createClient(namespace: string | undefined, credential: TokenCredential | undefined): ServiceBusClient {
    const { connectionString, clientOptions = {} } = this.#options
    if (connectionString !== undefined) return new ServiceBusClient(connectionString, clientOptions)
    return new ServiceBusClient(namespace as string, credential as TokenCredential, clientOptions)
  }

  /** The default administration client: same credentials as the client, none with a `client` only. */
  #createAdministrationClient(
    namespace: string | undefined,
    credential: TokenCredential | undefined,
  ): ServiceBusAdministrationClient | undefined {
    const { connectionString } = this.#options
    if (connectionString !== undefined) return new ServiceBusAdministrationClient(connectionString)
    if (namespace === undefined || credential === undefined) return undefined
    return new ServiceBusAdministrationClient(namespace, credential)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const subscriptions = [...this.#subscriptions]
    this.#subscriptions.clear()
    for (const subscription of subscriptions) stopReceiving(subscription)
    await Promise.allSettled(subscriptions.map(subscription => subscription.loop))
    await Promise.all(subscriptions.map(settled))
    await Promise.all(subscriptions.map(subscription => this.#releaseHeld(subscription)))
    await Promise.allSettled(subscriptions.map(subscription => closeReceiver(subscription)))
    const senders = [...this.#senders.values()]
    this.#senders.clear()
    await Promise.allSettled(senders.map(sender => sender.close()))
    const client = this.#client
    this.#client = undefined
    this.#admin = undefined
    if (this.#ownsClient) await client?.close().catch(() => undefined)
  }

  deadLetterName(queue: string): string {
    return this.#options.deadLetterName?.(queue) ?? `${queue}/${DEAD_LETTER_QUEUE}`
  }

  #bus(action: string): ServiceBusClient {
    const client = this.#client
    if (client === undefined) {
      throw brokerUnavailableError(
        this.#closed
          ? `Azure Service Bus: cannot ${action}, the driver is closed`
          : `Azure Service Bus: cannot ${action} before connect()`,
      )
    }
    return client
  }

  #sender(entity: string): ServiceBusSender {
    let sender = this.#senders.get(entity)
    if (sender === undefined) {
      sender = this.#bus(`send to "${entity}"`).createSender(entity)
      this.#senders.set(entity, sender)
    }
    return sender
  }

  /** The queue or topic a queue publishes to. */
  #entity(queue: string): string {
    const entity = mapName(this.#options.entities, queue)
    if (entity === '' || entity.includes('/')) {
      throw new TypeError(
        `[znight] Azure Service Bus: "${entity}" is not a queue or a topic: publish() publishes to a queue or a topic (a subscription receives what its topic gets)`,
      )
    }
    return entity
  }

  /** The entity a `@Consumer` queue receives from. */
  #source(queue: string): Source {
    const suffix = `/${DEAD_LETTER_QUEUE}`
    const deadLetter = queue.toLowerCase().endsWith(suffix)
    const base = deadLetter ? queue.slice(0, -suffix.length) : queue
    const path = `${mapName(this.#options.subscriptions, base)}${deadLetter ? suffix : ''}`
    const segments = path.split('/')
    const subQueue = segments.length > 1 && segments[segments.length - 1]?.toLowerCase() === DEAD_LETTER_QUEUE
    if (subQueue) segments.pop()
    if (segments.length === 3 && segments[1]?.toLowerCase() === 'subscriptions') segments.splice(1, 1)
    const [entity, subscription] = segments
    if (entity === undefined || segments.length > 2 || segments.some(segment => segment === '')) {
      throw consumerError(
        `Azure Service Bus: "${path}" is not a queue, a topic/subscription or one of their dead-letter sub-queues (<entity>/${DEAD_LETTER_QUEUE})`,
      )
    }
    return {
      entity,
      subscription,
      deadLetter: subQueue,
      path: `${subscription === undefined ? entity : `${entity}/${subscription}`}${subQueue ? suffix : ''}`,
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------------------------------

  async publish(queue: string, message: OutboundMessage): Promise<void> {
    const entity = this.#entity(queue)
    const properties: Properties = headerRecord()
    for (const [name, value] of Object.entries(message.headers)) {
      if (!TRANSPORT_PROPERTIES.has(name)) properties[name] = value
    }
    const outgoing: ServiceBusMessage = {
      body: Buffer.from(bodyToBytes(message.body)),
      messageId: message.id,
      contentType: message.contentType,
      applicationProperties: properties,
    }
    if (message.type !== undefined) outgoing.subject = message.type
    if (message.key !== undefined && message.key !== '') {
      if (message.key.length > MAX_KEY_LENGTH) {
        throw new RangeError(
          `[znight] Azure Service Bus: the key of a message for "${queue}" becomes its session id and partition key, at most ${MAX_KEY_LENGTH} characters`,
        )
      }
      outgoing.sessionId = message.key
      outgoing.partitionKey = message.key
    }
    if (message.delayMs > 0) {
      const at = new Date(Date.now() + message.delayMs)
      await this.#send(entity, queue, sender => sender.scheduleMessages(outgoing, at))
    } else {
      await this.#send(entity, queue, sender => sender.sendMessages(outgoing))
    }
  }

  /** Sends through the sender of `entity`, creating a missing entity (a queue) with `provision`. */
  async #send(entity: string, label: string, send: (sender: ServiceBusSender) => Promise<unknown>): Promise<void> {
    try {
      await send(this.#sender(entity))
    } catch (error) {
      if (!isNotFound(error)) throw error
      // the sender's link could not attach: start over with a new one
      const failed = this.#senders.get(entity)
      this.#senders.delete(entity)
      await failed?.close().catch(() => undefined)
      const admin = this.#admin
      if (this.#options.provision !== true || admin === undefined) {
        throw consumerError(`Azure Service Bus: queue or topic "${label}" not found (${entity})`, [
          'Create the queue or topic, or map the queue to an existing entity with azureServiceBus({ entities })',
          'Or set azureServiceBus({ provision: true }) in development',
        ])
      }
      await this.#createQueue(admin, entity, DEFAULT_MAX_DELIVERY_COUNT)
      await send(this.#sender(entity))
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Subscribing
  // -----------------------------------------------------------------------------------------------

  async subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    const client = this.#bus(`subscribe to "${queue}"`)
    const retries = this.#consumerRetries(options)
    const source = this.#source(queue)
    const kind = describeSource(source, queue)
    if (retries === 'entity' && source.deadLetter) {
      throw consumerError(
        `Azure Service Bus: ${options.consumer} lets the entity retry the messages of ${kind}, but a dead-letter sub-queue has no maxDeliveryCount: they would be redelivered forever`,
        ["Let Znight retry them: @Consumer({ queue, retries: 'znight', deadLetter: false })"],
      )
    }
    let deadLetter: ReceiveSubscription['deadLetter']
    if (retries === 'znight' && options.deadLetterQueue !== undefined) {
      if (options.deadLetterQueue === this.deadLetterName(queue)) {
        if (source.deadLetter) {
          throw consumerError(
            `Azure Service Bus: ${options.consumer} dead-letters the messages of ${kind}, but a dead-letter sub-queue has no dead-letter sub-queue`,
            [
              'Disable dead-lettering: @Consumer({ queue, deadLetter: false })',
              'Or dead-letter to another entity: @Consumer({ queue, deadLetter: "<queue or topic>" })',
            ],
          )
        }
        deadLetter = NATIVE
      } else {
        try {
          deadLetter = this.#entity(options.deadLetterQueue)
        } catch (error) {
          throw consumerError(`${options.consumer}: ${errorMessage(error).replace('[znight] ', '')}`)
        }
      }
    }
    const longest = options.retryDelays[options.retryDelays.length - 1] ?? 0
    if (retries === 'znight' && !schedulable(source) && longest > this.#lockRenewalMs) {
      throw consumerError(
        `Azure Service Bus: ${options.consumer} retries the messages of ${kind} after up to ${longest} ms, but a retry on a ${source.deadLetter ? 'dead-letter sub-queue' : 'subscription'} keeps the message locked during its delay, at most maxAutoLockRenewalDurationInMs (${this.#lockRenewalMs} ms)`,
        [
          `Keep the @Retry delays within ${this.#lockRenewalMs} ms, or raise azureServiceBus({ maxAutoLockRenewalDurationInMs })`,
          'Or forward the subscription to a queue (forwardTo) and consume the queue: delayed retries are then scheduled copies',
          "Or let the entity own retries: azureServiceBus({ retries: 'entity' })",
        ],
      )
    }
    const verified = await this.#verify(source, queue, kind, retries, options)
    if (deadLetter !== undefined && deadLetter !== NATIVE) {
      await this.#verifyDeadLetterEntity(deadLetter, options.deadLetterQueue as string)
    }
    const receiverOptions: ServiceBusReceiverOptions = {
      receiveMode: 'peekLock',
      maxAutoLockRenewalDurationInMs: this.#lockRenewalMs,
      skipParsingBodyAsJson: true,
      ...(source.deadLetter ? { subQueueType: 'deadLetter' as const } : {}),
    }
    const receiver =
      source.subscription === undefined
        ? client.createReceiver(source.entity, receiverOptions)
        : client.createReceiver(source.entity, source.subscription, receiverOptions)
    // the settings could not be read: a first receive attaches the link, which fails on a missing or
    // session-enabled entity (a peek would not: it goes through the management link)
    let probed: readonly ServiceBusReceivedMessage[] = []
    if (!verified) {
      try {
        probed = await receiver.receiveMessages(options.concurrency, {
          maxWaitTimeInMs: Math.min(PROBE_WAIT_MS, this.#maxWaitTimeMs),
        })
      } catch (error) {
        await receiver.close().catch(() => undefined)
        if (isNotFound(error)) throw this.#notFound(kind, source, queue)
        if (requiresSessions(error)) throw sessionsRefused(kind, options.consumer)
        throw brokerUnavailableError(`Azure Service Bus: cannot receive from ${kind} (${errorMessage(error)})`, error)
      }
    }

    const subscription: ReceiveSubscription = {
      queue,
      source,
      receiver,
      handler,
      options,
      retries,
      deadLetter,
      handling: new Set(),
      held: new Map(),
      abort: new AbortController(),
      inflight: 0,
      active: true,
      closed: false,
      wake: undefined,
      loop: undefined,
    }
    this.#subscriptions.add(subscription)
    for (const message of probed) this.#deliver(subscription, message)
    subscription.loop = this.#receive(subscription)
    return {
      nativeDeadLetter: retries === 'entity',
      cancel: async (): Promise<void> => {
        stopReceiving(subscription)
        await subscription.loop
      },
      close: async (): Promise<void> => {
        stopReceiving(subscription)
        this.#subscriptions.delete(subscription)
        await subscription.loop
        await settled(subscription)
        await this.#releaseHeld(subscription)
        await closeReceiver(subscription)
      },
    }
  }

  /**
   * A delayed retry on an entity that cannot receive a scheduled copy (a subscription: the copy would
   * reach every subscription of the topic; a dead-letter sub-queue): the message stays locked (the
   * SDK renews the lock) and is abandoned once the delay elapsed, which counts the next attempt.
   * Settled at once for the runtime, but it keeps its concurrency slot until it is abandoned (the
   * receive loop counts the held messages); given back on close.
   */
  #hold(subscription: ReceiveSubscription, message: ServiceBusReceivedMessage, delayMs: number): void {
    const timer = setTimeout(() => {
      subscription.held.delete(message)
      void this.#abandon(subscription, message, 'abandon a message after its retry delay').then(() =>
        subscription.wake?.(),
      )
    }, delayMs)
    subscription.held.set(message, timer)
  }

  /** Abandons the messages held for a retry (shutdown): they are redelivered at once. */
  async #releaseHeld(subscription: ReceiveSubscription): Promise<void> {
    const held = [...subscription.held]
    subscription.held.clear()
    await Promise.all(
      held.map(([message, timer]) => {
        clearTimeout(timer)
        return this.#abandon(subscription, message, 'give back a message held for a retry')
      }),
    )
  }

  /** Abandons a message in the background (its lock expires anyway when this fails). */
  #abandon(subscription: ReceiveSubscription, message: ServiceBusReceivedMessage, action: string): Promise<void> {
    return subscription.receiver.abandonMessage(message).catch((error: unknown) => {
      this.#logger.warn(`Azure Service Bus: failed to ${action} (its lock expires: it is redelivered then)`, {
        err: error,
      })
    })
  }

  #consumerRetries(options: SubscribeOptions): AzureServiceBusRetries {
    const value = options.options['retries']
    if (value === undefined) return this.#retries
    if (!isRetries(value)) {
      throw consumerError(
        `${options.consumer}: the Azure Service Bus option retries must be 'znight' or 'entity', got ${String(value)}`,
      )
    }
    if (value === 'entity' && this.#retries === 'znight') {
      // the in-process retry budget is driver-wide: it follows azureServiceBus({ retries })
      throw consumerError(
        `${options.consumer}: @Consumer({ retries: 'entity' }) needs a driver created with azureServiceBus({ retries: 'entity' })`,
        [
          "Set azureServiceBus({ retries: 'entity' }), and give the ownership back to Znight where needed with @Consumer({ queue, retries: 'znight' })",
          "Or remove retries: 'entity' from the consumer",
        ],
      )
    }
    return value
  }

  #notFound(kind: string, source: Source, queue: string): Error {
    return consumerError(`Azure Service Bus: ${kind} not found${source.path === queue ? '' : ` (${source.path})`}`, [
      'Create it, or map the queue to an existing entity with azureServiceBus({ subscriptions })',
      'Or set azureServiceBus({ provision: true }) in development',
    ])
  }

  /**
   * Checks the entity with the administration client: it exists (or is created with `provision`), has
   * no sessions, and its `maxDeliveryCount` fits the retry owner. Returns `false` when it could not be
   * read (no administration client, no Manage right...): a peek then checks that it exists.
   */
  async #verify(
    source: Source,
    queue: string,
    kind: string,
    retries: AzureServiceBusRetries,
    options: SubscribeOptions,
  ): Promise<boolean> {
    const admin = this.#admin
    if (admin === undefined) return false
    let settings: EntitySettings
    try {
      settings =
        source.subscription === undefined
          ? await admin.getQueue(source.entity)
          : await admin.getSubscription(source.entity, source.subscription)
    } catch (error) {
      if (!isNotFound(error)) {
        this.#logger.warn(
          `Azure Service Bus: cannot read ${kind} with the administration client (${errorMessage(error)}): its settings are not checked`,
        )
        return false
      }
      if (this.#options.provision !== true || source.deadLetter) throw this.#notFound(kind, source, queue)
      settings = await this.#provision(admin, source, retries, options)
    }
    if (source.deadLetter) return true
    if (settings.requiresSession) throw sessionsRefused(kind, options.consumer)
    const max = settings.maxDeliveryCount
    const forwards = `${kind} dead-letters messages after ${max} delivery attempt(s), but ${options.consumer} allows ${options.maxAttempts} attempt(s)`
    if (retries === 'znight' && max < options.maxAttempts) {
      throw consumerError(`Azure Service Bus: ${forwards}`, [
        `Raise the maxDeliveryCount of "${source.path}" to at least ${options.maxAttempts}`,
        "Or lower the @Retry attempts, or let the entity own retries: azureServiceBus({ retries: 'entity' })",
      ])
    }
    if (retries === 'entity' && max !== options.maxAttempts) {
      this.#logger.warn(
        `Azure Service Bus: ${forwards}: set the @Retry attempts to ${max} so that the handler runs on every delivery`,
      )
    }
    return true
  }

  /** Creates the queue, or the topic and the subscription, of a consumer. */
  async #provision(
    admin: ServiceBusAdministrationClient,
    source: Source,
    retries: AzureServiceBusRetries,
    options: SubscribeOptions,
  ): Promise<EntitySettings> {
    const maxDeliveryCount =
      retries === 'entity'
        ? Math.max(1, options.maxAttempts)
        : Math.max(DEFAULT_MAX_DELIVERY_COUNT, options.maxAttempts)
    if (source.subscription === undefined) {
      await this.#createQueue(admin, source.entity, maxDeliveryCount)
    } else {
      await ignoreConflict(admin.createTopic(source.entity))
      await ignoreConflict(admin.createSubscription(source.entity, source.subscription, { maxDeliveryCount }))
      this.#logger.info(`Azure Service Bus: created subscription ${source.path}`)
    }
    return { maxDeliveryCount, requiresSession: false }
  }

  async #createQueue(admin: ServiceBusAdministrationClient, name: string, maxDeliveryCount: number): Promise<void> {
    await ignoreConflict(admin.createQueue(name, { maxDeliveryCount }))
    this.#logger.info(`Azure Service Bus: created queue ${name}`)
  }

  /** Checks that the queue or topic receiving Znight dead letters exists. */
  async #verifyDeadLetterEntity(entity: string, label: string): Promise<void> {
    const admin = this.#admin
    if (admin === undefined) return
    try {
      await admin.getQueue(entity)
      return
    } catch (error) {
      if (!isNotFound(error)) {
        this.#logger.warn(
          `Azure Service Bus: cannot read the dead-letter queue "${label}" (${errorMessage(error)}): not checked`,
        )
        return
      }
    }
    try {
      await admin.getTopic(entity)
    } catch (error) {
      if (!isNotFound(error)) {
        this.#logger.warn(
          `Azure Service Bus: cannot read the dead-letter topic "${label}" (${errorMessage(error)}): not checked`,
        )
        return
      }
      if (this.#options.provision === true) return this.#createQueue(admin, entity, DEFAULT_MAX_DELIVERY_COUNT)
      throw consumerError(`Azure Service Bus: dead-letter queue or topic "${label}" not found (${entity})`, [
        'Create it',
        'Or use the native dead-letter sub-queue: remove the deadLetter option of the consumer',
        'Or set azureServiceBus({ provision: true }) in development',
      ])
    }
  }

  async #receive(subscription: ReceiveSubscription): Promise<void> {
    const { options, receiver } = subscription
    const signal = subscription.abort.signal
    let errorDelay = 500
    while (subscription.active) {
      // a message held for a delayed retry stays locked: it keeps its slot
      const free = options.concurrency - subscription.inflight - subscription.held.size
      if (free <= 0) {
        await new Promise<void>(resolve => {
          subscription.wake = resolve
        })
        subscription.wake = undefined
        continue
      }
      let received: ServiceBusReceivedMessage[]
      try {
        // an abort while messages arrive leaves them locked: they come back once their lock expires
        received = await receiver.receiveMessages(free, { maxWaitTimeInMs: this.#maxWaitTimeMs, abortSignal: signal })
        errorDelay = 500
      } catch (error) {
        if (!subscription.active) break
        if (requiresSessions(error)) {
          // permanent: the entity was made session-enabled after the subscribe-time check
          this.#logger.error(`Azure Service Bus: stopped receiving from "${subscription.queue}"`, {
            err: sessionsRefused(describeSource(subscription.source, subscription.queue), options.consumer),
          })
          subscription.active = false
          break
        }
        this.#logger.warn(
          `Azure Service Bus: receiving from "${subscription.queue}" failed, retrying in ${errorDelay} ms`,
          { err: error },
        )
        try {
          await sleep(errorDelay, signal)
        } catch {
          break
        }
        errorDelay = Math.min(errorDelay * 2, 30_000)
        continue
      }
      for (const message of received) {
        if (subscription.active) this.#deliver(subscription, message)
        else {
          receiver.abandonMessage(message).catch((error: unknown) => {
            this.#logger.debug('Azure Service Bus: failed to give back a message received while stopping', {
              err: error,
            })
          })
        }
      }
    }
  }

  /** The delivery count of the first delivery of `memo` this process saw (bounded memory). */
  #firstDelivery(memo: string, deliveryCount: number): number {
    const known = this.#deliveryBases.get(memo)
    if (known !== undefined) return known
    this.#deliveryBases.set(memo, deliveryCount)
    if (this.#deliveryBases.size > MAX_REMEMBERED_BASES) {
      const oldest = this.#deliveryBases.keys().next().value
      if (oldest !== undefined) this.#deliveryBases.delete(oldest)
    }
    return deliveryCount
  }

  #deliver(subscription: ReceiveSubscription, message: ServiceBusReceivedMessage): void {
    const { receiver } = subscription
    const transport = headerRecord()
    const headers = headerRecord()
    for (const [name, value] of Object.entries(message.applicationProperties ?? {})) {
      const text = headerValueToString(value)
      if (text === undefined) continue
      if (TRANSPORT_PROPERTIES.has(name)) transport[name] = text
      else headers[name] = text
    }
    const diagnostic = headers[DIAGNOSTIC_ID]
    if (diagnostic !== undefined && !Object.hasOwn(headers, TRACEPARENT)) headers[TRACEPARENT] = diagnostic
    const body = bodyOf(message.body)
    const native = Number.isSafeInteger(message.deliveryCount) ? Math.max(0, message.deliveryCount as number) : 0
    // the delivery count a dead-letter sub-queue kept: recorded by the driver that dead-lettered the
    // message, else the count of its first delivery from the sub-queue seen by this process
    // (ignored elsewhere: a dead letter resubmitted to its entity starts its deliveries over)
    const recorded = Number(transport[DELIVERY_BASE])
    let base = 0
    let memo: string | undefined
    if (subscription.source.deadLetter && Number.isSafeInteger(recorded) && recorded >= 0 && recorded <= native) {
      base = recorded
    } else if (subscription.source.deadLetter) {
      memo = `${subscription.source.path}\u0000${message.sequenceNumber?.toString() ?? messageIdOf(message.messageId) ?? ''}`
      base = this.#firstDelivery(memo, native)
    }
    const forget = (): void => {
      if (memo !== undefined) this.#deliveryBases.delete(memo)
    }
    const attempt = attemptFromHeaders(headers) + Math.max(0, native - base)
    const id = transport[MessagingHeaders.Id] ?? messageIdOf(message.messageId) ?? message.lockToken ?? randomUUID()
    const key = nonEmpty(message.sessionId) ?? nonEmpty(message.partitionKey)
    const timestamp = message.enqueuedTimeUtc?.getTime()

    subscription.inflight++
    let done = false
    const settle = async (action: string, run: () => Promise<void>): Promise<void> => {
      if (done) throw new Error(`[azure-service-bus] message ${id} was already settled (${action})`)
      await run()
      done = true
    }
    const delivery: DriverDelivery = {
      id,
      body,
      contentType: message.contentType,
      headers,
      type: message.subject,
      key,
      attempt,
      redelivered: native > 0 || attempt > 1,
      timestamp: timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : undefined,
      raw: message,
      ack: (): Promise<void> => settle('ack', () => receiver.completeMessage(message).then(forget)),
      release: (): Promise<void> => settle('release', () => receiver.abandonMessage(message)),
      retry: (request: RetryRequest): Promise<void> =>
        settle('retry', async () => {
          const source = subscription.source
          // abandoning redelivers at once and counts a delivery: the next attempt
          if (subscription.retries === 'entity' || request.delayMs <= 0) return receiver.abandonMessage(message)
          if (!schedulable(source)) return this.#hold(subscription, message, request.delayMs)
          const copy = copyOf(message, id, body, headers)
          ;(copy.applicationProperties as Properties)[MessagingHeaders.Attempt] = String(request.attempt)
          await this.#sender(source.entity).scheduleMessages(copy, new Date(Date.now() + request.delayMs))
          await receiver.completeMessage(message)
        }),
      deadLetter: (request: DeadLetterRequest): Promise<void> =>
        settle('dead-letter', async () => {
          if (subscription.retries === 'entity') {
            // the entity counts the deliveries: the last abandon dead-letters the message natively
            if (request.reason === 'max-attempts') return receiver.abandonMessage(message)
            return receiver.deadLetterMessage(message, nativeDeadLetter(subscription.queue, headers, request, native))
          }
          if (request.queue === undefined) return receiver.completeMessage(message).then(forget)
          if (subscription.deadLetter === NATIVE) {
            return receiver.deadLetterMessage(message, nativeDeadLetter(subscription.queue, headers, request, native))
          }
          const entity = subscription.deadLetter ?? this.#entity(request.queue)
          const copy = copyOf(message, id, body, deadLetterHeaders(headers, request, subscription.queue))
          await this.#send(entity, request.queue, sender => sender.sendMessages(copy))
          await receiver.completeMessage(message)
          forget()
        }),
    }
    const handled = subscription
      .handler(delivery)
      .catch((error: unknown) => {
        this.#logger.error(`Azure Service Bus: unexpected failure handling message ${id}`, { err: error })
      })
      .finally(() => {
        subscription.handling.delete(handled)
        subscription.inflight--
        subscription.wake?.()
      })
    subscription.handling.add(handled)
  }
}

function isRetries(value: unknown): value is AzureServiceBusRetries {
  return value === 'znight' || value === 'entity'
}

function mapName(names: AzureServiceBusNames | undefined, queue: string): string {
  if (names === undefined) return queue
  if (typeof names === 'function') return names(queue)
  return Object.hasOwn(names, queue) ? (names[queue] as string) : queue
}

/** `queue "orders"`, `subscription "billing"`, `dead-letter sub-queue "orders/$deadletterqueue"`. */
function describeSource(source: Source, queue: string): string {
  if (source.deadLetter) return `dead-letter sub-queue "${queue}"`
  return `${source.subscription === undefined ? 'queue' : 'subscription'} "${queue}"`
}

/** A delayed retry can be a copy scheduled on the entity: a queue (not its dead-letter sub-queue). */
function schedulable(source: Source): boolean {
  return source.subscription === undefined && !source.deadLetter
}

function stopReceiving(subscription: ReceiveSubscription): void {
  subscription.active = false
  subscription.abort.abort()
  subscription.wake?.()
}

/** Resolves once every delivery of `subscription` finished (they never reject). */
async function settled(subscription: ReceiveSubscription): Promise<void> {
  while (subscription.handling.size > 0) await Promise.allSettled([...subscription.handling])
}

async function closeReceiver(subscription: ReceiveSubscription): Promise<void> {
  if (subscription.closed) return
  subscription.closed = true
  await subscription.receiver.close()
}

/** A non-session receiver attached to a session-enabled entity (`amqp:not-allowed` from the service). */
function requiresSessions(error: unknown): boolean {
  return /requires sessions/i.test(errorMessage(error))
}

function sessionsRefused(kind: string, consumer: string): Error {
  return consumerError(
    `Azure Service Bus: ${kind} requires sessions, which the driver does not support yet (${consumer})`,
    ['Consume an entity without sessions (ordering: one consumer with concurrency 1)'],
  )
}

/** A missing entity: `MessagingEntityNotFound` (AMQP) or a 404 of the administration client. */
function isNotFound(error: unknown): boolean {
  const failure = error as { readonly code?: unknown; readonly statusCode?: unknown } | null
  return (
    failure?.code === 'MessagingEntityNotFound' ||
    failure?.code === 'MessageEntityNotFoundError' ||
    failure?.statusCode === 404
  )
}

/** Awaits a creation, ignoring "already exists" (another instance created it first). */
async function ignoreConflict(creation: Promise<unknown>): Promise<void> {
  try {
    await creation
  } catch (error) {
    const failure = error as { readonly code?: unknown; readonly statusCode?: unknown } | null
    if (failure?.code !== 'MessageEntityAlreadyExistsError' && failure?.statusCode !== 409) throw error
  }
}

/** `DefaultAzureCredential` of `@azure/identity`, imported when first needed. */
async function defaultCredential(): Promise<TokenCredential> {
  let identity: { readonly DefaultAzureCredential: new () => TokenCredential }
  try {
    identity = (await import(/* @vite-ignore */ IDENTITY_PACKAGE)) as typeof identity
  } catch (error) {
    throw brokerUnavailableError(
      `Azure Service Bus: a fullyQualifiedNamespace without credential authenticates with DefaultAzureCredential, but the optional peer dependency "${IDENTITY_PACKAGE}" cannot be loaded (${errorMessage(error)}): install it, or pass azureServiceBus({ credential })`,
      error,
    )
  }
  return new identity.DefaultAzureCredential()
}

/** The body as received: bytes (data sections, `skipParsingBodyAsJson`) or text. */
function bodyOf(body: unknown): Uint8Array | string {
  if (body === undefined || body === null) return new Uint8Array()
  if (typeof body === 'string' || body instanceof Uint8Array) return body
  // an AMQP value or sequence section written by another client
  return JSON.stringify(body) ?? ''
}

function messageIdOf(id: ServiceBusReceivedMessage['messageId']): string | undefined {
  if (id === undefined || id === null) return undefined
  if (typeof id === 'string') return id
  return id instanceof Uint8Array ? Buffer.from(id).toString('hex') : String(id)
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * A copy of a received message (scheduled retry or dead letter sent to another entity): its body,
 * subject, content type, session and partition keys, `properties` and the Znight id (the copy gets a
 * message id of its own, so that duplicate detection never drops it).
 */
function copyOf(
  message: ServiceBusReceivedMessage,
  id: string,
  body: Uint8Array | string,
  properties: Readonly<Record<string, string>>,
): ServiceBusMessage {
  const applicationProperties: Properties = headerRecord()
  Object.assign(applicationProperties, properties)
  applicationProperties[MessagingHeaders.Id] = id
  const copy: ServiceBusMessage = {
    body: Buffer.from(bodyToBytes(body)),
    messageId: randomUUID(),
    applicationProperties,
  }
  if (message.contentType !== undefined) copy.contentType = message.contentType
  if (message.subject !== undefined) copy.subject = message.subject
  if (message.sessionId !== undefined) copy.sessionId = message.sessionId
  if (message.partitionKey !== undefined) copy.partitionKey = message.partitionKey
  return copy
}

/**
 * Options of `deadLetterMessage()`: the reason and the error as the native dead-letter fields, the
 * Znight dead-letter properties, the attempt counter cleared, and the delivery count reached (the
 * sub-queue keeps it: attempts on it start over at 1).
 */
function nativeDeadLetter(
  queue: string,
  headers: Readonly<Record<string, string>>,
  request: DeadLetterRequest,
  deliveryCount: number,
): { deadLetterReason: string; deadLetterErrorDescription: string } & Properties {
  const extra = deadLetterHeaders(headers, request, queue)
  const options: { deadLetterReason: string; deadLetterErrorDescription: string } & Properties = {
    deadLetterReason: request.reason,
    deadLetterErrorDescription: extra[MessagingHeaders.Error] ?? '',
  }
  for (const name of [
    MessagingHeaders.DeadLetterReason,
    MessagingHeaders.Error,
    MessagingHeaders.OriginalQueue,
    MessagingHeaders.Attempts,
  ]) {
    options[name] = extra[name] ?? ''
  }
  options[MessagingHeaders.Attempt] = null
  options[DELIVERY_BASE] = deliveryCount
  return options
}
