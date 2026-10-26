import type { Plugin, PluginContext, PluginOptions } from '@znight/core'
import type { MessageCodec } from './codec.ts'
import type { MessagingDriver } from './driver.ts'
import type { RetryOptions } from './retry.ts'

import { resolveOptions } from '@znight/core'

import { DriverMessageBroker, type MessageBroker } from './broker.ts'
import { jsonCodec } from './codec.ts'
import { type ConsumerDefaults, defaultRetryPolicy, prepareConsumers } from './consumers.ts'
import { consumerError } from './errors.ts'
import { isPositiveInteger } from './internal/async.ts'
import { ConsumerRuntime, type ConsumerState } from './runtime.ts'
import { MessagingTokens } from './tokens.ts'

/** Defaults applied to every consumer (each `@Consumer` / `@Retry` may override them). */
export interface MessagingDefaults {
  /** Retry policy of handlers without `@Retry`. Default: 3 attempts, exponential from 1 s up to 30 s. `false`: no retry. */
  readonly retry?: RetryOptions | false
  /** Concurrency of consumers without `concurrency` option. Default: 1. */
  readonly concurrency?: number
  /**
   * Dead-letter destination of a queue, or `false` to disable dead-lettering (messages are then
   * rejected natively or discarded). Default: the driver naming (`orders.dlq`, SQS `orders-dlq`).
   */
  readonly deadLetter?: ((queue: string) => string) | false
  /**
   * Pause, in milliseconds, before releasing a message whose settlement failed (dead-letter queue
   * unavailable...), to avoid hot redelivery loops. Default: 1000.
   */
  readonly requeueDelay?: number
}

/** Options of {@link MessagingPlugin.configure}. */
export interface MessagingPluginOptions {
  /** The broker driver: `rabbitmq()`, `sqs()`, `kafka()` or `memory()` (from the matching subpath). */
  readonly driver: MessagingDriver
  readonly defaults?: MessagingDefaults
  /** Payload encoding. Default: {@link jsonCodec}. */
  readonly codec?: MessageCodec
  /** Subscribe the consumers on start. `false` for publish-only processes. Default: `true`. */
  readonly consume?: boolean
}

/** Runtime status of a consumer. */
export interface ConsumerStatus {
  /** Display name of the consumer class. */
  readonly consumer: string
  readonly queue: string
  readonly state: ConsumerState
  readonly concurrency: number
  readonly inFlight: number
  readonly deadLetterQueue: string | undefined
}

/** The plugin returned by {@link MessagingPlugin.configure}. */
export interface MessagingPluginInstance extends Plugin {
  readonly name: 'messaging'
  /** The broker (also injectable as `MessageBroker`). */
  readonly broker: MessageBroker
  /** The driver, once the plugin is bootstrapped. */
  readonly driver: MessagingDriver | undefined
  /** Status of every consumer, once the plugin is bootstrapped. */
  consumers(): ConsumerStatus[]
}

const DEFAULT_REQUEUE_DELAY_MS = 1000

/**
 * Message consumers and publishing.
 *
 * ```ts
 * import { MessagingPlugin } from '@znight/messaging'
 * import { rabbitmq } from '@znight/messaging/rabbitmq'
 *
 * const app = await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [MessagingPlugin.configure({ driver: rabbitmq({ url: 'amqp://localhost' }) })],
 * })
 * ```
 *
 * Options may be computed from the container (evaluated in `onBootstrap`):
 * `MessagingPlugin.configure(c => ({ driver: rabbitmq({ url: c.get(AmqpConfig).url }) }))`.
 */
export const MessagingPlugin: {
  configure(options: PluginOptions<MessagingPluginOptions>): MessagingPluginInstance
} = Object.freeze({
  configure(options: PluginOptions<MessagingPluginOptions>): MessagingPluginInstance {
    return createPlugin(options)
  },
})

function createPlugin(rawOptions: PluginOptions<MessagingPluginOptions>): MessagingPluginInstance {
  const broker = new DriverMessageBroker()
  let driver: MessagingDriver | undefined
  let connected = false
  let consume = true
  let runtimes: ConsumerRuntime[] = []

  return {
    name: 'messaging',
    broker,
    get driver(): MessagingDriver | undefined {
      return driver
    },
    consumers(): ConsumerStatus[] {
      return runtimes.map(runtime => ({
        consumer: runtime.consumer.name,
        queue: runtime.consumer.queue,
        state: runtime.state,
        concurrency: runtime.consumer.concurrency,
        inFlight: runtime.inFlight,
        deadLetterQueue: runtime.consumer.deadLetterQueue,
      }))
    },

    register(ctx: PluginContext): void {
      ctx.container.registerExternal({
        token: MessagingTokens.InboundMessage,
        scope: 'request',
        providedBy: 'MessagingPlugin',
      })
      ctx.container.registerValue(MessagingTokens.MessageBroker, broker)
    },

    async onBootstrap(ctx: PluginContext): Promise<void> {
      const options = validateOptions(resolveOptions(rawOptions, ctx.container))
      driver = options.driver
      consume = options.consume ?? true
      const defaults = options.defaults ?? {}
      const consumerDefaults: ConsumerDefaults = {
        retry: defaultRetryPolicy(defaults.retry),
        concurrency: defaults.concurrency ?? 1,
        deadLetter: defaults.deadLetter,
      }
      const prepared = prepareConsumers(ctx.metadata.extensions?.messaging, ctx.container, driver, consumerDefaults)
      const codec = options.codec ?? jsonCodec
      connected = true // close() must run even if connect() failed half-way
      await driver.connect({ logger: ctx.logger })
      broker.bind(driver, codec, ctx.hooks)
      const services = {
        container: ctx.container,
        hooks: ctx.hooks,
        logger: ctx.logger,
        codec,
        driver,
        requeueDelayMs: defaults.requeueDelay ?? DEFAULT_REQUEUE_DELAY_MS,
      }
      runtimes = prepared.map(consumer => new ConsumerRuntime(consumer, services))
    },

    async onStart(ctx: PluginContext): Promise<void> {
      if (!consume || runtimes.length === 0) return
      const results = await Promise.allSettled(runtimes.map(runtime => runtime.start()))
      const failure = results.find(result => result.status === 'rejected')
      if (failure !== undefined) {
        // the application only stops plugins whose onStart succeeded: undo the subscriptions made
        await Promise.all(runtimes.map(runtime => runtime.stop()))
        throw failure.reason
      }
      ctx.logger.info(`Messaging: ${runtimes.length} consumer(s) subscribed with the ${driver?.name} driver`, {
        queues: runtimes.map(runtime => runtime.consumer.queue),
      })
    },

    async onStop(): Promise<void> {
      await Promise.all(runtimes.map(runtime => runtime.stop()))
    },

    async onDispose(): Promise<void> {
      broker.unbind()
      if (driver !== undefined && connected) {
        connected = false
        await driver.close()
      }
    },
  }
}

function validateOptions(options: MessagingPluginOptions): MessagingPluginOptions {
  if (options === null || typeof options !== 'object') {
    throw consumerError('MessagingPlugin.configure(): options must be an object')
  }
  const driver = options.driver as Partial<MessagingDriver> | undefined
  if (
    driver === undefined ||
    driver === null ||
    typeof driver.connect !== 'function' ||
    typeof driver.subscribe !== 'function' ||
    typeof driver.publish !== 'function' ||
    typeof driver.close !== 'function' ||
    typeof driver.deadLetterName !== 'function' ||
    typeof driver.capabilities !== 'object'
  ) {
    throw consumerError('MessagingPlugin.configure(): "driver" must be a messaging driver', [
      "Use rabbitmq() from '@znight/messaging/rabbitmq', sqs(), kafka() or memory() from their subpaths",
    ])
  }
  const defaults = options.defaults
  if (defaults?.concurrency !== undefined && !isPositiveInteger(defaults.concurrency)) {
    throw consumerError(
      `MessagingPlugin defaults.concurrency must be a positive integer, got ${String(defaults.concurrency)}`,
    )
  }
  if (defaults?.requeueDelay !== undefined && !(Number.isFinite(defaults.requeueDelay) && defaults.requeueDelay >= 0)) {
    throw consumerError(
      `MessagingPlugin defaults.requeueDelay must be a number of milliseconds >= 0, got ${String(defaults.requeueDelay)}`,
    )
  }
  if (
    defaults?.deadLetter !== undefined &&
    defaults.deadLetter !== false &&
    typeof defaults.deadLetter !== 'function'
  ) {
    throw consumerError('MessagingPlugin defaults.deadLetter must be a function (queue => name) or false')
  }
  return options
}
