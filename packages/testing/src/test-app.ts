import type {
  ClassKey,
  Container,
  CoreLogger,
  Plugin,
  ProviderClass,
  ProviderKey,
  ProviderValues,
  ShutdownOptions,
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
   * Which providers are instantiated at boot (with their dependency closure, plus the overrides):
   * - default: the HTTP controllers (with their guards and interceptors) and the message consumers
   *   of the metadata, or every provider when there is none;
   * - `'all'`: every provider;
   * - a list of classes or tokens.
   *
   * Other providers are created on first use (synchronous factories only).
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
   * @throws the error of `Application.create()` / `app.start()` (everything is rolled back).
   */
  static async create(options: TestAppOptions): Promise<TestApp> {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('[znight] TestApp.create({ metadata }) requires options with the generated metadata')
    }
    const index = new MetadataIndex(options.metadata)
    const providers = resolveKeys(options.providers, index)
    const overrides = resolveKeys(options.overrides, index)
    const app = await Application.create({
      metadata: options.metadata,
      plugins: options.plugins ?? [],
      ...(providers === undefined ? {} : { providers }),
      ...(overrides === undefined ? {} : { overrides }),
      logger: options.logger ?? createConsoleLogger({ level: 'warn' }),
      shutdown: { ...options.shutdown, signals: false },
      init: initOptions(options, index, overrides),
    })
    if (options.start !== false) await app.start()
    return new TestApp(app)
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
  const extra = (overrides ?? []).map(([key]) => key)
  if (only !== undefined) {
    if (!Array.isArray(only)) throw new TypeError("[znight] TestApp.create(): only must be 'all' or an array of keys")
    return { only: unique([...only, ...extra]) }
  }
  const roots = [...readHttpRoots(options.metadata), ...readMessagingRoots(options.metadata)].filter(token =>
    index.isProvider(token),
  )
  if (roots.length === 0) return {}
  return { only: unique([...roots, ...extra]) }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
