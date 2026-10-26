/**
 * An in-memory stand-in for amqplib's promise API, enough for the RabbitMQ driver: connections that
 * can be killed, channels (declarations, consumers, acknowledgements), confirm channels (publisher
 * confirms and `basic.return` of unroutable messages). Behaviour of the real broker that the tests
 * rely on is reproduced explicitly (a failed declaration closes its channel, channels close before
 * their connection...).
 */
import { EventEmitter } from 'node:events'

/** A consumer registered with `channel.consume()`. */
export interface FakeConsumer {
  readonly queue: string
  readonly tag: string
  readonly channel: FakeChannel
  readonly callback: (message: FakeMessage | null) => void
  cancelled: boolean
}

/** A publication made on a confirm channel. */
export interface FakePublication {
  readonly exchange: string
  readonly routingKey: string
  readonly content: Buffer
  readonly options: Record<string, unknown> & { headers?: Record<string, unknown> }
}

/** A message as amqplib hands it to consumers. */
export interface FakeMessage {
  readonly content: Buffer
  readonly fields: {
    readonly deliveryTag: number
    readonly redelivered: boolean
    readonly exchange: string
    readonly routingKey: string
    readonly consumerTag: string
  }
  readonly properties: Record<string, unknown> & { headers?: Record<string, unknown> }
}

/** State and hooks of the fake broker. */
export class FakeBroker {
  /** `serverProperties.version` of new connections. */
  version = '4.1.8'
  connects = 0
  /** Number of `connect()` calls that fail before one succeeds. */
  connectFailures = 0
  readonly models: FakeModel[] = []
  readonly consumers: FakeConsumer[] = []
  readonly publications: FakePublication[] = []
  /** Every `assertQueue` call, in order. */
  readonly declarations: { readonly name: string; readonly arguments: Record<string, unknown> }[] = []
  readonly exchanges: { readonly name: string; readonly type: string }[] = []
  readonly bindings: {
    readonly kind: 'queue' | 'exchange'
    readonly destination: string
    readonly source: string
    readonly pattern: string
  }[] = []
  /** Queues of the default exchange that do not exist (publications to them are returned). */
  readonly missingQueues = new Set<string>()
  /** Called by `createChannel()` before it resolves (may delay or fail it). */
  onCreateChannel: ((model: FakeModel) => Promise<void> | void) | undefined
  /** Error of an `assertQueue` call (the channel is then closed, like RabbitMQ does). */
  onAssertQueue: ((name: string, args: Record<string, unknown>) => Error | undefined) | undefined
  /** Delay of the confirmation of a routable publication (unroutable ones are returned and confirmed at once). */
  confirmDelayMs = 0
  #tags = 0

  reset(): void {
    this.version = '4.1.8'
    this.connects = 0
    this.connectFailures = 0
    this.models.length = 0
    this.consumers.length = 0
    this.publications.length = 0
    this.declarations.length = 0
    this.exchanges.length = 0
    this.bindings.length = 0
    this.missingQueues.clear()
    this.onCreateChannel = undefined
    this.onAssertQueue = undefined
    this.confirmDelayMs = 0
  }

  nextTag(): number {
    return ++this.#tags
  }

  /** Consumers of `queue` able to receive messages. */
  active(queue: string): FakeConsumer[] {
    return this.consumers.filter(
      consumer => consumer.queue === queue && !consumer.cancelled && !consumer.channel.closed,
    )
  }

  /** Delivers a message to the active consumer of `queue`; returns it. */
  deliver(
    queue: string,
    message: {
      readonly content?: string
      readonly exchange?: string
      readonly routingKey?: string
      readonly redelivered?: boolean
      readonly properties?: FakeMessage['properties']
    } = {},
  ): FakeMessage {
    const consumer = this.active(queue)[0]
    if (consumer === undefined) throw new Error(`[fake-amqplib] no active consumer of "${queue}"`)
    const delivered: FakeMessage = {
      content: Buffer.from(message.content ?? '{}'),
      fields: {
        deliveryTag: this.nextTag(),
        redelivered: message.redelivered ?? false,
        exchange: message.exchange ?? '',
        routingKey: message.routingKey ?? queue,
        consumerTag: consumer.tag,
      },
      properties: { contentType: 'application/json', headers: {}, ...message.properties },
    }
    consumer.callback(delivered)
    return delivered
  }

  /** The broker cancels the consumers of `queue` (`basic.cancel`: queue deleted...). */
  cancelConsumers(queue: string): void {
    for (const consumer of this.active(queue)) {
      consumer.cancelled = true
      consumer.callback(null)
    }
  }
}

export const fakeBroker: FakeBroker = new FakeBroker()

export class FakeChannel extends EventEmitter {
  closed = false
  readonly acks: FakeMessage[] = []
  readonly nacks: { readonly message: FakeMessage; readonly requeue: boolean }[] = []
  readonly model: FakeModel

  constructor(model: FakeModel) {
    super()
    this.model = model
  }

  get connection(): FakeModel['connection'] {
    return this.model.connection
  }

  protected check(): void {
    if (this.closed || this.model.closed) throw new Error('Channel closed')
  }

  /** Runs an RPC: rejects (asynchronously, like amqplib) when the channel is closed. */
  protected async rpc<T>(fn: () => T): Promise<T> {
    await Promise.resolve()
    this.check()
    return fn()
  }

  /** Closes the channel as the broker would after a channel error. */
  fail(error: Error): void {
    if (this.closed) return
    this.emit('error', error)
    this.closeNow()
  }

  closeNow(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  prefetch(_count: number): Promise<void> {
    return this.rpc(() => undefined)
  }

  assertQueue(name: string, options: { arguments?: Record<string, unknown> } = {}): Promise<{ queue: string }> {
    return this.rpc(() => {
      const args = { ...options.arguments }
      fakeBroker.declarations.push({ name, arguments: args })
      const error = fakeBroker.onAssertQueue?.(name, args)
      if (error !== undefined) {
        this.fail(error)
        throw error
      }
      return { queue: name }
    })
  }

  checkQueue(name: string): Promise<{ queue: string }> {
    return this.rpc(() => ({ queue: name }))
  }

  assertExchange(name: string, type: string): Promise<{ exchange: string }> {
    return this.rpc(() => {
      fakeBroker.exchanges.push({ name, type })
      return { exchange: name }
    })
  }

  bindQueue(queue: string, source: string, pattern: string): Promise<void> {
    return this.rpc(() => {
      fakeBroker.bindings.push({ kind: 'queue', destination: queue, source, pattern })
    })
  }

  bindExchange(destination: string, source: string, pattern: string): Promise<void> {
    return this.rpc(() => {
      fakeBroker.bindings.push({ kind: 'exchange', destination, source, pattern })
    })
  }

  consume(queue: string, callback: (message: FakeMessage | null) => void): Promise<{ consumerTag: string }> {
    return this.rpc(() => {
      const tag = `ctag-${fakeBroker.nextTag()}`
      fakeBroker.consumers.push({ queue, tag, channel: this, callback, cancelled: false })
      return { consumerTag: tag }
    })
  }

  cancel(tag: string): Promise<void> {
    return this.rpc(() => {
      for (const consumer of fakeBroker.consumers) if (consumer.tag === tag) consumer.cancelled = true
    })
  }

  async close(): Promise<void> {
    await Promise.resolve()
    if (this.closed) throw new Error('Channel already closed')
    this.closeNow()
  }

  ack(message: FakeMessage): void {
    this.check()
    this.acks.push(message)
  }

  nack(message: FakeMessage, _allUpTo: boolean, requeue: boolean): void {
    this.check()
    this.nacks.push({ message, requeue })
  }
}

export class FakeConfirmChannel extends FakeChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: FakePublication['options'],
    callback: (error: unknown) => void,
  ): boolean {
    this.check()
    fakeBroker.publications.push({ exchange, routingKey, content, options })
    if (exchange === '' && fakeBroker.missingQueues.has(routingKey)) {
      // unroutable with `mandatory`: basic.return, then the confirmation
      queueMicrotask(() => {
        this.emit('return', {
          content,
          fields: { exchange, routingKey, replyCode: 312, replyText: 'NO_ROUTE' },
          properties: options,
        })
        callback(null)
      })
      return true
    }
    setTimeout(() => callback(this.closed ? new Error('channel closed') : null), fakeBroker.confirmDelayMs)
    return true
  }

  sendToQueue(
    queue: string,
    content: Buffer,
    options: FakePublication['options'],
    callback: (error: unknown) => void,
  ): boolean {
    return this.publish('', queue, content, options, callback)
  }
}

export class FakeModel extends EventEmitter {
  closed = false
  readonly channels: FakeChannel[] = []
  readonly connection: { readonly serverProperties: { readonly version: string } }

  constructor(version: string) {
    super()
    this.connection = { serverProperties: { version } }
  }

  async createChannel(): Promise<FakeChannel> {
    await fakeBroker.onCreateChannel?.(this)
    if (this.closed) throw new Error('Connection closed')
    const channel = new FakeChannel(this)
    this.channels.push(channel)
    return channel
  }

  async createConfirmChannel(): Promise<FakeConfirmChannel> {
    await Promise.resolve()
    if (this.closed) throw new Error('Connection closed')
    const channel = new FakeConfirmChannel(this)
    this.channels.push(channel)
    return channel
  }

  close(): Promise<void> {
    this.kill()
    return Promise.resolve()
  }

  /** Loses the connection: its channels close first, then the connection (like amqplib). */
  kill(error?: Error): void {
    if (this.closed) return
    this.closed = true
    for (const channel of this.channels) channel.closeNow()
    this.emit('close', error)
  }
}

/** `amqplib.connect()`. */
export async function connect(): Promise<FakeModel> {
  await Promise.resolve()
  fakeBroker.connects++
  if (fakeBroker.connectFailures > 0) {
    fakeBroker.connectFailures--
    throw new Error('connect ECONNREFUSED')
  }
  const model = new FakeModel(fakeBroker.version)
  fakeBroker.models.push(model)
  return model
}
