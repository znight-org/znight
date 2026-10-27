import type { Plugin, PluginContext, PluginOptions, ProviderDefinition, Token } from '@znight/core'
import type { Logger } from '../logging/logger.ts'
import type { MetricsRegistry } from '../metrics/registry.ts'
import type { MetricsServer } from '../metrics/server.ts'
import type { Tracer } from '../tracing/tracer.ts'
import type { ObservabilityOptions } from './options.ts'

import { ErrorCode, resolveOptions, ZnightError } from '@znight/core'

import { flushEachEntry } from '../logging/logger.ts'
import { ObservabilityTokens } from '../tokens.ts'
import { buildKit, type ObservabilityKit } from './kit.ts'
import { validateInterceptorOptions } from './validate.ts'

/** Name of the plugin (`app.getPlugin('observability')`). */
export const OBSERVABILITY_PLUGIN_NAME = 'observability'

/** The plugin returned by `ObservabilityPlugin.configure()`. */
export interface ObservabilityPluginInstance extends Plugin {
  readonly name: typeof OBSERVABILITY_PLUGIN_NAME
  /** The logger, once the options are evaluated (at `register` for an object, during `init()` for a function). */
  readonly logger: Logger | undefined
  /** The tracer, once the options are evaluated. */
  readonly tracer: Tracer | undefined
  /** The metrics registry, when metrics are enabled. */
  readonly metrics: MetricsRegistry | undefined
  /** The `/metrics` server, when enabled (listening after `app.start()`). */
  readonly metricsServer: MetricsServer | undefined
}

/**
 * Logging, metrics and tracing for a Znight application.
 *
 * ```ts
 * const app = await Application.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [
 *     ObservabilityPlugin.configure({ logging: { level: 'debug', redact: ['*.password'] } }),
 *     HttpPlugin.configure({ port: 3000 }),
 *   ],
 * })
 * ```
 *
 * - `register`: provides `Logger`, `Tracer`, `MetricsRegistry` and the `@Logged` / `@Traced` /
 *   `@Metric` interceptors, wraps the `http:request`, `messaging:message` and `schedule:run` hooks
 *   (spans → RED metrics → logs), listens to `schedule:run` (run counters) and routes the framework
 *   logs through the logger;
 * - `onStart`: starts the `/metrics` server; `onStop`: closes it;
 * - `onDispose`: flushes the tracer provider and the logger transports; entries logged afterwards
 *   (the application's final `Application stopped`) are flushed as soon as they are written.
 *
 * Options may be a function of the container (`ObservabilityPlugin.configure(c => ({ logging: {
 * level: c.get(AppConfig).logLevel } }))`): it is evaluated when the first observability provider is
 * injected during `container.init()` (or in `onBootstrap`), and may only use synchronous providers that
 * do not depend on observability providers themselves (typically config classes).
 */
export const ObservabilityPlugin: {
  readonly name: typeof OBSERVABILITY_PLUGIN_NAME
  /** Creates the plugin. One instance per application. */
  configure(options?: PluginOptions<ObservabilityOptions>): ObservabilityPluginInstance
} = Object.freeze({
  name: OBSERVABILITY_PLUGIN_NAME,
  configure: (options: PluginOptions<ObservabilityOptions> = {}): ObservabilityPluginInstance =>
    new ObservabilityPluginImpl(options),
})

class ObservabilityPluginImpl implements ObservabilityPluginInstance {
  readonly name: typeof OBSERVABILITY_PLUGIN_NAME = OBSERVABILITY_PLUGIN_NAME
  readonly #options: PluginOptions<ObservabilityOptions>
  #context: PluginContext | undefined
  #kit: ObservabilityKit | undefined
  #unhook: (() => void)[] = []

  constructor(options: PluginOptions<ObservabilityOptions>) {
    this.#options = options
  }

  get logger(): Logger | undefined {
    return this.#kit?.logger
  }

  get tracer(): Tracer | undefined {
    return this.#kit?.tracer
  }

  get metrics(): MetricsRegistry | undefined {
    return this.#kit?.metrics
  }

  get metricsServer(): MetricsServer | undefined {
    return this.#kit?.server
  }

  register(ctx: PluginContext): void {
    if (this.#context !== undefined) {
      throw new ZnightError(
        ErrorCode.DuplicateProvider,
        'This ObservabilityPlugin is already used by another application',
        {
          hints: ['Call ObservabilityPlugin.configure() once per application'],
        },
      )
    }
    validateInterceptorOptions(ctx.metadata)
    this.#context = ctx
    this.#kit = undefined
    // object options are validated (and the core logger replaced) right away; a function of the
    // container is evaluated lazily, once providers can be resolved
    if (typeof this.#options !== 'function') this.#ensureKit(ctx)

    const container = ctx.container
    const external = <T>(token: Token, pick: (kit: ObservabilityKit) => T): void => {
      container.register(
        token,
        lazyValue(() => pick(this.#ensureKit(ctx))),
      )
    }
    external(ObservabilityTokens.Logger, kit => kit.logger)
    external(ObservabilityTokens.Tracer, kit => kit.tracer)
    external(ObservabilityTokens.MetricsRegistry, kit => {
      if (kit.metrics !== undefined) return kit.metrics
      throw kit.metricsUnavailable ?? new ZnightError(ErrorCode.MissingProvider, 'MetricsRegistry is unavailable')
    })
    external(ObservabilityTokens.LoggedInterceptor, kit => kit.loggedInterceptor)
    external(ObservabilityTokens.TracedInterceptor, kit => kit.tracedInterceptor)
    external(ObservabilityTokens.MetricInterceptor, kit => kit.metricInterceptor)

    // registered now (outermost position among plugins), resolved per call
    this.#unhook.push(
      ctx.hooks.wrap('http:request', (event, next) => {
        const wrapper = this.#kit?.http
        return wrapper === undefined ? next() : wrapper(event, next)
      }),
      ctx.hooks.wrap('messaging:message', (event, next) => {
        const wrapper = this.#kit?.messaging
        return wrapper === undefined ? next() : wrapper(event, next)
      }),
      ctx.hooks.wrap('messaging:publish', (event, next) => {
        const wrapper = this.#kit?.publish
        return wrapper === undefined ? next() : wrapper(event, next)
      }),
      ctx.hooks.wrap('schedule:run', (event, next) => {
        const wrapper = this.#kit?.schedule
        return wrapper === undefined ? next() : wrapper(event, next)
      }),
      ctx.hooks.on('schedule:run', event => {
        this.#kit?.scheduleListener?.(event)
      }),
    )
  }

  onBootstrap(ctx: PluginContext): void {
    this.#ensureKit(ctx)
  }

  async onStart(ctx: PluginContext): Promise<void> {
    const server = this.#kit?.server
    if (server === undefined) return
    await server.listen()
    ctx.logger.info('Metrics server listening', { url: server.url })
  }

  async onStop(): Promise<void> {
    await this.#kit?.server?.close()
  }

  async onDispose(): Promise<void> {
    const kit = this.#kit
    for (const unhook of this.#unhook) unhook()
    this.#unhook = []
    this.#context = undefined
    if (kit === undefined) return
    // the application still logs once its plugins are disposed ("Application stopped", "The
    // application stopped with errors"): deliver those entries too, not only what is buffered now
    flushEachEntry(kit.logger)
    await kit.server?.close()
    await kit.tracer.forceFlush()
    await kit.logger.flush()
  }

  #ensureKit(ctx: PluginContext): ObservabilityKit {
    this.#kit ??= buildKit(resolveOptions(this.#options, ctx.container), ctx)
    return this.#kit
  }
}

/**
 * A runtime definition returning an object owned by the plugin. Transient: created on injection
 * only (a disabled feature fails only where it is used), never lifecycle-managed nor disposed by
 * the container; `get()` always returns the same instance.
 */
function lazyValue<T>(get: () => T): ProviderDefinition<T> {
  return { scope: 'transient', deps: [], factory: get }
}
