/**
 * An in-memory Pub/Sub implementing the RPCs of the generated clients that the driver uses
 * (`v1.PublisherClient`: publish, getTopic, createTopic, close; `v1.SubscriberClient`: pull,
 * acknowledge, modifyAckDeadline, getSubscription, createSubscription, close). Topics fan out to
 * their subscriptions, ack deadlines and dead-letter policies (`deliveryAttempt`, forwarding with the
 * `CloudPubSubDeadLetterSource*` attributes) behave like Pub/Sub. Every call is recorded.
 */
import type { protos, v1 } from '@google-cloud/pubsub'

type PubsubMessage = protos.google.pubsub.v1.IPubsubMessage
type ReceivedMessage = protos.google.pubsub.v1.IReceivedMessage
type SubscriptionResource = protos.google.pubsub.v1.ISubscription

export interface FakeCall {
  readonly method: string
  // biome-ignore lint/suspicious/noExplicitAny: requests of different RPCs
  readonly request: any
}

interface Stored {
  readonly message: PubsubMessage
  attempts: number
  ackId: string | undefined
  /** Epoch ms before which the message is not delivered again (lease or retry deadline). */
  availableAt: number
  acked: boolean
}

export interface FakeSubscription {
  readonly name: string
  readonly topic: string
  readonly ackDeadlineSeconds: number
  readonly deadLetterPolicy: { deadLetterTopic: string; maxDeliveryAttempts: number } | undefined
  readonly enableMessageOrdering: boolean
  readonly messages: Stored[]
}

/** A gRPC-like error with a status code. */
export function grpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(`${code} ${message}`), { code })
}

export const NOT_FOUND = 5
export const ALREADY_EXISTS = 6
export const PERMISSION_DENIED = 7

export class FakePubSub {
  readonly calls: FakeCall[] = []
  readonly topics = new Set<string>()
  readonly subscriptions = new Map<string, FakeSubscription>()
  /** Fails a call when it returns an error. */
  failures: (method: string, request: FakeCall['request']) => Error | undefined = () => undefined
  /** Latency of each call, in ms (default 0: answered on the next turns of the event loop). */
  latency: (method: string, request: FakeCall['request']) => number = () => 0
  /** Calls applied by the broker, in the order it applied them (after their latency). */
  readonly applied: FakeCall[] = []
  closed = { publisher: false, subscriber: false }
  #ids = 0
  #ackIds = 0

  constructor(readonly project = 'test-project') {}

  topicPath(name: string): string {
    return name.startsWith('projects/') ? name : `projects/${this.project}/topics/${name}`
  }

  subscriptionPath(name: string): string {
    return name.startsWith('projects/') ? name : `projects/${this.project}/subscriptions/${name}`
  }

  createTopic(name: string): void {
    this.topics.add(this.topicPath(name))
  }

  createSubscription(
    name: string,
    topic: string,
    settings: Partial<Pick<FakeSubscription, 'ackDeadlineSeconds' | 'deadLetterPolicy' | 'enableMessageOrdering'>> = {},
  ): FakeSubscription {
    const subscription: FakeSubscription = {
      name: this.subscriptionPath(name),
      topic: this.topicPath(topic),
      ackDeadlineSeconds: settings.ackDeadlineSeconds ?? 10,
      deadLetterPolicy:
        settings.deadLetterPolicy === undefined
          ? undefined
          : {
              ...settings.deadLetterPolicy,
              deadLetterTopic: this.topicPath(settings.deadLetterPolicy.deadLetterTopic),
            },
      enableMessageOrdering: settings.enableMessageOrdering ?? false,
      messages: [],
    }
    this.subscriptions.set(subscription.name, subscription)
    return subscription
  }

  /** A topic and a subscription of the same name (and the `-dlq` pair when `deadLetter`). */
  createQueue(name: string, deadLetter = true): void {
    this.createTopic(name)
    this.createSubscription(name, name)
    if (deadLetter) {
      this.createTopic(`${name}-dlq`)
      this.createSubscription(`${name}-dlq`, `${name}-dlq`)
    }
  }

  /** Messages of a subscription not acknowledged yet. */
  pending(subscription: string): PubsubMessage[] {
    return (this.subscriptions.get(this.subscriptionPath(subscription))?.messages ?? [])
      .filter(stored => !stored.acked)
      .map(stored => stored.message)
  }

  /** Every message published to a subscription (acknowledged or not). */
  received(subscription: string): PubsubMessage[] {
    return (this.subscriptions.get(this.subscriptionPath(subscription))?.messages ?? []).map(stored => stored.message)
  }

  callsOf(method: string): FakeCall['request'][] {
    return this.calls.filter(call => call.method === method).map(call => call.request)
  }

  #store(topic: string, message: PubsubMessage): string {
    const messageId = String(++this.#ids)
    const now = Date.now()
    const stored: PubsubMessage = {
      ...message,
      messageId,
      publishTime: { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1_000_000 },
    }
    for (const subscription of this.subscriptions.values()) {
      if (subscription.topic !== topic) continue
      subscription.messages.push({ message: stored, attempts: 0, ackId: undefined, availableAt: 0, acked: false })
    }
    return messageId
  }

  async #call<T>(method: string, request: FakeCall['request'], apply: () => T): Promise<T> {
    const call = { method, request }
    this.calls.push(call)
    const delay = this.latency(method, request)
    await (delay > 0 ? new Promise(resolve => setTimeout(resolve, delay)) : Promise.resolve())
    const failure = this.failures(method, request)
    if (failure !== undefined) throw failure
    this.applied.push(call)
    return apply()
  }

  #subscription(name: string): FakeSubscription {
    const subscription = this.subscriptions.get(name)
    if (subscription === undefined) throw grpcError(NOT_FOUND, `Subscription does not exist (${name})`)
    return subscription
  }

  #deliverable(subscription: FakeSubscription, max: number): ReceivedMessage[] {
    const now = Date.now()
    const result: ReceivedMessage[] = []
    for (const stored of subscription.messages) {
      if (result.length >= max) break
      if (stored.acked || stored.availableAt > now) continue
      const policy = subscription.deadLetterPolicy
      if (policy !== undefined && stored.attempts >= policy.maxDeliveryAttempts) {
        stored.acked = true
        this.#store(policy.deadLetterTopic, {
          ...stored.message,
          attributes: {
            ...stored.message.attributes,
            CloudPubSubDeadLetterSourceDeliveryCount: String(stored.attempts),
            CloudPubSubDeadLetterSourceSubscription: subscription.name.split('/').pop() ?? '',
          },
        })
        continue
      }
      stored.attempts++
      stored.ackId = `ack-${++this.#ackIds}`
      stored.availableAt = now + subscription.ackDeadlineSeconds * 1000
      result.push({
        ackId: stored.ackId,
        message: stored.message,
        deliveryAttempt: policy === undefined ? 0 : stored.attempts,
      })
    }
    return result
  }

  #byAckId(subscription: FakeSubscription, ackIds: readonly string[]): Stored[] {
    return subscription.messages.filter(stored => stored.ackId !== undefined && ackIds.includes(stored.ackId))
  }

  readonly publisher: v1.PublisherClient = {
    publish: (request: { topic: string; messages: PubsubMessage[] }) =>
      this.#call('publish', request, () => {
        if (!this.topics.has(request.topic)) throw grpcError(NOT_FOUND, `Topic not found (${request.topic})`)
        return [{ messageIds: request.messages.map(message => this.#store(request.topic, message)) }]
      }),
    getTopic: (request: { topic: string }) =>
      this.#call('getTopic', request, () => {
        if (!this.topics.has(request.topic)) throw grpcError(NOT_FOUND, `Topic not found (${request.topic})`)
        return [{ name: request.topic }]
      }),
    createTopic: (request: { name: string }) =>
      this.#call('createTopic', request, () => {
        if (this.topics.has(request.name)) throw grpcError(ALREADY_EXISTS, `Topic already exists (${request.name})`)
        this.topics.add(request.name)
        return [{ name: request.name }]
      }),
    close: () => {
      this.closed.publisher = true
      return Promise.resolve()
    },
  } as unknown as v1.PublisherClient

  readonly subscriber: v1.SubscriberClient = {
    pull: async (request: { subscription: string; maxMessages: number }, options?: { timeout?: number }) => {
      const deadline = Date.now() + (options?.timeout ?? 30_000)
      return await this.#call('pull', request, async () => {
        const subscription = this.#subscription(request.subscription)
        for (;;) {
          const messages = this.#deliverable(subscription, request.maxMessages)
          if (messages.length > 0 || Date.now() >= deadline) return [{ receivedMessages: messages }]
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      })
    },
    acknowledge: (request: { subscription: string; ackIds: string[] }) =>
      this.#call('acknowledge', request, () => {
        for (const stored of this.#byAckId(this.#subscription(request.subscription), request.ackIds)) {
          stored.acked = true
        }
        return [{}]
      }),
    modifyAckDeadline: (request: { subscription: string; ackIds: string[]; ackDeadlineSeconds: number }) =>
      this.#call('modifyAckDeadline', request, () => {
        for (const stored of this.#byAckId(this.#subscription(request.subscription), request.ackIds)) {
          stored.availableAt = Date.now() + request.ackDeadlineSeconds * 1000
        }
        return [{}]
      }),
    getSubscription: (request: { subscription: string }) =>
      this.#call('getSubscription', request, () => {
        const subscription = this.#subscription(request.subscription)
        const resource: SubscriptionResource = {
          name: subscription.name,
          topic: subscription.topic,
          ackDeadlineSeconds: subscription.ackDeadlineSeconds,
          enableMessageOrdering: subscription.enableMessageOrdering,
          deadLetterPolicy: subscription.deadLetterPolicy ?? null,
        }
        return [resource]
      }),
    createSubscription: (request: { name: string; topic: string; ackDeadlineSeconds?: number }) =>
      this.#call('createSubscription', request, () => {
        if (!this.topics.has(request.topic)) throw grpcError(NOT_FOUND, `Topic not found (${request.topic})`)
        if (this.subscriptions.has(request.name)) {
          throw grpcError(ALREADY_EXISTS, `Subscription already exists (${request.name})`)
        }
        const subscription: FakeSubscription = {
          name: request.name,
          topic: request.topic,
          ackDeadlineSeconds: request.ackDeadlineSeconds ?? 10,
          deadLetterPolicy: undefined,
          enableMessageOrdering: false,
          messages: [],
        }
        this.subscriptions.set(request.name, subscription)
        return [{ name: request.name }]
      }),
    close: () => {
      this.closed.subscriber = true
      return Promise.resolve()
    },
  } as unknown as v1.SubscriberClient
}
