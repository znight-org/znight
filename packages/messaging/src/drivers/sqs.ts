/**
 * `@znight/messaging/sqs`: Amazon SQS driver built on `@aws-sdk/client-sqs` v3 (optional peer
 * dependency). Standard and FIFO queues.
 *
 * - Long polling (`WaitTimeSeconds`, default 20 s), never more messages in flight than the consumer
 *   concurrency (batches of up to 10).
 * - Attempts come from `ApproximateReceiveCount`.
 * - Retries change the visibility timeout of the message (`ChangeMessageVisibility`): the message
 *   reappears after the delay (up to 12 h), no republication.
 * - The visibility of in-flight messages is extended while their handler runs (lease extension).
 * - Dead letters are sent to the dead-letter queue (`<queue>-dlq`, or the target of the queue
 *   `RedrivePolicy`), then deleted from the queue. At subscribe time the driver verifies that the
 *   dead-letter queue exists and that the redrive `maxReceiveCount` allows every `@Retry` attempt.
 * - Headers are message attributes (SQS allows 10 per message); binary payloads are sent base64
 *   encoded (`x-znight-encoding: base64`).
 */
import type { Message, MessageAttributeValue, SendMessageCommandInput, SQSClientConfig } from '@aws-sdk/client-sqs'
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
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'

import { bodyToBytes } from '../codec.ts'
import { brokerUnavailableError, consumerError } from '../errors.ts'
import { headerRecord, MessagingHeaders } from '../headers.ts'
import { errorMessage, sleep, truncate } from '../internal/async.ts'
import { durationOption, MAX_ERROR_HEADER_LENGTH } from './shared.ts'

/** Options of {@link sqs}. */
export interface SqsDriverOptions {
  /** An existing client (you keep ownership: it is not destroyed on close). */
  readonly client?: SQSClient
  /** Configuration of the client created by the driver (region, endpoint, credentials...). */
  readonly clientConfig?: SQSClientConfig
  /** Queue URLs by queue name, to skip `GetQueueUrl`. Queue arguments may also be full URLs. */
  readonly queueUrls?: Readonly<Record<string, string>>
  /** Long polling duration, in seconds (0–20). Default: 20. */
  readonly waitTimeSeconds?: number
  /** Visibility timeout of received messages, in seconds. Default: the queue attribute. */
  readonly visibilityTimeout?: number
  /** Extend the visibility of messages while they are handled. Default: `true`. */
  readonly extendVisibility?: boolean
  /** Longest retry delay waited in-process. Default: 1000 ms (SQS delays have a 1 s granularity). */
  readonly maxInProcessDelayMs?: number
  /** Default dead-letter queue name. Default: `<queue>-dlq` (`<name>-dlq.fifo` for FIFO queues). */
  readonly deadLetterName?: (queue: string) => string
}

/** Longest visibility timeout (12 hours). */
const MAX_VISIBILITY_SECONDS = 43_200
/** Longest `DelaySeconds` (15 minutes). */
const MAX_DELAY_SECONDS = 900
const MAX_ATTRIBUTES = 10
const ATTRIBUTE_NAME = /^(?!aws\.|amazon\.)(?!\.)(?!.*\.\.)[\w.-]{1,256}(?<!\.)$/i
/** Message attributes carrying transport fields (not exposed as headers). */
const TRANSPORT_ATTRIBUTES = new Set<string>([
  MessagingHeaders.Id,
  MessagingHeaders.Type,
  MessagingHeaders.ContentType,
  MessagingHeaders.Encoding,
])

/** Creates a {@link SqsDriver}. */
export function sqs(options: SqsDriverOptions = {}): SqsDriver {
  return new SqsDriver(options)
}

interface QueueInfo {
  readonly name: string
  readonly url: string
  readonly fifo: boolean
}

interface SqsSubscription {
  readonly queue: QueueInfo
  readonly handler: DeliveryHandler
  readonly options: SubscribeOptions
  readonly deadLetter: QueueInfo | undefined
  readonly visibilityTimeout: number
  readonly abort: AbortController
  /** Last delivery of each FIFO message group (serialised per group). */
  readonly groups: Map<string, Promise<void>>
  inflight: number
  active: boolean
  wake: (() => void) | undefined
  loop: Promise<void> | undefined
}

/** Amazon SQS {@link MessagingDriver}. See the module documentation. */
export class SqsDriver implements MessagingDriver {
  readonly name = 'sqs'
  readonly capabilities: DriverCapabilities
  readonly #options: SqsDriverOptions
  readonly #subscriptions = new Set<SqsSubscription>()
  readonly #queues = new Map<string, Promise<QueueInfo>>()
  #client: SQSClient | undefined
  #ownsClient = false
  #logger: DriverContext['logger'] = { debug() {}, info() {}, warn() {}, error() {} }
  #closed = false

  constructor(options: SqsDriverOptions = {}) {
    const wait = options.waitTimeSeconds
    if (wait !== undefined && !(Number.isInteger(wait) && wait >= 0 && wait <= 20)) {
      throw new TypeError(`[znight] sqs(): waitTimeSeconds must be an integer between 0 and 20, got ${String(wait)}`)
    }
    const visibility = options.visibilityTimeout
    if (
      visibility !== undefined &&
      !(Number.isInteger(visibility) && visibility >= 0 && visibility <= MAX_VISIBILITY_SECONDS)
    ) {
      throw new TypeError('[znight] sqs(): visibilityTimeout must be an integer number of seconds (0–43200)')
    }
    this.#options = options
    this.capabilities = Object.freeze({
      nativeDelay: true,
      maxNativeDelayMs: MAX_VISIBILITY_SECONDS * 1000,
      maxInProcessDelayMs: durationOption(options.maxInProcessDelayMs, 1000, 'sqs maxInProcessDelayMs'),
      deliveryCount: 'native',
      maxPublishDelayMs: MAX_DELAY_SECONDS * 1000,
    })
  }

  /** The SQS client (available once connected). */
  get client(): SQSClient | undefined {
    return this.#client
  }

  async connect(context: DriverContext): Promise<void> {
    await Promise.resolve()
    this.#logger = context.logger
    if (this.#closed) throw brokerUnavailableError('SQS: the driver is closed, create a new one')
    if (this.#client !== undefined) return
    if (this.#options.client === undefined) {
      this.#client = new SQSClient(this.#options.clientConfig ?? {})
      this.#ownsClient = true
    } else {
      this.#client = this.#options.client
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const subscriptions = [...this.#subscriptions]
    this.#subscriptions.clear()
    for (const subscription of subscriptions) this.#stopPolling(subscription)
    await Promise.allSettled(subscriptions.map(subscription => subscription.loop))
    if (this.#ownsClient) this.#client?.destroy()
    this.#client = undefined
  }

  deadLetterName(queue: string): string {
    if (this.#options.deadLetterName !== undefined) return this.#options.deadLetterName(queue)
    const name = queueName(queue)
    return name.endsWith('.fifo') ? `${name.slice(0, -5)}-dlq.fifo` : `${name}-dlq`
  }

  #sqs(action: string): SQSClient {
    const client = this.#client
    if (client === undefined) {
      throw brokerUnavailableError(
        this.#closed ? `SQS: cannot ${action}, the driver is closed` : `SQS: cannot ${action} before connect()`,
      )
    }
    return client
  }

  /** Resolves (and caches) the URL of a queue name or URL. */
  #queue(queue: string): Promise<QueueInfo> {
    let info = this.#queues.get(queue)
    if (info === undefined) {
      info = this.#resolveQueue(queue)
      this.#queues.set(queue, info)
      info.catch(() => this.#queues.delete(queue))
    }
    return info
  }

  async #resolveQueue(queue: string): Promise<QueueInfo> {
    const name = queueName(queue)
    const configured = this.#options.queueUrls?.[queue]
    if (configured !== undefined) return { name, url: configured, fifo: name.endsWith('.fifo') }
    if (/^https?:\/\//.test(queue)) return { name, url: queue, fifo: name.endsWith('.fifo') }
    try {
      const result = await this.#sqs(`resolve the queue "${queue}"`).send(new GetQueueUrlCommand({ QueueName: queue }))
      if (result.QueueUrl === undefined) throw new Error('no QueueUrl in the response')
      return { name, url: result.QueueUrl, fifo: name.endsWith('.fifo') }
    } catch (error) {
      throw consumerError(`SQS: queue "${queue}" not found (${errorMessage(error)})`, [
        'Create the queue, or map its URL with sqs({ queueUrls: { name: url } })',
      ])
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------------------------------------

  async publish(queue: string, message: OutboundMessage): Promise<void> {
    const info = await this.#queue(queue)
    const binary = typeof message.body !== 'string'
    const attributes: Record<string, string> = headerRecord()
    attributes[MessagingHeaders.Id] = message.id
    if (message.type !== undefined) attributes[MessagingHeaders.Type] = message.type
    attributes[MessagingHeaders.ContentType] = message.contentType
    if (binary) attributes[MessagingHeaders.Encoding] = 'base64'
    for (const [name, value] of Object.entries(message.headers)) {
      if (TRANSPORT_ATTRIBUTES.has(name)) continue
      attributes[name] = value
    }
    const input: SendMessageCommandInput = {
      QueueUrl: info.url,
      MessageBody: encodeBody(message.body),
      MessageAttributes: toAttributes(attributes, queue),
    }
    if (message.delayMs > 0) {
      if (info.fifo) throw new RangeError(`[znight] SQS FIFO queue "${queue}" does not support per-message delays`)
      input.DelaySeconds = Math.min(MAX_DELAY_SECONDS, Math.ceil(message.delayMs / 1000))
    }
    if (info.fifo) {
      input.MessageGroupId = message.key ?? 'default'
      input.MessageDeduplicationId = message.id
    }
    await this.#sqs(`publish to "${queue}"`).send(new SendMessageCommand(input))
  }

  // -----------------------------------------------------------------------------------------------
  // Consuming
  // -----------------------------------------------------------------------------------------------

  async subscribe(queue: string, handler: DeliveryHandler, options: SubscribeOptions): Promise<Subscription> {
    const info = await this.#queue(queue)
    const client = this.#sqs(`subscribe to "${queue}"`)
    const { Attributes: attributes = {} } = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: info.url, AttributeNames: ['VisibilityTimeout', 'RedrivePolicy'] }),
    )
    const visibilityTimeout = this.#options.visibilityTimeout ?? (Number(attributes.VisibilityTimeout) || 30)
    const redrive = parseRedrivePolicy(attributes.RedrivePolicy)
    if (redrive !== undefined && redrive.maxReceiveCount < options.maxAttempts) {
      throw consumerError(
        `SQS: queue "${queue}" moves messages to its dead-letter queue after ${redrive.maxReceiveCount} receive(s), but ${options.consumer} allows ${options.maxAttempts} attempt(s)`,
        [
          `Raise the RedrivePolicy maxReceiveCount of "${queue}" to at least ${options.maxAttempts}`,
          'Or lower the @Retry attempts',
        ],
      )
    }
    let deadLetter: QueueInfo | undefined
    let dlqName = options.deadLetterQueue
    if (dlqName !== undefined && redrive !== undefined) {
      const target = queueName(redrive.deadLetterTargetArn)
      if (dlqName === this.deadLetterName(queue)) dlqName = target
      else if (dlqName !== target) {
        this.#logger.warn(
          `SQS: ${options.consumer} dead-letters to "${dlqName}" but the RedrivePolicy of "${queue}" targets "${target}"`,
        )
      }
    }
    if (dlqName !== undefined) deadLetter = await this.#queue(dlqName)

    const subscription: SqsSubscription = {
      queue: info,
      handler,
      options,
      deadLetter,
      visibilityTimeout,
      abort: new AbortController(),
      groups: new Map(),
      inflight: 0,
      active: true,
      wake: undefined,
      loop: undefined,
    }
    this.#subscriptions.add(subscription)
    subscription.loop = this.#poll(subscription)
    return {
      cancel: async (): Promise<void> => {
        this.#stopPolling(subscription)
        await subscription.loop
      },
      close: async (): Promise<void> => {
        this.#stopPolling(subscription)
        this.#subscriptions.delete(subscription)
        await subscription.loop
      },
    }
  }

  #stopPolling(subscription: SqsSubscription): void {
    subscription.active = false
    subscription.abort.abort()
    subscription.wake?.()
  }

  async #poll(subscription: SqsSubscription): Promise<void> {
    const { queue, options } = subscription
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
      try {
        const result = await this.#sqs(`receive from "${queue.name}"`).send(
          new ReceiveMessageCommand({
            QueueUrl: queue.url,
            MaxNumberOfMessages: Math.min(10, free),
            WaitTimeSeconds: this.#options.waitTimeSeconds ?? 20,
            VisibilityTimeout: subscription.visibilityTimeout,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: signal },
        )
        errorDelay = 500
        for (const message of result.Messages ?? []) {
          if (subscription.active) this.#deliver(subscription, message)
          // stopped while receiving: the message becomes visible again after its visibility timeout
        }
      } catch (error) {
        if (!subscription.active) break
        this.#logger.warn(`SQS: receiving from "${queue.name}" failed, retrying in ${errorDelay} ms`, { err: error })
        try {
          await sleep(errorDelay, signal)
        } catch {
          break
        }
        errorDelay = Math.min(errorDelay * 2, 30_000)
      }
    }
  }

  #deliver(subscription: SqsSubscription, message: Message): void {
    const { queue } = subscription
    const client = this.#sqs('handle a message')
    const receiptHandle = message.ReceiptHandle as string
    const attributes = message.MessageAttributes ?? {}
    const transport = headerRecord()
    const headers = headerRecord()
    for (const [name, attribute] of Object.entries(attributes)) {
      const value = attributeToString(attribute)
      if (value === undefined) continue
      if (TRANSPORT_ATTRIBUTES.has(name)) transport[name] = value
      else headers[name] = value
    }
    const encoded = message.Body ?? ''
    const body = transport[MessagingHeaders.Encoding] === 'base64' ? Buffer.from(encoded, 'base64') : encoded
    const system = message.Attributes ?? {}
    const receiveCount = Number(system.ApproximateReceiveCount)
    const sentAt = Number(system.SentTimestamp)
    const id = transport[MessagingHeaders.Id] ?? message.MessageId ?? receiptHandle
    const groupId = system.MessageGroupId

    subscription.inflight++
    let lease: ReturnType<typeof setInterval> | undefined
    const extendEvery = Math.floor((subscription.visibilityTimeout * 1000) / 2)
    if ((this.#options.extendVisibility ?? true) && extendEvery >= 1000) {
      lease = setInterval(() => {
        client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queue.url,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: subscription.visibilityTimeout,
            }),
          )
          .catch((error: unknown) => {
            this.#logger.warn(`SQS: failed to extend the visibility of message ${id}`, { err: error })
          })
      }, extendEvery)
    }
    let settled = false
    const check = (action: string): void => {
      if (settled) throw new Error(`[sqs] message ${id} was already settled (${action})`)
    }
    const done = (): void => {
      settled = true
      if (lease !== undefined) clearInterval(lease)
      lease = undefined
    }
    const changeVisibility = async (seconds: number): Promise<void> => {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue.url,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        }),
      )
    }
    const remove = async (): Promise<void> => {
      await client.send(new DeleteMessageCommand({ QueueUrl: queue.url, ReceiptHandle: receiptHandle }))
    }
    const delivery: DriverDelivery = {
      id,
      body,
      contentType: transport[MessagingHeaders.ContentType],
      headers,
      type: transport[MessagingHeaders.Type],
      key: groupId,
      attempt: Number.isSafeInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1,
      redelivered: receiveCount > 1,
      timestamp: Number.isFinite(sentAt) ? sentAt : undefined,
      raw: message,
      ack: async (): Promise<void> => {
        check('ack')
        await remove()
        done()
      },
      release: async (): Promise<void> => {
        check('release')
        await changeVisibility(0)
        done()
      },
      retry: async (request: RetryRequest): Promise<void> => {
        check('retry')
        await changeVisibility(Math.min(MAX_VISIBILITY_SECONDS, Math.ceil(request.delayMs / 1000)))
        done()
      },
      deadLetter: async (request: DeadLetterRequest): Promise<void> => {
        check('dead-letter')
        const target =
          request.queue === undefined ? undefined : (subscription.deadLetter ?? (await this.#queue(request.queue)))
        if (target !== undefined) {
          await client.send(
            new SendMessageCommand(
              this.#deadLetterInput(target, queue, encoded, transport, headers, request, groupId, id),
            ),
          )
        }
        await remove()
        done()
      },
    }
    // FIFO queues: messages of a group are handled one after the other, in order
    const serialKey = queue.fifo ? groupId : undefined
    const previous = serialKey === undefined ? undefined : subscription.groups.get(serialKey)
    const run = (): Promise<void> => subscription.handler(delivery)
    const handled = (previous === undefined ? run() : previous.then(run, run))
      .catch((error: unknown) => {
        this.#logger.error(`SQS: unexpected failure handling message ${id}`, { err: error })
      })
      .finally(() => {
        if (lease !== undefined) clearInterval(lease)
        subscription.inflight--
        if (serialKey !== undefined && subscription.groups.get(serialKey) === handled)
          subscription.groups.delete(serialKey)
        subscription.wake?.()
      })
    if (serialKey !== undefined) subscription.groups.set(serialKey, handled)
  }

  #deadLetterInput(
    target: QueueInfo,
    source: QueueInfo,
    body: string,
    transport: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>>,
    request: DeadLetterRequest,
    groupId: string | undefined,
    id: string,
  ): SendMessageCommandInput {
    const attributes = headerRecord()
    Object.assign(attributes, transport)
    attributes[MessagingHeaders.DeadLetterReason] = request.reason
    attributes[MessagingHeaders.Error] =
      truncate(errorMessage(request.error), MAX_ERROR_HEADER_LENGTH) || 'unknown error'
    attributes[MessagingHeaders.OriginalQueue] = source.name
    attributes[MessagingHeaders.Attempts] = String(request.attempt)
    const dropped: string[] = []
    for (const [name, value] of Object.entries(headers)) {
      if (Object.keys(attributes).length >= MAX_ATTRIBUTES) dropped.push(name)
      else attributes[name] = value
    }
    if (dropped.length > 0) {
      this.#logger.warn(
        `SQS: dead-letter copy of message ${id} exceeds ${MAX_ATTRIBUTES} attributes, dropped: ${dropped.join(', ')}`,
      )
    }
    const input: SendMessageCommandInput = {
      QueueUrl: target.url,
      MessageBody: body,
      MessageAttributes: toAttributes(attributes, target.name),
    }
    if (target.fifo) {
      input.MessageGroupId = groupId ?? 'default'
      input.MessageDeduplicationId = `${id}-dead-letter`.slice(0, 128)
    }
    return input
  }
}

/** Queue name of a name, URL or ARN (last segment). */
function queueName(queue: string): string {
  const segments = queue.split(/[/:]/)
  return segments[segments.length - 1] ?? queue
}

function encodeBody(body: Uint8Array | string): string {
  return typeof body === 'string' ? body : Buffer.from(bodyToBytes(body)).toString('base64')
}

function toAttributes(
  attributes: Readonly<Record<string, string>>,
  queue: string,
): Record<string, MessageAttributeValue> {
  const entries = Object.entries(attributes)
  if (entries.length > MAX_ATTRIBUTES) {
    throw new RangeError(
      `[znight] SQS messages carry at most ${MAX_ATTRIBUTES} attributes (Znight uses up to 4): too many headers for "${queue}"`,
    )
  }
  const result: Record<string, MessageAttributeValue> = {}
  for (const [name, value] of entries) {
    if (!ATTRIBUTE_NAME.test(name)) throw new TypeError(`[znight] "${name}" is not a valid SQS message attribute name`)
    if (value === '') throw new TypeError(`[znight] SQS message attributes cannot be empty (header "${name}")`)
    result[name] = { DataType: 'String', StringValue: value }
  }
  return result
}

function attributeToString(attribute: MessageAttributeValue): string | undefined {
  if (attribute.StringValue !== undefined) return attribute.StringValue
  if (attribute.BinaryValue !== undefined) return Buffer.from(attribute.BinaryValue).toString('base64')
  return undefined
}

function parseRedrivePolicy(
  value: string | undefined,
): { deadLetterTargetArn: string; maxReceiveCount: number } | undefined {
  if (value === undefined || value === '') return undefined
  try {
    const parsed = JSON.parse(value) as { deadLetterTargetArn?: unknown; maxReceiveCount?: unknown }
    const maxReceiveCount = Number(parsed.maxReceiveCount)
    if (typeof parsed.deadLetterTargetArn !== 'string' || !Number.isFinite(maxReceiveCount)) return undefined
    return { deadLetterTargetArn: parsed.deadLetterTargetArn, maxReceiveCount }
  } catch {
    return undefined
  }
}
