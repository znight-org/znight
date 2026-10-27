import type { AddressInfo } from 'node:net'

import { createServer } from 'node:http'
import {
  type CoreLogger,
  ErrorCode,
  type Plugin,
  type PluginContext,
  type PluginRootsContext,
  type ProviderKey,
  silentLogger,
  type ZnightError,
  type ZnightMetadata,
} from '@znight/core'

import {
  createMetadata,
  createMock,
  defineTestMetadata,
  HTTP_PLUGIN_NAME,
  type HttpInjectResult,
  override,
  overrideFactory,
  type PluginInitRoots,
  type SetCookieInfo,
  TestApp,
  testToken,
} from '../src/index.ts'
import {
  AppConfig,
  AuditService,
  appMetadata,
  BrokenService,
  type ConfigSource,
  Database,
  type Logger,
  T,
  UserController,
  UserRepository,
  UserService,
} from './support/app.ts'
import { fakeHttp } from './support/fake-http.ts'
import { describe, expect, test as it, mock } from 'bun:test'

const metadata = appMetadata()

const logger: Logger = { info: () => undefined, error: () => undefined }
const configSource: ConfigSource = { get: key => (key === 'API_KEY' ? 'secret' : undefined) }
/** Values for the externals of the application (normally supplied by plugins). */
const providers = { [T.Logger]: logger, [T.ConfigSource]: configSource }

async function rejection(promise: Promise<unknown>): Promise<ZnightError> {
  try {
    await promise
  } catch (error) {
    return error as ZnightError
  }
  throw new Error('expected a rejection')
}

function quiet(): CoreLogger {
  return silentLogger
}

describe('TestApp.create', () => {
  it('starts the application with its plugins', async () => {
    const http = fakeHttp()
    const app = await TestApp.create({ metadata, plugins: [http], providers, logger: quiet() })
    expect(app.app.state).toBe('ready')
    expect(http.calls).toEqual(['register', 'onBootstrap', 'onStart'])
    expect(app.container).toBe(app.app.container)
    await app.close()
    expect(app.app.state).toBe('stopped')
    expect(http.calls).toEqual(['register', 'onBootstrap', 'onStart', 'onStop', 'onDispose'])
  })

  it('installs no signal handler', async () => {
    const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')
    const app = await TestApp.create({ metadata, providers, logger: quiet() })
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before)
    await app.close()
  })

  it('start: false only bootstraps', async () => {
    const http = fakeHttp()
    const app = await TestApp.create({ metadata, plugins: [http], providers, start: false, logger: quiet() })
    expect(app.app.state).toBe('created')
    expect(http.calls).toEqual(['register', 'onBootstrap'])
    await app.close()
  })

  it('is disposable with await using', async () => {
    const http = fakeHttp()
    {
      await using app = await TestApp.create({ metadata, plugins: [http], providers, logger: quiet() })
      expect(app.app.state).toBe('ready')
    }
    expect(http.calls.at(-1)).toBe('onDispose')
  })

  it('close is idempotent', async () => {
    const app = await TestApp.create({ metadata, providers, logger: quiet() })
    await Promise.all([app.close(), app.close()])
    await app.close()
    expect(app.app.state).toBe('stopped')
  })

  it('rejects without options or metadata and propagates boot failures', async () => {
    expect(await rejection(TestApp.create(undefined as never))).toBeInstanceOf(TypeError)
    const noMetadata = await rejection(TestApp.create({} as never))
    expect(noMetadata.code).toBe(ErrorCode.MissingProvider)
    expect(noMetadata.hints.join()).toContain('znight generate')
    const missing = await rejection(TestApp.create({ metadata, logger: quiet() }))
    expect(missing.code).toBe(ErrorCode.MissingProvider)
    expect(missing.message).toContain('ObservabilityPlugin')
    const failingPlugin: Plugin = {
      name: 'failing',
      onStart() {
        throw new Error('cannot start')
      },
    }
    const failed = await rejection(TestApp.create({ metadata, providers, plugins: [failingPlugin], logger: quiet() }))
    expect(failed.message).toContain('cannot start')
  })

  it('uses a console logger limited to warnings by default', async () => {
    const debug = mock(() => undefined)
    const original = console.debug
    console.debug = debug
    try {
      const app = await TestApp.create({ metadata, providers })
      await app.close()
    } finally {
      console.debug = original
    }
    expect(debug).not.toHaveBeenCalled()
  })

  it('accepts shutdown timeouts', async () => {
    const app = await TestApp.create({ metadata, providers, logger: quiet(), shutdown: { timeoutMs: 1000 } })
    await app.close()
    expect(app.app.state).toBe('stopped')
  })
})

describe('TestApp: instantiated providers', () => {
  it('by default only the closure of controllers (and consumers) is instantiated', async () => {
    const app = await TestApp.create({ metadata, providers, logger: quiet() })
    const created = app.container.instances().map(instance => instance.token)
    expect(created).toContain(T.UserController)
    expect(created).toContain(T.UserService)
    expect(created).toContain(T.PgUserRepository)
    // BrokenService is outside of the closure: never instantiated
    expect(created).not.toContain(T.BrokenService)
    await app.close()
  })

  it("only: 'all' instantiates every provider", async () => {
    const error = await rejection(TestApp.create({ metadata, providers, only: 'all', logger: quiet() }))
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.message).toContain('BrokenService')
  })

  it('only: a list of keys', async () => {
    const app = await TestApp.create({ metadata, providers, only: [AuditService], logger: quiet() })
    expect(app.container.instances().map(instance => instance.token)).toEqual([T.AuditService])
    // other providers are created on first use
    expect(app.get(Database)).toBeInstanceOf(Database)
    await app.close()
  })

  it('rejects an invalid only option', async () => {
    expect(await rejection(TestApp.create({ metadata, providers, only: 'some' as never }))).toBeInstanceOf(TypeError)
  })

  it('message consumers are roots too', async () => {
    const messaging = createMetadata(
      {
        [T.Database]: { scope: 'singleton', class: Database, deps: [], factory: () => new Database() },
        [T.AuditService]: { scope: 'singleton', class: AuditService, deps: [], factory: () => new AuditService() },
        [T.BrokenService]: { scope: 'singleton', class: BrokenService, deps: [], factory: () => new BrokenService() },
      },
      { extensions: { messaging: { consumers: [{ token: T.AuditService, queue: 'audit', handlers: [] }] } } },
    )
    const app = await TestApp.create({ metadata: messaging, logger: quiet() })
    expect(app.container.instances().map(instance => instance.token)).toEqual([T.AuditService])
    await app.close()
  })

  it('without controllers nor consumers, every provider is instantiated', async () => {
    const plain = defineTestMetadata({ providers: [Database, AuditService] })
    const app = await TestApp.create({ metadata: plain, logger: quiet() })
    expect(app.container.instances()).toHaveLength(2)
    await app.close()
  })

  it('unknown root tokens in the extensions are ignored', async () => {
    const odd = defineTestMetadata({
      providers: [Database],
      extensions: {
        http: {
          controllers: [{ token: 'src/gone.ts#Gone', guards: ['src/x.ts#X'], routes: [{ guards: [] }] }, 'junk'],
        },
        messaging: { consumers: [null, { token: 42 }] },
      },
    })
    const app = await TestApp.create({ metadata: odd, logger: quiet() })
    expect(app.container.instances()).toHaveLength(1)
    await app.close()
  })

  it('hosts of scheduled jobs are roots too, disabled jobs included', async () => {
    const jobs = createMetadata(
      {
        [T.Database]: { scope: 'singleton', class: Database, deps: [], factory: () => new Database() },
        [T.AuditService]: { scope: 'singleton', class: AuditService, deps: [], factory: () => new AuditService() },
        [T.BrokenService]: { scope: 'singleton', class: BrokenService, deps: [], factory: () => new BrokenService() },
      },
      {
        extensions: {
          schedule: {
            jobs: [
              { name: 'audit.purge', token: T.AuditService, method: 'purge', kind: 'interval', every: 60_000 },
              { name: 'db.vacuum', token: T.Database, method: 'vacuum', kind: 'cron', cron: '@daily', enabled: false },
            ],
          },
        },
      },
    )
    const app = await TestApp.create({ metadata: jobs, logger: quiet() })
    expect(app.container.instances().map(instance => instance.token)).toEqual(
      expect.arrayContaining([T.AuditService, T.Database]),
    )
    // BrokenService is no entry point: not instantiated
    expect(app.container.instances()).toHaveLength(2)
    await app.close()
  })

  it('job hosts join the controllers, and malformed job entries are ignored', async () => {
    const withJobs: ZnightMetadata = {
      ...metadata,
      extensions: {
        ...metadata.extensions,
        schedule: { jobs: [{ token: T.AuditService }, null, 'junk', { token: 42 }, { token: 'src/gone.ts#Gone' }] },
      },
    }
    const app = await TestApp.create({ metadata: withJobs, providers, logger: quiet() })
    const created = app.container.instances().map(instance => instance.token)
    expect(created).toEqual(expect.arrayContaining([T.UserController, T.AuditService]))
    expect(created).not.toContain(T.BrokenService)
    await app.close()
  })

  it('a malformed schedule section adds no root', async () => {
    const odd = defineTestMetadata({ providers: [Database, AuditService], extensions: { schedule: { jobs: 'x' } } })
    const app = await TestApp.create({ metadata: odd, logger: quiet() })
    expect(app.container.instances()).toHaveLength(2)
    await app.close()
  })

  it('overridden providers are part of the instantiated closure', async () => {
    const factory = mock(() => new AuditService())
    const app = await TestApp.create({
      metadata,
      providers,
      overrides: [overrideFactory(AuditService, factory)],
      logger: quiet(),
    })
    expect(factory).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

/** A token store loaded at boot by an async `@Provides()` (e.g. JWKS). */
class TokenStore {
  constructor(readonly tokens: ReadonlySet<string>) {}
}

/** A global guard (`HttpPlugin.configure({ guards: [AuthGuard] })`) depending on the async store. */
class AuthGuard {
  constructor(readonly store: TokenStore) {}
  canActivate(token: string): boolean {
    return this.store.tokens.has(token)
  }
}

class HelloController {
  hello(): { ok: boolean } {
    return { ok: true }
  }
}

/** Not a provider of the metadata. */
class NotAProvider {}

const G = {
  Store: 'src/auth.ts#StoreFactory.store',
  AuthGuard: 'src/auth.ts#AuthGuard',
  Hello: 'src/hello.controller.ts#HelloController',
  Database: 'src/db.ts#Database',
} as const

/** The controller, the global guard, its async dependency and an async provider nothing needs. */
function guardedMetadata(controllers = true): ZnightMetadata {
  return createMetadata(
    {
      [G.Store]: {
        scope: 'singleton',
        deps: [],
        async: true,
        factory: () => Promise.resolve(new TokenStore(new Set(['secret']))),
      },
      [G.AuthGuard]: { scope: 'singleton', class: AuthGuard, deps: [G.Store], factory: d => new AuthGuard(d[0]) },
      [G.Hello]: { scope: 'singleton', class: HelloController, deps: [], factory: () => new HelloController() },
      [G.Database]: {
        scope: 'singleton',
        deps: [],
        async: true,
        factory: () => Promise.reject(new Error('no database in tests')),
      },
    },
    {
      aliases: { 'src/auth.ts#TokenStore': G.Store },
      extensions: controllers
        ? {
            http: {
              controllers: [{ token: G.Hello, basePath: '/hello', guards: [], interceptors: [], meta: {}, routes: [] }],
            },
          }
        : {},
    },
  )
}

interface GlobalsPlugin extends Plugin {
  readonly resolved: unknown[]
  initRoots?(): readonly ProviderKey[]
}

/**
 * Resolves the global guards of its options in `onBootstrap`, like `HttpPlugin`, and lists them in
 * `initRoots()` (unless `roots` is `false`).
 */
function globalsPlugin(guards: readonly ProviderKey[], roots: readonly ProviderKey[] | false = guards): GlobalsPlugin {
  const resolved: unknown[] = []
  const plugin: GlobalsPlugin = {
    name: 'globals',
    resolved,
    onBootstrap(ctx: PluginContext) {
      for (const guard of guards) resolved.push(ctx.container.get(guard as never))
    },
  }
  return roots === false ? plugin : { ...plugin, initRoots: () => roots }
}

describe('TestApp: providers resolved by plugins at bootstrap', () => {
  it('global providers listed by initRoots() are created at boot with their async dependencies', async () => {
    const plugin = globalsPlugin([AuthGuard])
    const app = await TestApp.create({ metadata: guardedMetadata(), plugins: [plugin], logger: quiet() })
    const guard = plugin.resolved[0] as AuthGuard
    expect(guard).toBeInstanceOf(AuthGuard)
    expect(guard.canActivate('secret')).toBe(true)
    const created = app.container.instances().map(instance => instance.token)
    expect(created).toEqual(expect.arrayContaining([G.Hello, G.Store, G.AuthGuard]))
    // the boot is still limited to the entry points
    expect(created).not.toContain(G.Database)
    await app.close()
  })

  it('without initRoots(), the async dependency fails on demand with a hint about the only option', async () => {
    const error = await rejection(
      TestApp.create({ metadata: guardedMetadata(), plugins: [globalsPlugin([AuthGuard], false)], logger: quiet() }),
    )
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.message).toContain('on demand')
    expect(error.hints.join('\n')).toContain('TestApp.create({ only: [...] })')
    // the same plugin boots when the guard is listed explicitly
    const app = await TestApp.create({
      metadata: guardedMetadata(),
      plugins: [globalsPlugin([AuthGuard], false)],
      only: [HelloController, AuthGuard],
      logger: quiet(),
    })
    await app.close()
  })

  it('plugin roots are added to an explicit only list', async () => {
    const plugin = globalsPlugin([G.AuthGuard])
    const app = await TestApp.create({
      metadata: guardedMetadata(),
      plugins: [plugin],
      only: [HelloController],
      logger: quiet(),
    })
    expect(plugin.resolved[0]).toBeInstanceOf(AuthGuard)
    expect(app.container.instances().map(instance => instance.token)).not.toContain(G.Database)
    await app.close()
  })

  it('keys that are not providers of the metadata are left to the plugin', async () => {
    const plugin = globalsPlugin([], [NotAProvider, 'src/gone.ts#Gone', 42 as never, 'TokenStore', AuthGuard])
    const app = await TestApp.create({ metadata: guardedMetadata(), plugins: [plugin], logger: quiet() })
    // the alias 'TokenStore' designates the async store: created at boot
    expect(app.get(TokenStore).tokens.has('secret')).toBe(true)
    expect(app.container.instances().map(instance => instance.token)).toContain(G.AuthGuard)
    await app.close()
  })

  it('plugin roots do not limit the boot when the metadata has no entry point', async () => {
    const plain = createMetadata({
      [G.Hello]: { scope: 'singleton', class: HelloController, deps: [], factory: () => new HelloController() },
      [G.Store]: guardedMetadata().providers[G.Store] as never,
    })
    const app = await TestApp.create({ metadata: plain, plugins: [globalsPlugin([HelloController])], logger: quiet() })
    expect(app.container.instances()).toHaveLength(2)
    await app.close()
  })

  it("only: 'all' ignores plugin roots", async () => {
    const error = await rejection(
      TestApp.create({
        metadata: guardedMetadata(),
        plugins: [globalsPlugin([AuthGuard])],
        only: 'all',
        logger: quiet(),
      }),
    )
    expect(error.message).toContain('no database in tests')
  })

  it('initRoots() receives the metadata, so a plugin can derive its roots from its own section', async () => {
    const contexts: PluginRootsContext[] = []
    /** Like a scheduler: the hosts listed in `extensions.jobs` are needed at boot. */
    const jobsPlugin: Plugin = {
      name: 'jobs',
      initRoots(context) {
        contexts.push(context)
        const section = context.metadata.extensions?.['jobs'] as { hosts?: readonly string[] } | undefined
        return section?.hosts ?? []
      },
    }
    const base = guardedMetadata()
    const withJobs: ZnightMetadata = { ...base, extensions: { ...base.extensions, jobs: { hosts: [G.AuthGuard] } } }
    const app = await TestApp.create({ metadata: withJobs, plugins: [jobsPlugin], logger: quiet() })
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.metadata).toBe(withJobs)
    expect(Object.isFrozen(contexts[0])).toBe(true)
    // the async store the host depends on was created at boot: the host resolves synchronously
    expect(app.get(AuthGuard).canActivate('secret')).toBe(true)
    expect(app.container.instances().map(instance => instance.token)).not.toContain(G.Database)
    await app.close()
  })

  it('initRoots() is part of the Plugin contract of @znight/core', () => {
    const plugin: Plugin = globalsPlugin([AuthGuard])
    const roots: PluginInitRoots = { initRoots: () => [AuthGuard] }
    expect(plugin.initRoots?.({ metadata: guardedMetadata() })).toEqual([AuthGuard])
    expect(roots.initRoots({ metadata: guardedMetadata() })).toEqual([AuthGuard])
  })

  it('rejects a plugin whose initRoots() does not return an array', async () => {
    const invalid = { ...globalsPlugin([]), initRoots: () => AuthGuard as never }
    const error = await rejection(TestApp.create({ metadata: guardedMetadata(), plugins: [invalid], logger: quiet() }))
    expect(error).toBeInstanceOf(TypeError)
    expect(error.message).toContain('initRoots() of the plugin "globals"')
  })
})

/** Listens on a free port of 127.0.0.1 (a server of another test file, `znight dev`...). */
async function occupyPort(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/**
 * A plugin starting a server on a fixed port in `onStart`, failing like the metrics server of
 * `ObservabilityPlugin` (default port 9464) when the port is taken.
 */
function metricsLikePlugin(port: number): Plugin & { readonly closed: () => boolean } {
  const server = createServer()
  return {
    name: 'observability',
    closed: () => !server.listening,
    async onStart() {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => resolve())
        })
      } catch (error) {
        throw new Error(`Cannot start the metrics server on 127.0.0.1:${port}`, { cause: error })
      }
    },
    onStop: () => new Promise<void>(resolve => (server.listening ? server.close(() => resolve()) : resolve())),
  }
}

describe('TestApp: servers on a port already in use', () => {
  it('a start failing with EADDRINUSE tells how to give the servers a free port or none', async () => {
    const taken = await occupyPort()
    try {
      const plugin = metricsLikePlugin(taken.port)
      const error = await rejection(TestApp.create({ metadata, providers, plugins: [plugin], logger: quiet() }))
      expect(error.code).toBe(ErrorCode.LifecycleFailed)
      expect(error.message).toContain('Cannot start the metrics server')
      expect(error.hints).toContainEqual(
        expect.stringContaining('ObservabilityPlugin with { metrics: { server: false } }'),
      )
      expect(error.hints.join('\n')).toContain('HttpPlugin with { port: 0 }')
      expect(error.hints.filter(hint => hint.includes('no fixed port'))).toHaveLength(1)
      expect(plugin.closed()).toBe(true)
    } finally {
      await taken.close()
    }
  })

  it('other start failures get no port hint', async () => {
    const failing: Plugin = {
      name: 'failing',
      onStart() {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    }
    const error = await rejection(TestApp.create({ metadata, providers, plugins: [failing], logger: quiet() }))
    expect(error.message).toContain('permission denied')
    expect(error.hints.join('\n')).not.toContain('no fixed port')
  })
})

describe('TestApp: overrides', () => {
  it('replace providers with the highest precedence', async () => {
    const repository = createMock(UserRepository)
    repository.findById.mockResolvedValue({ id: '7', name: 'Grace' })
    const app = await TestApp.create({
      metadata,
      providers,
      overrides: [override(UserRepository, repository)],
      logger: quiet(),
    })
    // the real container applies interceptors: TimingInterceptor wraps the result
    expect((await app.get(UserController).getUser('7')) as unknown).toEqual({ intercepted: { id: '7', name: 'Grace' } })
    expect(repository.findById).toHaveBeenCalledWith('7')
    await app.close()
  })

  it('win over plugin registrations', async () => {
    const pluginLogger: Logger = { info: () => undefined, error: () => undefined }
    const observability: Plugin = {
      name: 'observability',
      register(ctx) {
        ctx.container.registerValue(T.Logger, pluginLogger)
      },
    }
    const overridden = createMock<Logger>()
    const app = await TestApp.create({
      metadata,
      providers: { [T.ConfigSource]: configSource },
      plugins: [observability],
      overrides: new Map([[T.Logger, overridden]]),
      logger: quiet(),
    })
    expect(app.get(UserService).logger).toBe(overridden)
    await app.close()
  })

  it('keys may be display names or aliases, like in TestBed', async () => {
    const repository = createMock(UserRepository)
    const named = createMock<Logger>()
    const app = await TestApp.create({
      metadata,
      providers: { Logger: named, ConfigSource: configSource },
      overrides: [['UserRepository', repository]],
      logger: quiet(),
    })
    expect(app.get(UserService).repository).toBe(repository)
    expect(app.get(UserService).logger).toBe(named)
    await app.close()
  })

  it('ambiguous display names are rejected', async () => {
    const ambiguous = createMetadata({
      'src/a.ts#Thing': { scope: 'singleton', deps: [], factory: () => 'a' },
      'src/b.ts#Thing': { scope: 'singleton', deps: [], factory: () => 'b' },
    })
    const error = await rejection(TestApp.create({ metadata: ambiguous, overrides: [['Thing', 'x']], logger: quiet() }))
    expect(error.code).toBe(ErrorCode.AmbiguousInjection)
  })

  it('unknown string keys are kept as tokens (registered at runtime)', async () => {
    const app = await TestApp.create({
      metadata,
      providers: { ...providers, '@acme/runtime#Extra': 42 },
      logger: quiet(),
    })
    expect(app.get('@acme/runtime#Extra')).toBe(42)
    await app.close()
  })

  it('a generator of overrides is read once', async () => {
    const repository = createMock(UserRepository)
    function* entries(): Generator<readonly [typeof UserRepository, unknown]> {
      yield [UserRepository, repository]
    }
    const app = await TestApp.create({ metadata, providers, overrides: entries(), logger: quiet() })
    expect(app.get(UserService).repository).toBe(repository)
    await app.close()
  })

  it('application providers feed externals and configuration', async () => {
    const app = await TestApp.create({ metadata, providers, logger: quiet() })
    expect(app.get(AppConfig).apiKey).toBe('secret')
    expect(app.get(UserService).describe()).toBe('znight@postgres://znight')
    await app.close()
  })
})

describe('TestApp.inject', () => {
  it('dispatches through the http plugin', async () => {
    const http = fakeHttp()
    const repository = createMock(UserRepository)
    repository.findById.mockResolvedValue({ id: '1', name: 'Ada' })
    const app = await TestApp.create({
      metadata,
      providers,
      plugins: [http],
      overrides: [[UserRepository, repository]],
      logger: quiet(),
    })
    const response = await app.inject({ method: 'get', url: '/users/1' })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ intercepted: { id: '1', name: 'Ada' } })
    expect(response.headers['content-type']).toBe('application/json')
    expect(repository.findById).toHaveBeenCalledWith('1')
    expect(http.requests[0]).toEqual({ method: 'GET', url: '/users/1' })
    await app.close()
  })

  it('the method defaults to GET; other fields are passed through', async () => {
    const http = fakeHttp()
    const app = await TestApp.create({ metadata, providers, plugins: [http], logger: quiet() })
    const response = await app.inject({
      url: '/nope',
      headers: { 'x-id': '1' },
      query: { a: '1' },
      body: { b: 2 },
      cookies: { theme: 'dark' },
      signedCookies: { uid: 'u-1' },
    })
    expect(response.status).toBe(404)
    expect(response.cookies).toEqual({})
    expect(http.requests[0]).toEqual({
      method: 'GET',
      url: '/nope',
      headers: { 'x-id': '1' },
      query: { a: '1' },
      body: { b: 2 },
      cookies: { theme: 'dark' },
      signedCookies: { uid: 'u-1' },
    })
    await app.close()
  })

  it('derives bytes from the body when the plugin does not provide them', async () => {
    const http = fakeHttp()
    const app = await TestApp.create({ metadata, providers, plugins: [http], logger: quiet() })
    const response = await app.inject({ url: '/nope' })
    expect(response.body).toBe('{"message":"Not Found"}')
    expect(response.bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(response.bytes)).toBe(response.body)
    expect(response.json()).toEqual({ message: 'Not Found' })
    await app.close()
  })

  it('returns the response of the plugin as is when it has bytes and cookies', async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x7f])
    const response = {
      status: 200,
      headers: {},
      body: '\ufffd\u0000\u007f',
      bytes,
      cookies: {},
      json: <T>() => null as T,
    }
    const binary = { name: HTTP_PLUGIN_NAME, inject: () => Promise.resolve(response) }
    const app = await TestApp.create({ metadata, providers, plugins: [binary], logger: quiet() })
    const received = await app.inject({ url: '/file.bin' })
    expect(received).toBe(response)
    expect(received.bytes).toBe(bytes)
    await app.close()
  })

  it('keeps the bytes and the cookies the plugin provides, and returns no cookies when it has none', async () => {
    const session: SetCookieInfo = {
      name: 'session',
      value: 'abc',
      raw: 'session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      partitioned: false,
    }
    const bytes = new Uint8Array([1, 2, 3])
    const responses: HttpInjectResult[] = [
      { status: 200, headers: {}, body: 'x', bytes, json: <T>() => null as T },
      { status: 204, headers: { 'set-cookie': session.raw }, body: '', cookies: { session }, json: <T>() => null as T },
      { status: 200, headers: {}, body: 'y', cookies: null as never, json: <T>() => null as T },
    ]
    const plugin = { name: HTTP_PLUGIN_NAME, inject: () => Promise.resolve(responses.shift() as HttpInjectResult) }
    const app = await TestApp.create({ metadata, providers, plugins: [plugin], logger: quiet() })

    const binary = await app.inject({ url: '/file.bin' })
    expect(binary.bytes).toBe(bytes)
    expect(binary.cookies).toEqual({})
    expect(Object.isFrozen(binary.cookies)).toBe(true)

    const login = await app.inject({ method: 'POST', url: '/login' })
    expect(login.cookies['session']).toBe(session)
    expect(login.bytes).toEqual(new Uint8Array())
    expect(login.headers['set-cookie']).toBe(session.raw)

    expect((await app.inject({ url: '/' })).cookies).toEqual({})
    await app.close()
  })

  it('passes FormData and Blob bodies to the plugin unchanged', async () => {
    const http = fakeHttp()
    const app = await TestApp.create({ metadata, providers, plugins: [http], logger: quiet() })
    const form = new FormData()
    form.append('title', 'Me')
    form.append('avatar', new File(['png'], 'me.png', { type: 'image/png' }))
    const blob = new Blob(['raw'], { type: 'text/csv' })
    await app.inject({ method: 'POST', url: '/upload', body: form })
    await app.inject({ method: 'PUT', url: '/raw', body: blob })
    expect(http.requests[0]?.body).toBe(form)
    expect(http.requests[1]?.body).toBe(blob)
    await app.close()
  })

  it('requires the http plugin', async () => {
    const app = await TestApp.create({ metadata, providers, logger: quiet() })
    const error = await rejection(app.inject({ url: '/users/1' }))
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.hints.join()).toContain('HttpPlugin')
    const impostor: Plugin = { name: HTTP_PLUGIN_NAME }
    const other = await TestApp.create({ metadata, providers, plugins: [impostor], logger: quiet() })
    expect((await rejection(other.inject({ url: '/' }))).code).toBe(ErrorCode.MissingProvider)
    await Promise.all([app.close(), other.close()])
  })

  it('validates the request', async () => {
    const app = await TestApp.create({ metadata, providers, plugins: [fakeHttp()], logger: quiet() })
    expect(await rejection(app.inject({} as never))).toBeInstanceOf(TypeError)
    expect(await rejection(app.inject(null as never))).toBeInstanceOf(TypeError)
    await app.close()
  })

  it('fails once closed', async () => {
    const app = await TestApp.create({ metadata, providers, plugins: [fakeHttp()], logger: quiet() })
    await app.close()
    const error = await rejection(app.inject({ url: '/users/1' }))
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
  })

  it('propagates plugin errors', async () => {
    const failing = {
      name: HTTP_PLUGIN_NAME,
      inject: () => {
        throw new Error('adapter crashed')
      },
    }
    const app = await TestApp.create({ metadata, providers, plugins: [failing], logger: quiet() })
    expect((await rejection(app.inject({ url: '/' }))).message).toBe('adapter crashed')
    await app.close()
  })
})

describe('TestApp.injectStream / injectSse', () => {
  it('delegate to the http plugin', async () => {
    const calls: unknown[] = []
    const stream = { status: 200, headers: {}, cookies: {}, body: new ReadableStream<Uint8Array>() }
    const sse = { status: 200, body: '' }
    const plugin = {
      name: HTTP_PLUGIN_NAME,
      injectStream(request: unknown) {
        calls.push(['stream', request, this === plugin])
        return Promise.resolve(stream)
      },
      injectSse(request: unknown) {
        calls.push(['sse', request, this === plugin])
        return Promise.resolve(sse)
      },
    }
    const app = await TestApp.create({ metadata, providers, plugins: [plugin], logger: quiet() })
    const signal = new AbortController().signal
    expect(await app.injectStream({ url: '/a', signal })).toBe(stream as never)
    expect(await app.injectSse({ method: 'post', url: '/b', cookies: { c: '1' } })).toBe(sse as never)
    expect(calls).toEqual([
      ['stream', { method: 'GET', url: '/a', signal }, true],
      ['sse', { method: 'POST', url: '/b', cookies: { c: '1' } }, true],
    ])
    await app.close()
  })

  it('require an http plugin with streaming support (ZNIGHT001)', async () => {
    const none = await TestApp.create({ metadata, providers, logger: quiet() })
    const missing = await rejection(none.injectSse({ url: '/' }))
    expect(missing.code).toBe(ErrorCode.MissingProvider)
    expect(missing.message).toBe('ZNIGHT001: TestApp.injectSse() requires the HTTP plugin with streaming support')
    expect(missing.hints.join()).toContain('HttpPlugin.configure')
    const old = await TestApp.create({ metadata, providers, plugins: [fakeHttp()], logger: quiet() })
    const outdated = await rejection(old.injectStream({ url: '/' }))
    expect(outdated.code).toBe(ErrorCode.MissingProvider)
    // the hint names the cause and a version that exists (streaming ships with @znight/http 0.1.0)
    expect(outdated.hints).toEqual([
      "The plugin named 'http' does not implement injectStream(): register HttpPlugin.configure({ adapter }) from @znight/http ≥ 0.1.0 (the same release as @znight/testing)",
    ])
    expect(outdated.hints.join()).not.toContain('0.2')
    await Promise.all([none.close(), old.close()])
  })

  it('validate the request and fail once closed', async () => {
    const app = await TestApp.create({ metadata, providers, plugins: [fakeHttp()], logger: quiet() })
    expect(await rejection(app.injectSse({} as never))).toBeInstanceOf(TypeError)
    expect(await rejection(app.injectStream(null as never))).toBeInstanceOf(TypeError)
    await app.close()
    expect((await rejection(app.injectSse({ url: '/' }))).code).toBe(ErrorCode.LifecycleFailed)
    expect((await rejection(app.injectStream({ url: '/' }))).message).toContain(
      'TestApp.injectStream(): the application is closed',
    )
  })
})

describe('TestApp.get', () => {
  it('resolves by class, token or display name', async () => {
    const app = await TestApp.create({ metadata, providers, logger: quiet() })
    const controller = app.get(UserController)
    expect(app.get(T.UserController)).toBe(controller)
    expect(app.get('UserController')).toBe(controller)
    expect(app.get(UserRepository)).toBe(app.get(T.PgUserRepository))
    expect(testToken(UserController)).toBe('test#UserController')
    await app.close()
  })
})
