import type { Plugin, PluginContext, PluginOptions, PluginRootsContext, ProviderKey, TypedToken } from '@znight/core'
import type { PublicationObserver } from './dispatcher.ts'
import type { EventsPluginOptions } from './options.ts'

import { ErrorCode, resolveOptions, ZnightError } from '@znight/core'

import { Dispatcher } from './dispatcher.ts'
import { notRunningError } from './errors.ts'
import { resolveEventsOptions } from './options.ts'
import { EventPublisher } from './publisher.ts'
import { buildRegistry } from './registry.ts'
import { EventsTokens } from './tokens.ts'

/** Lifecycle state of the plugin. */
export type EventsPluginState = 'created' | 'running' | 'stopped' | 'disposed'

/** The plugin returned by {@link EventsPlugin.configure}. */
export interface EventsPluginInstance extends Plugin {
  readonly name: 'events'
  /** The publisher (also injectable as `EventPublisher`), usable from the end of `onBootstrap`. */
  readonly publisher: EventPublisher
  readonly state: EventsPluginState
  /**
   * Resolves once no detached listener nor `emit()` work is in flight (at once before bootstrap).
   * Tests use it, through `recordEvents()` of `@znight/events/testing`.
   */
  idle(): Promise<void>
  /**
   * Calls `observer` for every publication of the running application, with or without listeners,
   * before it is dispatched (`recordEvents()` of `@znight/events/testing`). Returns a function
   * removing it. Observers are dropped when the application is disposed.
   */
  observe(observer: PublicationObserver): () => void
  /** The hosts of the listeners of the metadata (read by `TestApp` of `@znight/testing`). */
  initRoots(context: PluginRootsContext): readonly ProviderKey[]
}

/** Name of the plugin (`app.getPlugin('events')`). */
export const EVENTS_PLUGIN_NAME = 'events'

/**
 * Internal provider registered by the plugin. It is the last provider of the resolution order, so
 * the first one disposed: its disposal drains the detached listeners of an application whose
 * `onStop` did not run (never started, or rolled back), before their providers are disposed.
 */
const SHUTDOWN_DRAIN: TypedToken<AsyncDisposable> = '@znight/events#EventsShutdownDrain'

/**
 * In-process application events (RFC 0011).
 *
 * ```ts
 * const app = await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [EventsPlugin.configure(), HttpPlugin.configure({ adapter: honoAdapter(), port: 3000 })],
 * })
 * ```
 *
 * - `register`: provides `EventPublisher`;
 * - `onBootstrap`: builds the listener registry from `metadata.extensions.events` (ZNIGHT070,
 *   ZNIGHT001); from then on `publish()` works;
 * - `onStop`: publications from now on await their detached listeners; waits for the detached
 *   listeners and `emit()` work in flight, up to `drainTimeoutMs`, then logs those still running.
 *   When the application never started (no `onStop`), the same drain runs before the first
 *   provider is disposed;
 * - `onDispose`: waits for the work started after `onStop` (with a warning), then refuses
 *   publications (ZNIGHT021).
 *
 * List it **before** `HttpPlugin`, `MessagingPlugin` and `SchedulePlugin`: plugins stop in reverse
 * order, so it drains once no request, message or job can publish any more. Options may be a
 * function of the container, evaluated in `onBootstrap`.
 */
export const EventsPlugin: {
  readonly name: 'events'
  configure(options?: PluginOptions<EventsPluginOptions>): EventsPluginInstance
} = Object.freeze({
  name: EVENTS_PLUGIN_NAME,
  configure: (options: PluginOptions<EventsPluginOptions> = {}): EventsPluginInstance => new EventsPluginImpl(options),
})

class EventsPluginImpl implements EventsPluginInstance {
  readonly name = EVENTS_PLUGIN_NAME
  readonly publisher: PublisherImpl = new PublisherImpl()
  readonly #options: PluginOptions<EventsPluginOptions>
  #drainTimeoutMs = 0
  #active = false

  constructor(options: PluginOptions<EventsPluginOptions>) {
    this.#options = options
  }

  get state(): EventsPluginState {
    return this.publisher.dispatcher?.state ?? (this.publisher.disposed ? 'disposed' : 'created')
  }

  idle(): Promise<void> {
    return this.publisher.dispatcher?.idle() ?? Promise.resolve()
  }

  observe(observer: PublicationObserver): () => void {
    if (typeof observer !== 'function') throw new TypeError('[znight] EventsPlugin.observe() expects a function')
    const dispatcher = this.publisher.dispatcher
    if (dispatcher === undefined) {
      throw notRunningError('observe', this.publisher.disposed ? 'disposed' : 'created')
    }
    dispatcher.observers = [...dispatcher.observers, observer]
    return () => {
      dispatcher.observers = dispatcher.observers.filter(other => other !== observer)
    }
  }

  initRoots(context: PluginRootsContext): readonly ProviderKey[] {
    try {
      const section: unknown = context?.metadata?.extensions?.events
      const listeners = (section as { readonly listeners?: unknown } | undefined)?.listeners
      if (!Array.isArray(listeners)) return []
      const roots = new Set<ProviderKey>()
      for (const listener of listeners as unknown[]) {
        const token = (listener as { readonly token?: unknown } | null)?.token
        if (typeof token === 'string') roots.add(token)
      }
      return [...roots]
    } catch {
      return [] // malformed metadata is reported by onBootstrap
    }
  }

  register(ctx: PluginContext): void {
    if (this.#active) {
      throw new ZnightError(ErrorCode.DuplicateProvider, 'This EventsPlugin is already used by another application', {
        hints: ['Call EventsPlugin.configure() once per application'],
      })
    }
    // an instance may serve several applications one after the other (shared test setups)
    this.#active = true
    this.publisher.reset()
    ctx.container.registerValue(EventsTokens.EventPublisher, this.publisher)
    ctx.container.register(SHUTDOWN_DRAIN, {
      scope: 'singleton',
      deps: [],
      factory: () => ({ [Symbol.asyncDispose]: () => this.#drainUnstarted(ctx) }),
    })
  }

  onBootstrap(ctx: PluginContext): void {
    const options = resolveEventsOptions(resolveOptions(this.#options, ctx.container))
    this.#drainTimeoutMs = options.drainTimeoutMs
    const registry = buildRegistry(ctx.metadata, ctx.container)
    this.publisher.dispatcher = new Dispatcher(registry, {
      container: ctx.container,
      hooks: ctx.hooks,
      logger: ctx.logger,
      onError: options.onError,
    })
    // created at init, except in restricted boots (`init: { only }`)
    ctx.container.get(SHUTDOWN_DRAIN)
    if (registry.size > 0) ctx.logger.debug(`Events: ${registry.size} listener(s)`, { listeners: registry.size })
  }

  async onStop(ctx: PluginContext): Promise<void> {
    const dispatcher = this.publisher.dispatcher
    if (dispatcher === undefined) return
    await this.#drain(dispatcher, ctx)
  }

  /** Disposal of the {@link SHUTDOWN_DRAIN} provider: drains when `onStop` did not run. */
  async #drainUnstarted(ctx: PluginContext): Promise<void> {
    const dispatcher = this.publisher.dispatcher
    if (dispatcher === undefined || dispatcher.state !== 'running') return
    await this.#drain(dispatcher, ctx)
  }

  async #drain(dispatcher: Dispatcher, ctx: PluginContext): Promise<void> {
    const pending = await dispatcher.stop(this.#drainTimeoutMs)
    if (pending.length > 0) {
      ctx.logger.warn(`Events: ${pending.length} listener(s) still running after ${this.#drainTimeoutMs} ms`, {
        listeners: pending,
      })
    }
  }

  async onDispose(ctx: PluginContext): Promise<void> {
    const dispatcher = this.publisher.dispatcher
    this.#active = false
    if (dispatcher === undefined) return
    const late = dispatcher.late()
    if (late.length > 0) {
      ctx.logger.warn(`Events: waiting for ${late.length} listener(s) started after onStop`, { listeners: late })
    }
    const pending = await dispatcher.dispose(this.#drainTimeoutMs)
    // a timed-out dispose may end after the instance was registered by the next application
    if (this.publisher.dispatcher === dispatcher) {
      this.publisher.dispatcher = undefined
      this.publisher.disposed = true
    }
    if (pending.length > 0) {
      ctx.logger.warn(`Events: ${pending.length} listener(s) still running after disposal`, { listeners: pending })
    }
  }
}

/** The publisher of one plugin instance, bound to its dispatcher from the end of `onBootstrap`. */
class PublisherImpl extends EventPublisher {
  dispatcher: Dispatcher | undefined
  disposed = false

  reset(): void {
    this.dispatcher = undefined
    this.disposed = false
  }

  publish(event: object): Promise<void> {
    const dispatcher = this.dispatcher
    if (dispatcher === undefined) {
      return Promise.reject(notRunningError('publish', this.disposed ? 'disposed' : 'created'))
    }
    return dispatcher.publish(event)
  }

  emit(event: object): void {
    const dispatcher = this.dispatcher
    if (dispatcher === undefined) throw notRunningError('emit', this.disposed ? 'disposed' : 'created')
    dispatcher.emit(event)
  }
}
