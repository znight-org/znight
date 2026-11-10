/**
 * An in-memory Azure Service Bus namespace implementing what the driver uses of `@azure/service-bus`:
 * `ServiceBusClient` (createSender, createReceiver, close), senders (sendMessages, scheduleMessages,
 * close), peek-lock receivers (receiveMessages, completeMessage, abandonMessage, deadLetterMessage,
 * peekMessages, close; dead-letter sub-queues) and `ServiceBusAdministrationClient` (getQueue,
 * getTopic, getSubscription, createQueue, createTopic, createSubscription). Topics fan out to their
 * subscriptions, `deliveryCount` is 0-based like the JS SDK reports it, and abandoning a message
 * after `maxDeliveryCount` deliveries moves it to the dead-letter sub-queue. Every call is recorded.
 */
import type {
  ServiceBusAdministrationClient,
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusReceiverOptions,
  ServiceBusSender,
} from '@azure/service-bus'

import { ServiceBusError } from '@azure/service-bus'

type Properties = Record<string, number | boolean | string | Date | null>

export interface FakeCall {
  readonly method: string
  readonly entity: string
  // biome-ignore lint/suspicious/noExplicitAny: arguments of different methods
  readonly args: readonly any[]
}

interface Stored {
  readonly sequenceNumber: number
  readonly message: ServiceBusMessage
  applicationProperties: Properties
  deliveryCount: number
  enqueuedAt: number
  /** Epoch ms before which the message is not delivered (scheduled or locked). */
  availableAt: number
  lockToken: string | undefined
}

export interface FakeEntitySettings {
  readonly maxDeliveryCount?: number
  readonly requiresSession?: boolean
  readonly lockDurationMs?: number
}

export interface FakeEntity {
  /** `queue` or `topic/subscription`. */
  readonly path: string
  readonly maxDeliveryCount: number
  readonly requiresSession: boolean
  readonly lockDurationMs: number
  readonly active: Stored[]
  readonly deadLetter: Stored[]
}

/** The error the SDK throws for a missing entity on an AMQP operation. */
export function entityNotFound(path: string): ServiceBusError {
  return new ServiceBusError(`The messaging entity '${path}' could not be found.`, 'MessagingEntityNotFound')
}

/** The error the administration client throws for a missing entity. */
export function restNotFound(path: string): Error {
  return Object.assign(new Error(`Entity '${path}' was not found`), {
    name: 'RestError',
    code: 'MessageEntityNotFoundError',
    statusCode: 404,
  })
}

/** The error the administration client throws without the Manage right. */
export function restUnauthorized(): Error {
  return Object.assign(new Error('Unauthorized access. Manage claim is required.'), {
    name: 'RestError',
    code: 'UnauthorizedRequestError',
    statusCode: 401,
  })
}

export class FakeServiceBus {
  readonly calls: FakeCall[] = []
  readonly entities = new Map<string, FakeEntity>()
  /** Subscriptions of each topic. */
  readonly topics = new Map<string, Set<string>>()
  /** Fails a call when it returns an error. */
  failures: (method: string, entity: string) => Error | undefined = () => undefined
  closed = { client: false, senders: 0, receivers: 0 }
  #sequence = 0
  #tokens = 0

  createQueue(name: string, settings: FakeEntitySettings = {}): FakeEntity {
    return this.#entity(name, settings)
  }

  createTopic(name: string): void {
    if (!this.topics.has(name)) this.topics.set(name, new Set())
  }

  createSubscription(topic: string, subscription: string, settings: FakeEntitySettings = {}): FakeEntity {
    this.createTopic(topic)
    this.topics.get(topic)?.add(subscription)
    return this.#entity(`${topic}/${subscription}`, settings)
  }

  #entity(path: string, settings: FakeEntitySettings): FakeEntity {
    const entity: FakeEntity = {
      path,
      maxDeliveryCount: settings.maxDeliveryCount ?? 10,
      requiresSession: settings.requiresSession ?? false,
      lockDurationMs: settings.lockDurationMs ?? 60_000,
      active: [],
      deadLetter: [],
    }
    this.entities.set(path, entity)
    return entity
  }

  /** Messages of an entity (or of its dead-letter sub-queue) not settled yet. */
  pending(path: string, deadLetter = false): ServiceBusMessage[] {
    const entity = this.entities.get(path)
    return (deadLetter ? entity?.deadLetter : entity?.active)?.map(stored => this.#view(stored)) ?? []
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter(call => call.method === method)
  }

  #record(method: string, entity: string, args: readonly unknown[]): void {
    this.calls.push({ method, entity, args })
    const failure = this.failures(method, entity)
    if (failure !== undefined) throw failure
  }

  async #call(method: string, entity: string, args: readonly unknown[]): Promise<void> {
    this.#record(method, entity, args)
    await Promise.resolve()
  }

  #view(stored: Stored): ServiceBusMessage {
    return { ...stored.message, applicationProperties: { ...stored.applicationProperties } }
  }

  #store(path: string, message: ServiceBusMessage, availableAt: number): void {
    const targets = this.topics.has(path)
      ? [...(this.topics.get(path) ?? [])].map(subscription => `${path}/${subscription}`)
      : [path]
    if (!this.topics.has(path) && !this.entities.has(path)) throw entityNotFound(path)
    for (const target of targets) {
      const entity = this.entities.get(target)
      if (entity === undefined) continue
      if (entity.requiresSession && message.sessionId === undefined) {
        throw new ServiceBusError(`The SessionId was not set on a message sent to '${target}'`, 'GeneralError')
      }
      entity.active.push({
        sequenceNumber: ++this.#sequence,
        message: { ...message, body: Buffer.from(message.body as Uint8Array) },
        applicationProperties: { ...message.applicationProperties },
        deliveryCount: 0,
        enqueuedAt: Date.now(),
        availableAt,
        lockToken: undefined,
      })
    }
  }

  #receivedMessage(stored: Stored): ServiceBusReceivedMessage {
    return {
      ...stored.message,
      body: Buffer.from(stored.message.body as Uint8Array),
      applicationProperties: { ...stored.applicationProperties },
      deliveryCount: stored.deliveryCount,
      enqueuedTimeUtc: new Date(stored.enqueuedAt),
      lockToken: stored.lockToken,
      state: 'active',
      _rawAmqpMessage: { body: stored.message.body, bodyType: 'data' },
    } as ServiceBusReceivedMessage
  }

  #locked(entity: FakeEntity, deadLetter: boolean, message: ServiceBusReceivedMessage): Stored {
    const queue = deadLetter ? entity.deadLetter : entity.active
    const stored = queue.find(
      candidate => candidate.lockToken !== undefined && candidate.lockToken === message.lockToken,
    )
    if (stored === undefined) {
      throw new ServiceBusError(`The lock of message ${String(message.messageId)} was lost`, 'MessageLockLost')
    }
    return stored
  }

  #remove(entity: FakeEntity, deadLetter: boolean, stored: Stored): void {
    const queue = deadLetter ? entity.deadLetter : entity.active
    queue.splice(queue.indexOf(stored), 1)
  }

  #receiver(path: string, deadLetter: boolean, options: ServiceBusReceiverOptions): ServiceBusReceiver {
    const label = deadLetter ? `${path}/$deadletterqueue` : path
    const entityOf = (): FakeEntity => {
      const entity = this.entities.get(path)
      if (entity === undefined) throw entityNotFound(label)
      return entity
    }
    let closed = false
    const receiver = {
      entityPath: label,
      receiveMode: options.receiveMode ?? 'peekLock',
      identifier: `receiver-${label}`,
      options,
      get isClosed() {
        return closed
      },
      receiveMessages: async (max: number, receive: { maxWaitTimeInMs?: number; abortSignal?: AbortSignal } = {}) => {
        this.#record('receiveMessages', label, [max, receive])
        const entity = entityOf()
        if (entity.requiresSession) {
          throw new ServiceBusError(`'${label}' requires sessions: use a session receiver`, 'GeneralError')
        }
        const deadline = Date.now() + (receive.maxWaitTimeInMs ?? 60_000)
        for (;;) {
          if (receive.abortSignal?.aborted === true) {
            throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
          }
          const now = Date.now()
          const queue = deadLetter ? entity.deadLetter : entity.active
          const ready = queue.filter(stored => stored.availableAt <= now).slice(0, max)
          if (ready.length > 0 || now >= deadline) {
            return ready.map(stored => {
              if (stored.lockToken !== undefined) stored.deliveryCount++ // lock expired: redelivery
              stored.lockToken = `lock-${++this.#tokens}`
              stored.availableAt = now + entity.lockDurationMs
              return this.#receivedMessage(stored)
            })
          }
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      },
      peekMessages: async (max: number) => {
        await this.#call('peekMessages', label, [max])
        const entity = entityOf()
        return (deadLetter ? entity.deadLetter : entity.active)
          .slice(0, max)
          .map(stored => this.#receivedMessage(stored))
      },
      completeMessage: async (message: ServiceBusReceivedMessage) => {
        await this.#call('completeMessage', label, [message])
        const entity = entityOf()
        this.#remove(entity, deadLetter, this.#locked(entity, deadLetter, message))
      },
      abandonMessage: async (message: ServiceBusReceivedMessage, properties?: Properties) => {
        await this.#call('abandonMessage', label, [message, properties])
        const entity = entityOf()
        const stored = this.#locked(entity, deadLetter, message)
        Object.assign(stored.applicationProperties, properties)
        stored.lockToken = undefined
        stored.availableAt = 0
        if (!deadLetter && stored.deliveryCount + 1 >= entity.maxDeliveryCount) {
          this.#remove(entity, false, stored)
          stored.applicationProperties['DeadLetterReason'] = 'MaxDeliveryCountExceeded'
          stored.applicationProperties['DeadLetterErrorDescription'] =
            `Message could not be consumed after ${entity.maxDeliveryCount} delivery attempts.`
          entity.deadLetter.push(stored)
          return
        }
        stored.deliveryCount++
      },
      deadLetterMessage: async (message: ServiceBusReceivedMessage, settings: Properties = {}) => {
        await this.#call('deadLetterMessage', label, [message, settings])
        if (deadLetter) throw new ServiceBusError('Cannot dead-letter a dead-lettered message', 'GeneralError')
        const entity = entityOf()
        const stored = this.#locked(entity, false, message)
        this.#remove(entity, false, stored)
        const { deadLetterReason, deadLetterErrorDescription, ...properties } = settings
        stored.applicationProperties['DeadLetterReason'] = deadLetterReason ?? null
        stored.applicationProperties['DeadLetterErrorDescription'] = deadLetterErrorDescription ?? null
        for (const [name, value] of Object.entries(properties)) stored.applicationProperties[name] = value
        stored.lockToken = undefined
        stored.availableAt = 0
        entity.deadLetter.push(stored)
      },
      close: () => {
        closed = true
        this.closed.receivers++
        return Promise.resolve()
      },
    }
    return receiver as unknown as ServiceBusReceiver
  }

  readonly client: ServiceBusClient = {
    fullyQualifiedNamespace: 'fake.servicebus.windows.net',
    identifier: 'fake',
    createSender: (entity: string) => {
      this.#record('createSender', entity, [])
      return {
        entityPath: entity,
        sendMessages: async (messages: ServiceBusMessage | ServiceBusMessage[]) => {
          await this.#call('sendMessages', entity, [messages])
          for (const message of Array.isArray(messages) ? messages : [messages]) this.#store(entity, message, 0)
        },
        scheduleMessages: async (messages: ServiceBusMessage | ServiceBusMessage[], at: Date) => {
          await this.#call('scheduleMessages', entity, [messages, at])
          const list = Array.isArray(messages) ? messages : [messages]
          for (const message of list) this.#store(entity, message, at.getTime())
          return list.map(() => this.#sequence)
        },
        close: () => {
          this.closed.senders++
          return Promise.resolve()
        },
      } as unknown as ServiceBusSender
    },
    createReceiver: (
      entity: string,
      second?: string | ServiceBusReceiverOptions,
      third?: ServiceBusReceiverOptions,
    ) => {
      const subscription = typeof second === 'string' ? second : undefined
      const options = (typeof second === 'string' ? third : second) ?? {}
      const path = subscription === undefined ? entity : `${entity}/${subscription}`
      this.#record('createReceiver', path, [options])
      return this.#receiver(path, options.subQueueType === 'deadLetter', options)
    },
    close: () => {
      this.closed.client = true
      return Promise.resolve()
    },
  } as unknown as ServiceBusClient

  #properties(entity: FakeEntity, name: Record<string, string>) {
    return {
      ...name,
      maxDeliveryCount: entity.maxDeliveryCount,
      requiresSession: entity.requiresSession,
      lockDuration: `PT${Math.round(entity.lockDurationMs / 1000)}S`,
      _response: {},
    }
  }

  readonly admin: ServiceBusAdministrationClient = {
    getQueue: async (name: string) => {
      await this.#call('getQueue', name, [])
      const entity = this.entities.get(name)
      if (entity === undefined || name.includes('/')) throw restNotFound(name)
      return this.#properties(entity, { name })
    },
    getTopic: async (name: string) => {
      await this.#call('getTopic', name, [])
      if (!this.topics.has(name)) throw restNotFound(name)
      return { name, _response: {} }
    },
    getSubscription: async (topic: string, subscription: string) => {
      await this.#call('getSubscription', `${topic}/${subscription}`, [])
      const entity = this.entities.get(`${topic}/${subscription}`)
      if (entity === undefined) throw restNotFound(`${topic}/${subscription}`)
      return this.#properties(entity, { topicName: topic, subscriptionName: subscription })
    },
    createQueue: async (name: string, options: { maxDeliveryCount?: number } = {}) => {
      await this.#call('createQueue', name, [options])
      return this.#properties(
        this.createQueue(
          name,
          options.maxDeliveryCount === undefined ? {} : { maxDeliveryCount: options.maxDeliveryCount },
        ),
        { name },
      )
    },
    createTopic: async (name: string) => {
      await this.#call('createTopic', name, [])
      if (this.topics.has(name)) {
        throw Object.assign(new Error('conflict'), { code: 'MessageEntityAlreadyExistsError', statusCode: 409 })
      }
      this.createTopic(name)
      return { name, _response: {} }
    },
    createSubscription: async (topic: string, subscription: string, options: { maxDeliveryCount?: number } = {}) => {
      await this.#call('createSubscription', `${topic}/${subscription}`, [options])
      if (!this.topics.has(topic)) throw restNotFound(topic)
      return this.#properties(
        this.createSubscription(
          topic,
          subscription,
          options.maxDeliveryCount === undefined ? {} : { maxDeliveryCount: options.maxDeliveryCount },
        ),
        { topicName: topic, subscriptionName: subscription },
      )
    },
  } as unknown as ServiceBusAdministrationClient
}
