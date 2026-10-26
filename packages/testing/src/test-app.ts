import type {
  ClassKey,
  Container,
  CoreLogger,
  Plugin,
  ProviderClass,
  ProviderKey,
  ProviderValues,
  ShutdownOptions,
  Token,
  TypedToken,
  ZnightMetadata,
} from '@znight/core'

import { Application, createConsoleLogger, ErrorCode, ZnightError } from '@znight/core'

import { readHttpRoots, readMessagingRoots } from './extensions.ts'
import { MetadataIndex } from './metadata-index.ts'
import { entriesOf } from './utils.ts'

/** Name of the HTTP plugin `TestApp.inject()` delegates to (`HttpPlugin.configure()` from `@znight/http`). */
export const HTTP_PLUGIN_NAME = 'http'

/** An in-memory HTTP request for {@link TestApp.inject}. */
export interface InjectRequest {
  /** HTTP method. Default: `GET`. */
  readonly method?: string
  /** Path, with an optional query string (`/users?page=2`). */
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Request body, encoded by the HTTP plugin: a string or bytes are sent as is (`text/plain` /
   * `application/octet-stream` without `content-type` header), a `FormData` as
   * `multipart/form-data` (files included: uploads), a `Blob` / `File` with its type, anything else
   * as JSON (`application/json`).
   */
  readonly body?: unknown
  /** Query parameters added to those of `url`. */
  readonly query?: Readonly<Record<string, string | readonly string[]>>
}

/** The response of {@link TestApp.inject}. */
export interface InjectResponse {
  readonly status: number
  /** Response headers (lower-cased names). */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  /** The body decoded as UTF-8. */
  readonly body: string
  /** The raw body bytes (downloads, binary responses). */
  readonly bytes: Uint8Array
  /** The body parsed as JSON. */
  json<T = unknown>(): T
}

/**
 * What the `inject()` of the HTTP plugin resolves with: an {@link InjectResponse} whose `bytes` may
 * be absent (`TestApp.inject()` then encodes `body` as UTF-8).
 */
export type HttpInjectResult = Omit<InjectResponse, 'bytes'> & { readonly bytes?: Uint8Array }

/**
 * What `TestApp.inject()` expects from the plugin named `'http'`: an in-memory dispatch (no socket).
 * `HttpPlugin` from `@znight/http` implements it.
 */
export interface HttpInjector {
  inject(request: InjectRequest & { readonly method: string }): Promise<HttpInjectResult>
}

/**
 * Optional plugin member read by `TestApp.create()`: the providers the plugin resolves while it
 * bootstraps although the metadata does not reference them, i.e. classes or tokens given in its
 * options (`HttpPlugin.configure({ guards, interceptors, exceptionMappers })`). `TestApp` adds them
 * to the providers instantiated at boot (see {@link TestAppOptions.only}), so that their async
 * dependencies exist when the plugin resolves them: an async factory cannot run on demand.
 *
 * Called once, before the application is created. Keys that are not providers of the metadata are
 * ignored (the plugin reports them itself).
 */
export interface PluginInitRoots {
  initRoots(): readonly ProviderKey[]
}

/** Options of {@link TestApp.create}. */
export interface TestAppOptions {
  /** The generated metadata (`__ZNIGHT_METADATA__`). */
  readonly metadata: ZnightMetadata
  readonly plugins?: readonly Plugin[]
  /** Values supplied by the application (externals, configuration...), as in `Application.create`. */
  readonly providers?: ProviderValues
  /**
   * Replacements applied last, with the highest precedence: values or provider definitions
   * (`{ scope, deps, factory }`), keyed by class or token. Overridden providers are instantiated.
   */
  readonly overrides?: ProviderValues
  /**
   * Which providers are instantiated at boot (with their dependency closure, plus the overrides and
   * the providers the plugins resolve at bootstrap, see {@link PluginInitRoots}: global guards,
   * interceptors and exception mappers of `HttpPlugin`):
   * - default: the HTTP controllers (with their guards and interceptors) and the message consumers
   *   of the metadata, or every provider when there is none;
   * - `'all'`: every provider;
   * - a list of classes or tokens.
   *
   * Other providers are created on first use (synchronous factories only: list a provider here
   * when it, or one of its dependencies, has an async factory).
   */
  readonly only?: readonly ProviderKey[] | 'all'
  /** Application logger. Default: a console logger writing warnings and errors. */
  readonly logger?: CoreLogger
  /** Run `app.start()` (plugins `onStart`: listen, subscribe...). Default: `true`. */
  readonly start?: boolean
  /** Shutdown timeouts. Signal handlers are always disabled. */
  readonly shutdown?: Omit<ShutdownOptions, 'signals' | 'process'>
}

/**
 * End-to-end harness: a started {@link Application} without signal handlers, overrides applied last
 * and only what the tested entry points need instantiated.
 *
 * ```ts
 * await using app = await TestApp.create({
 *   metadata: __ZNIGHT_METADATA__,
 *   plugins: [HttpPlugin.configure({ adapter: fastify() })],
 *   overrides: [[UserRepository, fakeRepository]],
 * })
 * const response = await app.inject({ method: 'GET', url: '/users/1' })
 * expect(response.status).toBe(200)
 * expect(response.json()).toEqual({ id: '1' })
 * ```
 */
export class TestApp implements AsyncDisposable {
  /** The application under test. */
  readonly app: Application
  #closed = false

  private constructor(app: Application) {
    this.app = app
  }

  /**
   * Creates and (by default) starts the application.
   *
   * Plugins are used as configured: give the servers they start a free port or none in tests
   * (`HttpPlugin.configure({ port: 0 })`, `ObservabilityPlugin.configure({ metrics: { server: false } })`);
   * a start failing on a port already in use (`EADDRINUSE`) gets a hint saying so.
   *
   * @throws the error of `Application.create()` / `app.start()` (everything is rolled back).
   */
  static async create(options: TestAppOptions): Promise<TestApp> {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('[znight] TestApp.create({ metadata }) requires options with the generated metadata')
    }
    const index = new MetadataIndex(options.metadata)
    const providers = resolveKeys(options.providers, index)
    const overrides = resolveKeys(options.overrides, index)
    const init = initOptions(options, index, overrides)
    try {
      const app = await Application.create({
        metadata: options.metadata,
        plugins: options.plugins ?? [],
        ...(providers === undefined ? {} : { providers }),
        ...(overrides === undefined ? {} : { overrides }),
        logger: options.logger ?? createConsoleLogger({ level: 'warn' }),
        shutdown: { ...options.shutdown, signals: false },
        init,
      })
      if (options.start !== false) await app.start()
      return new TestApp(app)
    } catch (error) {
      addHints(error, init.only !== undefined)
      throw error
    }
  }

  /** The application container. */
  get container(): Container {
    return this.app.container
  }

  /** Shortcut for `app.container.get(key)`. */
  get<T>(key: ProviderClass<T>): T
  get<T>(key: ClassKey<T>): T
  get<T = unknown>(key: TypedToken<T>): T
  get(key: ProviderKey): unknown {
    return this.app.container.get(key as TypedToken<unknown>)
  }

  /**
   * Dispatches a request in memory through the HTTP plugin (`HttpPlugin`): routing, guards,
   * interceptors, validation, serialisation, without opening a socket. Send uploads as a
   * `FormData` body; read downloads from `response.bytes`.
   *
   * @throws ZnightError ZNIGHT001 when the application has no HTTP plugin, ZNIGHT021 once closed.
   */
  inject(request: InjectRequest): Promise<InjectResponse> {
    try {
      if (this.#closed) {
        throw new ZnightError(ErrorCode.LifecycleFailed, 'TestApp.inject(): the application is closed')
      }
      if (request === null || typeof request !== 'object' || typeof request.url !== 'string') {
        throw new TypeError('[znight] TestApp.inject() expects { method?, url, headers?, body?, query? }')
      }
      const plugin = this.app.getPlugin<Plugin & Partial<HttpInjector>>(HTTP_PLUGIN_NAME)
      if (plugin === undefined || typeof plugin.inject !== 'function') {
        throw new ZnightError(ErrorCode.MissingProvider, 'TestApp.inject() requires the HTTP plugin', {
          hints: ['Add HttpPlugin.configure({ adapter }) from @znight/http to TestApp.create({ plugins })'],
        })
      }
      const method = (request.method ?? 'GET').toUpperCase()
      return Promise.resolve(plugin.inject({ ...request, method })).then(withBytes)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** Stops the application (idempotent): plugins `onStop`, providers `onStop` and disposal, plugins `onDispose`. */
  close(): Promise<void> {
    this.#closed = true
    return this.app.stop()
  }

  /** {@link close}, for `await using app = await TestApp.create(...)`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

const ENCODER = new TextEncoder()

/** The plugin response, with `bytes` derived from `body` when the plugin did not provide them. */
function withBytes(response: HttpInjectResult): InjectResponse {
  if (response.bytes instanceof Uint8Array) return response as InjectResponse
  const bytes = ENCODER.encode(response.body)
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    bytes,
    json: <T = unknown>(): T => response.json<T>(),
  }
}

type Entries = readonly (readonly [ProviderKey, unknown])[]

/**
 * Materialises `providers`/`overrides` and maps string keys that are not tokens of the metadata to
 * the token they designate (alias or unique display name: `'UserRepository'`), like `TestBed` does.
 * Unknown strings are kept (tokens registered at runtime by plugins); classes are resolved by the
 * container.
 */
function resolveKeys(values: ProviderValues | undefined, index: MetadataIndex): Entries | undefined {
  if (values === undefined) return undefined
  const known = index.knownTokens()
  return entriesOf<ProviderKey, unknown>(values).map(([key, value]): readonly [ProviderKey, unknown] => {
    if (typeof key !== 'string' || known.has(key)) return [key, value]
    return [index.find(key, known) ?? key, value]
  })
}

function initOptions(
  options: TestAppOptions,
  index: MetadataIndex,
  overrides: Entries | undefined,
): { readonly only?: readonly ProviderKey[] } {
  const only = options.only
  if (only === 'all') return {}
  let roots: readonly ProviderKey[]
  if (only === undefined) {
    roots = [...readHttpRoots(options.metadata), ...readMessagingRoots(options.metadata)].filter(token =>
      index.isProvider(token),
    )
    if (roots.length === 0) return {}
  } else {
    if (!Array.isArray(only)) throw new TypeError("[znight] TestApp.create(): only must be 'all' or an array of keys")
    roots = only
  }
  const extra = (overrides ?? []).map(([key]) => key)
  return { only: unique([...roots, ...pluginRoots(options.plugins ?? [], index), ...extra]) }
}

/**
 * Providers the plugins resolve at bootstrap ({@link PluginInitRoots}), as provider tokens of the
 * metadata. Other keys (classes without provider, unknown or ambiguous names) are left to the
 * plugin, which reports them with its own message.
 */
function pluginRoots(plugins: readonly Plugin[], index: MetadataIndex): Token[] {
  const providers = new Set(index.providerTokens())
  const roots: Token[] = []
  for (const plugin of plugins) {
    const initRoots = (plugin as Partial<PluginInitRoots> | null | undefined)?.initRoots
    if (typeof initRoots !== 'function') continue
    const keys: unknown = initRoots.call(plugin)
    if (!Array.isArray(keys)) {
      throw new TypeError(
        `[znight] TestApp.create(): initRoots() of the plugin "${String(plugin.name)}" must return an array of classes or tokens`,
      )
    }
    for (const key of keys) {
      const token = findProvider(key, providers, index)
      if (token !== undefined) roots.push(token)
    }
  }
  return roots
}

function findProvider(key: unknown, providers: ReadonlySet<Token>, index: MetadataIndex): Token | undefined {
  try {
    return index.find(key, providers)
  } catch {
    return undefined // ambiguous display name
  }
}

const ONLY_HINT = "With TestApp: list it in TestApp.create({ only: [...] }) (or pass only: 'all') to create it at boot"

/** Hint added to start failures caused by a port already in use (`EADDRINUSE`). */
const PORT_IN_USE_HINT =
  'With TestApp, servers need no fixed port (inject() sends requests in memory): configure HttpPlugin with { port: 0 } and ObservabilityPlugin with { metrics: { server: false } } (or server: { port: 0 }) in tests'

interface ErrorLike {
  readonly code?: unknown
  readonly hints?: unknown
  readonly cause?: unknown
}

/**
 * Adds TestApp hints to a failed `TestApp.create()`, along the `cause` chain:
 * - the TestApp form of the container hint to "cannot create on demand: its factory is async"
 *   errors (ZNIGHT015, hint `init({ only })`) of a restricted boot, which `TestApp` exposes as its
 *   `only` option;
 * - when a server could not listen because its port is taken (`EADDRINUSE`: a fixed port, such as
 *   the default `9464` of the observability metrics server, shared by test files running in
 *   parallel or by `znight dev`), the options giving it a free port or none, on the outermost error
 *   carrying hints (the `ZnightError` the application wraps plugin failures in).
 */
function addHints(error: unknown, restricted: boolean): void {
  const chain: (object & ErrorLike)[] = []
  let current = error
  while (current !== null && typeof current === 'object' && !chain.includes(current)) {
    chain.push(current)
    current = (current as ErrorLike).cause
  }
  if (restricted) {
    for (const item of chain) {
      if (
        item.code === ErrorCode.InstantiationFailed &&
        Array.isArray(item.hints) &&
        item.hints.some(hint => typeof hint === 'string' && hint.includes('init({ only })'))
      ) {
        addHint(item, ONLY_HINT)
      }
    }
  }
  if (chain.some(item => item.code === 'EADDRINUSE')) {
    const outermost = chain.find(item => Array.isArray(item.hints))
    if (outermost !== undefined) addHint(outermost, PORT_IN_USE_HINT)
  }
}

function addHint(error: object & ErrorLike, hint: string): void {
  const hints = error.hints as readonly unknown[]
  // `hints` is a plain own property of ZnightError; a frozen error is left as is
  if (!hints.includes(hint)) Reflect.set(error, 'hints', [...hints, hint])
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
