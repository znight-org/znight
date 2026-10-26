import type {
  CoreLogger,
  DependencyRef,
  LogContext,
  ProviderClass,
  ProviderDefinition,
  Scope,
  Token,
  ZnightMetadata,
} from '@znight/core'
import type {
  ConsumerDefinition,
  ConsumerRuntimeOptions,
  MessageHandlerDefinition,
  MessagingPluginInstance,
  MessagingPluginOptions,
} from '../src/index.ts'

import { Application } from '@znight/core'

import { MemoryDriver, type MemoryDriverOptions } from '../src/drivers/memory.ts'
import { MessageBroker, MessagingPlugin, MessagingTokens } from '../src/index.ts'

/** Token of a test provider declared in `src/app.ts`. */
export function t(name: string): Token {
  return `src/app.ts#${name}`
}

// biome-ignore lint/suspicious/noExplicitAny: test classes take arbitrary constructor arguments
type Ctor = new (...args: any[]) => unknown

/** A consumer declared in hand-written metadata. */
export interface TestConsumer {
  readonly class: Ctor
  readonly queue: string
  readonly handlers: readonly MessageHandlerDefinition[]
  readonly token?: Token
  readonly deps?: readonly DependencyRef[]
  readonly scope?: Scope
  readonly options?: ConsumerRuntimeOptions
  readonly errorHandler?: string
}

/** A provider definition for a class: `factory: d => new cls(...d)`. */
export function classDef(
  cls: Ctor,
  deps: readonly DependencyRef[] = [],
  scope: Scope = 'singleton',
): ProviderDefinition {
  return {
    scope,
    class: cls as unknown as ProviderClass,
    deps,
    factory: (resolved: unknown[]) => new cls(...resolved),
  }
}

/** Hand-written metadata shaped like the compiler output (providers listed dependencies first). */
export function messagingMetadata(
  consumers: readonly TestConsumer[],
  providers: Readonly<Record<Token, ProviderDefinition>> = {},
): ZnightMetadata {
  const all: Record<Token, ProviderDefinition> = { ...providers }
  const definitions: ConsumerDefinition[] = []
  for (const consumer of consumers) {
    const token = consumer.token ?? t(consumer.class.name)
    all[token] = classDef(consumer.class, consumer.deps, consumer.scope)
    definitions.push({
      token,
      queue: consumer.queue,
      handlers: consumer.handlers,
      ...(consumer.options === undefined ? {} : { options: consumer.options }),
      ...(consumer.errorHandler === undefined ? {} : { errorHandler: consumer.errorHandler }),
    })
  }
  return {
    version: 1,
    providers: all,
    resolutionOrder: Object.keys(all),
    externals: [
      { token: MessagingTokens.MessageBroker, providedBy: 'MessagingPlugin' },
      { token: MessagingTokens.InboundMessage, scope: 'request', providedBy: 'MessagingPlugin' },
    ],
    extensions: { messaging: { consumers: definitions } },
  }
}

/** A handler definition calling `method` with the payload (or with `args(message)`). */
export function handler(
  method: string,
  extra: Partial<Omit<MessageHandlerDefinition, 'method'>> = {},
): MessageHandlerDefinition {
  return {
    method,
    invoke: (consumer: Record<string, (...args: unknown[]) => unknown>, message) =>
      (consumer[method] as (...args: unknown[]) => unknown).call(consumer, message.payload, message),
    ...extra,
  }
}

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: LogContext | undefined
}

/** A logger recording every entry. */
export function memoryLogger(): CoreLogger & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const write =
    (level: LogEntry['level']) =>
    (message: string, context?: LogContext): void => {
      entries.push({ level, message, context })
    }
  return { entries, debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

export interface TestAppOptions {
  readonly providers?: Readonly<Record<Token, ProviderDefinition>>
  readonly driver?: MemoryDriver
  readonly driverOptions?: MemoryDriverOptions
  readonly plugin?: Partial<MessagingPluginOptions>
  readonly start?: boolean
}

export interface TestApp {
  readonly app: Application
  readonly driver: MemoryDriver
  readonly broker: MessageBroker
  readonly plugin: MessagingPluginInstance
  readonly logs: LogEntry[]
}

/** Creates (and by default starts) an application with the messaging plugin and a memory driver. */
export async function createTestApp(
  consumers: readonly TestConsumer[],
  options: TestAppOptions = {},
): Promise<TestApp> {
  const driver = options.driver ?? new MemoryDriver(options.driverOptions)
  const logger = memoryLogger()
  const plugin = MessagingPlugin.configure({ driver, defaults: { requeueDelay: 5 }, ...options.plugin })
  const app = await Application.create({
    metadata: messagingMetadata(consumers, options.providers),
    plugins: [plugin],
    logger,
    shutdown: { signals: false },
  })
  if (options.start !== false) await app.start()
  return { app, driver, broker: app.get(MessageBroker), plugin, logs: logger.entries }
}

/** A promise with its resolvers. */
export function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The rejection of `promise` (fails when it resolves). */
export async function caught(promise: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    return error
  }
  throw new Error('Expected a rejection')
}

/** Message of an error (`undefined` for non-errors). */
export function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined
}

/** Cause of an error (`undefined` for non-errors). */
export function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined
}
