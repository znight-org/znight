/**
 * An in-memory NATS JetStream implementing what the driver uses: the connection (`flush`, `subscribe`
 * with queue groups, `drain`, `close`), the JetStream context (`publish` with `msgID` deduplication,
 * `consumers.getConsumerFromInfo`, `jetstreamManager`) and the manager (`streams.find` / `info` /
 * `add` / `getMessage`, `consumers.info` / `add`). Durable pull consumers keep a delivery state per
 * stream sequence like JetStream: ack wait, `nak(delay)`, `term()`, `working()`, delivery counts,
 * `max_deliver` with its advisory. Every call is recorded.
 */
import type {
  ConsumerConfig,
  ConsumerInfo,
  JetStreamClient,
  JetStreamPublishOptions,
  JsMsg,
  StoredMsg,
  StreamConfig,
  StreamInfo,
} from '@nats-io/jetstream'
import type { Msg, MsgHdrs, NatsConnection } from '@nats-io/transport-node'

import { headers as natsHeaders } from '@nats-io/transport-node'

export interface FakeCall {
  readonly method: string
  // biome-ignore lint/suspicious/noExplicitAny: arguments of different calls
  readonly args: any
}

export interface FakeStoredMessage {
  readonly seq: number
  readonly subject: string
  readonly data: Uint8Array
  readonly headers: MsgHdrs | undefined
  readonly time: number
}

export interface FakeStream {
  readonly config: StreamConfig
  readonly messages: FakeStoredMessage[]
  readonly msgIds: Set<string>
}

/** Delivery state of a stream message for a consumer. */
export interface DeliveryState {
  deliveries: number
  /** Epoch ms before which the message is not delivered (again). */
  availableAt: number
  /** Delivery number of the outstanding delivery (0: none), so that stale settlements are ignored. */
  outstanding: number
  done: 'ack' | 'term' | 'exhausted' | undefined
}

export interface FakeConsumer {
  readonly stream: string
  readonly config: ConsumerConfig
  readonly states: Map<number, DeliveryState>
}

/** A JetStream API error (`code` is the JetStream error code, `status` the HTTP-like status). */
export function apiError(code: number, description: string): Error {
  return Object.assign(new Error(description), { name: 'JetStreamApiError', code, status: 404 })
}

export const STREAM_NOT_FOUND = 10059
export const CONSUMER_NOT_FOUND = 10014

/** Whether `subject` matches the NATS subject `filter` (`*` one token, `>` the rest). */
export function subjectMatches(filter: string, subject: string): boolean {
  const filterTokens = filter.split('.')
  const tokens = subject.split('.')
  for (const [index, token] of filterTokens.entries()) {
    if (token === '>') return tokens.length > index
    if (index >= tokens.length) return false
    if (token !== '*' && token !== tokens[index]) return false
  }
  return filterTokens.length === tokens.length
}

const NANOS_PER_MS = 1_000_000

interface FakeSubscriber {
  readonly subject: string
  readonly queue: string | undefined
  readonly callback: (error: Error | null, message: Msg) => void
  closed: boolean
}

export class FakeNats {
  readonly calls: FakeCall[] = []
  readonly streams = new Map<string, FakeStream>()
  readonly consumers = new Map<string, FakeConsumer>()
  /** Fails a call when it returns an error. */
  failures: (method: string, args: FakeCall['args']) => Error | undefined = () => undefined
  /** `jetstreamManager()` fails with this error (JetStream disabled...). */
  managerError: Error | undefined
  readonly subscribers: FakeSubscriber[] = []
  closed = false
  drained = false
  #time = 0

  /** Creates a stream (`subjects` default: its name). */
  createStream(name: string, subjects: readonly string[] = [name]): FakeStream {
    const stream: FakeStream = {
      config: { name, subjects: [...subjects] } as StreamConfig,
      messages: [],
      msgIds: new Set(),
    }
    this.streams.set(name, stream)
    return stream
  }

  /** Creates a durable consumer. */
  createConsumer(stream: string, config: Partial<ConsumerConfig> & { durable_name: string }): FakeConsumer {
    const consumer: FakeConsumer = {
      stream,
      config: {
        ack_policy: 'explicit',
        ack_wait: 30_000 * NANOS_PER_MS,
        max_deliver: -1,
        deliver_policy: 'all',
        ...config,
      } as ConsumerConfig,
      states: new Map(),
    }
    this.consumers.set(`${stream}/${config.durable_name}`, consumer)
    return consumer
  }

  consumer(stream: string, durable: string): FakeConsumer | undefined {
    return this.consumers.get(`${stream}/${durable}`)
  }

  /** Messages of a stream. */
  messages(stream: string): FakeStoredMessage[] {
    return this.streams.get(stream)?.messages ?? []
  }

  /** Header record of a stored message. */
  static headersOf(message: { readonly headers: MsgHdrs | undefined }): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [name, values] of message.headers ?? []) result[name] = values[0] ?? ''
    return result
  }

  callsOf(method: string): FakeCall['args'][] {
    return this.calls.filter(call => call.method === method).map(call => call.args)
  }

  /** The stream capturing `subject`, if exactly one does. */
  streamOf(subject: string): FakeStream | undefined {
    const matching = [...this.streams.values()].filter(stream =>
      (stream.config.subjects ?? []).some(filter => subjectMatches(filter, subject)),
    )
    return matching.length === 1 ? matching[0] : undefined
  }

  /** Publishes a `MAX_DELIVERIES` advisory, as JetStream does once a message exhausted `max_deliver`. */
  advisory(stream: string, consumer: string, seq: number, deliveries: number): void {
    const subject = `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.${consumer}`
    const payload = {
      type: 'io.nats.jetstream.advisory.v1.max_deliver',
      id: `advisory-${seq}`,
      timestamp: new Date().toISOString(),
      stream,
      consumer,
      stream_seq: seq,
      deliveries,
    }
    this.#emit(subject, new TextEncoder().encode(JSON.stringify(payload)))
  }

  #record(method: string, args: FakeCall['args']): void {
    this.calls.push({ method, args })
    const failure = this.failures(method, args)
    if (failure !== undefined) throw failure
  }

  async #call<T>(method: string, args: FakeCall['args'], apply: () => T): Promise<T> {
    await Promise.resolve()
    this.#record(method, args)
    return apply()
  }

  #emit(subject: string, data: Uint8Array): void {
    const groups = new Set<string>()
    for (const subscriber of this.subscribers) {
      if (subscriber.closed || !subjectMatches(subscriber.subject, subject)) continue
      if (subscriber.queue !== undefined) {
        if (groups.has(subscriber.queue)) continue
        groups.add(subscriber.queue)
      }
      const message = { subject, data, headers: undefined, json: () => JSON.parse(new TextDecoder().decode(data)) }
      queueMicrotask(() => subscriber.callback(null, message as unknown as Msg))
    }
  }

  #stream(name: string): FakeStream {
    const stream = this.streams.get(name)
    if (stream === undefined) throw apiError(STREAM_NOT_FOUND, 'stream not found')
    return stream
  }

  #streamInfo(stream: FakeStream): StreamInfo {
    return {
      config: stream.config,
      created: new Date(0).toISOString(),
      state: { messages: stream.messages.length },
    } as unknown as StreamInfo
  }

  #consumerInfo(consumer: FakeConsumer): ConsumerInfo {
    return {
      stream_name: consumer.stream,
      name: consumer.config.durable_name,
      config: consumer.config,
      created: new Date(0).toISOString(),
    } as unknown as ConsumerInfo
  }

  #store(stream: FakeStream, subject: string, data: Uint8Array, options: Partial<JetStreamPublishOptions>): number {
    const stored = natsHeaders()
    for (const [name, values] of options.headers ?? []) for (const value of values) stored.append(name, value)
    if (options.msgID !== undefined) stored.set('Nats-Msg-Id', options.msgID)
    const seq = stream.messages.length + 1
    stream.messages.push({ seq, subject, data, headers: stored, time: Date.now() + this.#time++ })
    return seq
  }

  // ------------------------------------------------------------------------------------------------
  // the connection

  readonly connection: NatsConnection = {
    flush: () => this.#call('flush', undefined, () => undefined),
    subscribe: (subject: string, options: { queue?: string; callback: FakeSubscriber['callback'] }) => {
      this.#record('subscribe', { subject, queue: options.queue })
      const subscriber: FakeSubscriber = { subject, queue: options.queue, callback: options.callback, closed: false }
      this.subscribers.push(subscriber)
      return {
        unsubscribe: () => {
          subscriber.closed = true
        },
        getSubject: () => subject,
        isClosed: () => subscriber.closed,
      }
    },
    drain: () =>
      this.#call('drain', undefined, () => {
        this.drained = true
        this.closed = true
      }),
    close: () =>
      this.#call('close', undefined, () => {
        this.closed = true
      }),
    isClosed: () => this.closed,
  } as unknown as NatsConnection

  // ------------------------------------------------------------------------------------------------
  // the JetStream context and manager

  readonly manager = {
    streams: {
      find: (subject: string) =>
        this.#call('streams.find', subject, () => {
          const stream = this.streamOf(subject)
          if (stream === undefined) throw apiError(STREAM_NOT_FOUND, 'no stream matches subject')
          return stream.config.name
        }),
      info: (name: string) => this.#call('streams.info', name, () => this.#streamInfo(this.#stream(name))),
      add: (config: Partial<StreamConfig> & { name: string }) =>
        this.#call('streams.add', config, () => {
          if (this.streams.has(config.name)) throw apiError(10058, 'stream name already in use')
          const stream = this.createStream(config.name, config.subjects ?? [config.name])
          Object.assign(stream.config, config)
          return this.#streamInfo(stream)
        }),
      getMessage: (name: string, query: { seq: number }) =>
        this.#call('streams.getMessage', { stream: name, ...query }, () => {
          const message = this.#stream(name).messages.find(stored => stored.seq === query.seq)
          if (message === undefined) return null
          return {
            subject: message.subject,
            seq: message.seq,
            header: message.headers ?? natsHeaders(),
            data: message.data,
            time: new Date(message.time),
            timestamp: new Date(message.time).toISOString(),
          } as unknown as StoredMsg
        }),
    },
    consumers: {
      info: (stream: string, name: string) =>
        this.#call('consumers.info', { stream, name }, () => {
          this.#stream(stream)
          const consumer = this.consumer(stream, name)
          if (consumer === undefined) throw apiError(CONSUMER_NOT_FOUND, 'consumer not found')
          return this.#consumerInfo(consumer)
        }),
      add: (stream: string, config: Partial<ConsumerConfig> & { durable_name: string }) =>
        this.#call('consumers.add', { stream, config }, () => {
          this.#stream(stream)
          return this.#consumerInfo(this.consumer(stream, config.durable_name) ?? this.createConsumer(stream, config))
        }),
    },
  }

  readonly jetstream: JetStreamClient = {
    publish: (subject: string, data: Uint8Array, options: Partial<JetStreamPublishOptions> = {}) =>
      this.#call('publish', { subject, data, options }, () => {
        const stream = this.streamOf(subject)
        if (stream === undefined) {
          throw Object.assign(new Error('jetstream is not enabled'), { name: 'JetStreamNotEnabled' })
        }
        const name = stream.config.name
        if (options.msgID !== undefined && stream.msgIds.has(options.msgID)) {
          return { stream: name, seq: 0, duplicate: true }
        }
        if (options.msgID !== undefined) stream.msgIds.add(options.msgID)
        return { stream: name, seq: this.#store(stream, subject, data, options), duplicate: false }
      }),
    jetstreamManager: () =>
      this.#call('jetstreamManager', undefined, () => {
        if (this.managerError !== undefined) throw this.managerError
        return this.manager
      }),
    consumers: {
      getConsumerFromInfo: (info: ConsumerInfo) => {
        const consumer = this.consumer(info.stream_name, info.name)
        if (consumer === undefined) throw apiError(CONSUMER_NOT_FOUND, 'consumer not found')
        return { fetch: (options: { max_messages: number; expires: number }) => this.#fetch(consumer, options) }
      },
    },
  } as unknown as JetStreamClient

  // ------------------------------------------------------------------------------------------------
  // pull consumers

  #fetch(consumer: FakeConsumer, options: { max_messages: number; expires: number }) {
    this.#record('fetch', { stream: consumer.stream, durable: consumer.config.durable_name, ...options })
    let stopped = false
    const deadline = Date.now() + options.expires
    const deliverable = (): JsMsg | undefined => this.#next(consumer)
    async function* messages(): AsyncGenerator<JsMsg> {
      let count = 0
      while (!stopped && count < options.max_messages && Date.now() < deadline) {
        const message = deliverable()
        if (message === undefined) {
          await new Promise(resolve => setTimeout(resolve, 5))
          continue
        }
        count++
        yield message
      }
    }
    const iterator = messages()
    return Promise.resolve({
      [Symbol.asyncIterator]: () => iterator,
      stop: () => {
        stopped = true
      },
      close: () => {
        stopped = true
        return Promise.resolve()
      },
    })
  }

  /** The next message of `consumer` to deliver (marking it delivered), emitting max-deliver advisories. */
  #next(consumer: FakeConsumer): JsMsg | undefined {
    const stream = this.streams.get(consumer.stream)
    if (stream === undefined) return undefined
    const now = Date.now()
    const filter = consumer.config.filter_subject
    const ackWaitMs = Number(consumer.config.ack_wait) / NANOS_PER_MS
    const maxDeliver = consumer.config.max_deliver ?? -1
    for (const stored of stream.messages) {
      if (filter !== undefined && filter !== '' && !subjectMatches(filter, stored.subject)) continue
      let state = consumer.states.get(stored.seq)
      if (state === undefined) {
        state = { deliveries: 0, availableAt: 0, outstanding: 0, done: undefined }
        consumer.states.set(stored.seq, state)
      }
      if (state.done !== undefined || state.availableAt > now) continue
      if (maxDeliver > 0 && state.deliveries >= maxDeliver) {
        state.done = 'exhausted'
        state.outstanding = 0
        this.advisory(consumer.stream, consumer.config.durable_name ?? '', stored.seq, state.deliveries)
        continue
      }
      state.deliveries++
      state.outstanding = state.deliveries
      state.availableAt = now + ackWaitMs
      return this.#message(consumer, stored, state, state.deliveries)
    }
    return undefined
  }

  #message(consumer: FakeConsumer, stored: FakeStoredMessage, state: DeliveryState, delivery: number): JsMsg {
    const durable = consumer.config.durable_name ?? ''
    const ackWaitMs = Number(consumer.config.ack_wait) / NANOS_PER_MS
    const label = { stream: consumer.stream, durable, seq: stored.seq, delivery }
    const current = (): boolean => state.outstanding === delivery && state.done === undefined
    const settle = (method: string, args: object, apply: () => void): void => {
      this.#record(method, { ...label, ...args })
      if (current()) apply()
    }
    return {
      seq: stored.seq,
      subject: stored.subject,
      data: stored.data,
      headers: stored.headers,
      redelivered: delivery > 1,
      time: new Date(stored.time),
      timestamp: new Date(stored.time).toISOString(),
      timestampNanos: BigInt(stored.time) * BigInt(NANOS_PER_MS),
      sid: 1,
      info: {
        domain: '',
        stream: consumer.stream,
        consumer: durable,
        deliveryCount: delivery,
        streamSequence: stored.seq,
        deliverySequence: delivery,
        timestampNanos: stored.time * NANOS_PER_MS,
        pending: 0,
        redelivered: delivery > 1,
      },
      ack: () =>
        settle('ack', {}, () => {
          state.done = 'ack'
        }),
      ackAck: async () => {
        await Promise.resolve()
        settle('ackAck', {}, () => {
          state.done = 'ack'
        })
        return true
      },
      nak: (millis?: number) =>
        settle('nak', { millis }, () => {
          state.outstanding = 0
          state.availableAt = Date.now() + (millis ?? 0)
        }),
      term: (reason?: string) =>
        settle('term', { reason }, () => {
          state.done = 'term'
        }),
      working: () =>
        settle('working', {}, () => {
          state.availableAt = Date.now() + ackWaitMs
        }),
      next: () => undefined,
      json: <T>() => JSON.parse(new TextDecoder().decode(stored.data)) as T,
      string: () => new TextDecoder().decode(stored.data),
    }
  }
}
