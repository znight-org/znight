import { type CoreLogger, ErrorCode, type Plugin, silentLogger, type ZnightError } from '@znight/core'

import {
  createMetadata,
  createMock,
  defineTestMetadata,
  HTTP_PLUGIN_NAME,
  override,
  overrideFactory,
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
    const response = await app.inject({ url: '/nope', headers: { 'x-id': '1' }, query: { a: '1' }, body: { b: 2 } })
    expect(response.status).toBe(404)
    expect(http.requests[0]).toEqual({
      method: 'GET',
      url: '/nope',
      headers: { 'x-id': '1' },
      query: { a: '1' },
      body: { b: 2 },
    })
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
