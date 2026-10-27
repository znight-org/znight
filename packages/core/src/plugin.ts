import type { Application } from './application.ts'
import type { Container } from './container.ts'
import type { Hooks } from './hooks.ts'
import type { CoreLogger } from './logger.ts'
import type { ZnightMetadata } from './metadata.ts'
import type { ProviderKey } from './tokens.ts'

/**
 * A runtime feature (HTTP server, message consumers, configuration, observability...). Every hook
 * is optional and may be async. Hooks run in plugin order, stop hooks in reverse order.
 *
 * 1. `register`: provide externals (`ctx.container.registerValue()` / `register()`), before
 *    `container.init()`.
 * 2. `onBootstrap`: after `container.init()`: register routes, consumers... (no traffic yet).
 * 3. `onStart`: start accepting traffic (listen, subscribe), after providers' `onStart`.
 * 4. `onReady`: everything started.
 * 5. `onStop`: stop accepting traffic and drain in-flight work, before providers stop.
 * 6. `onDispose`: release infrastructure (connections, flush buffers), after providers are disposed.
 */
export interface Plugin {
  /** Unique name (used by `getPlugin()` and in messages). */
  readonly name: string
  register?(ctx: PluginContext): void | Promise<void>
  onBootstrap?(ctx: PluginContext): void | Promise<void>
  onStart?(ctx: PluginContext): void | Promise<void>
  onReady?(ctx: PluginContext): void | Promise<void>
  onStop?(ctx: PluginContext): void | Promise<void>
  onDispose?(ctx: PluginContext): void | Promise<void>
  /**
   * The providers (classes or tokens) the plugin needs at boot although the metadata does not make
   * them entry points: classes given in its options (`HttpPlugin`'s global `guards`,
   * `interceptors`, `exceptionMappers`), or providers it derives from its own metadata section.
   *
   * Read by tools that restrict the boot to a few providers (`init: { only }`), such as `TestApp`
   * of `@znight/testing`: they create these providers at boot with their dependencies, because an
   * async factory cannot run on demand. The application itself never calls it.
   *
   * Called before the application is created (before `register`), possibly several times: it must
   * be cheap and side-effect free, and SHOULD NOT throw (report invalid options in `onBootstrap`).
   * Options given as a function of the container cannot be read yet: return what is known (`[]`).
   */
  initRoots?(context: PluginRootsContext): readonly ProviderKey[]
}

/** What {@link Plugin.initRoots} receives. */
export interface PluginRootsContext {
  /** The metadata the application will be created with. */
  readonly metadata: ZnightMetadata
}

/** Name of a {@link Plugin} hook. */
export type PluginHook = 'register' | 'onBootstrap' | 'onStart' | 'onReady' | 'onStop' | 'onDispose'

/** What a plugin hook receives. */
export interface PluginContext {
  readonly app: Application
  readonly container: Container
  readonly metadata: ZnightMetadata
  readonly hooks: Hooks
  /** Live, delegating logger: always forwards to the logger currently installed on the application. */
  readonly logger: CoreLogger
  /** Another plugin of the application, by name. */
  getPlugin<P extends Plugin = Plugin>(name: string): P | undefined
}

/**
 * Plugin options given directly or computed from the container (evaluated in `onBootstrap`, once
 * every provider exists):
 *
 * ```ts
 * HttpPlugin.configure(c => ({ port: c.get(AppConfig).port }))
 * ```
 *
 * Options that are themselves a function cannot use this form.
 */
export type PluginOptions<O> = O | ((container: Container) => O)

/** Resolves {@link PluginOptions}: calls the function form with the container, returns the others as is. */
export function resolveOptions<O>(options: PluginOptions<O>, container: Container): O {
  return typeof options === 'function' ? (options as (container: Container) => O)(container) : options
}
