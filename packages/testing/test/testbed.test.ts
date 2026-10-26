import {
  ErrorCode,
  getSuppressedErrors,
  InstantiationError,
  type Lazy,
  type TypedToken,
  token,
  ZnightError,
} from '@znight/core'

import {
  createMetadata,
  createMock,
  createSpy,
  defineTestMetadata,
  isBuiltinSpy,
  isMock,
  overrideFactory,
  TestBed,
} from '../src/index.ts'
import {
  AppConfig,
  AuditListener,
  AuditService,
  appMetadata,
  type Cache,
  Database,
  type Logger,
  PgUserRepository,
  T,
  TimingInterceptor,
  UserController,
  UserRepository,
  UserService,
} from './support/app.ts'
import { describe, expect, test as it, mock } from 'bun:test'

const metadata = appMetadata()
/** Values required by UserService that cannot be auto-mocked. */
const provide = { 'DbFactory.databaseUrl': 'postgres://test' }

async function rejection(promise: Promise<unknown>): Promise<ZnightError> {
  try {
    await promise
  } catch (error) {
    return error as ZnightError
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): ZnightError {
  try {
    fn()
  } catch (error) {
    return error as ZnightError
  }
  throw new Error('expected an error')
}

describe('TestBed.create: the target', () => {
  it('is built with its real factory and auto-mocked direct dependencies', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide })
    expect(instance).toBeInstanceOf(UserService)
    expect(isMock(instance.repository)).toBe(true)
    expect(instance.repository).toBe(mocks.get(PgUserRepository))
    expect(isMock(instance.logger)).toBe(true)
  })

  it('auto-mocks are verifiable with bun:test matchers', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide })
    mocks.get(UserRepository).findById.mockResolvedValue({ id: '1', name: 'Ada' })
    expect(await instance.findById('1')).toEqual({ id: '1', name: 'Ada' })
    expect(mocks.get(UserRepository).findById).toHaveBeenCalledWith('1')
    expect(mocks.get(UserRepository).findById).toHaveBeenCalledTimes(1)
    expect(mocks.get<Logger>('Logger').info).toHaveBeenCalledWith('find', { id: '1' })
  })

  it('can be designated by token, display name or typed token', async () => {
    const byToken = await TestBed.create(T.UserController, { metadata })
    expect(byToken.instance).toBeInstanceOf(UserController)
    const byName = await TestBed.create('UserController', { metadata })
    expect(byName.instance).toBeInstanceOf(UserController)
    const typed: TypedToken<UserController> = token<UserController>(T.UserController)
    const { instance } = await TestBed.create(typed, { metadata })
    expect(instance.users).toBeDefined()
  })

  it('can be an abstract base resolved through its implementation', async () => {
    const { instance, mocks } = await TestBed.create(UserRepository, { metadata })
    expect(instance).toBeInstanceOf(PgUserRepository)
    mocks.get(Database).query.mockResolvedValue([{ id: '1', name: 'Ada' }])
    expect(await instance.findById('1')).toEqual({ id: '1', name: 'Ada' })
    expect(mocks.get(Database).query).toHaveBeenCalledWith('select * from users where id = $1', ['1'])
  })

  it('an unknown target is a ZNIGHT001 with hints', async () => {
    class NotAProvider {}
    const error = await rejection(TestBed.create(NotAProvider, { metadata }))
    expect(error).toBeInstanceOf(ZnightError)
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('class NotAProvider is not a provider')
    expect(error.hints.join('\n')).toContain('znight generate')
  })

  it('an ambiguous display name is a ZNIGHT008', async () => {
    const ambiguous = createMetadata({
      'src/a.ts#Thing': { scope: 'singleton', deps: [], factory: () => 'a' },
      'src/b.ts#Thing': { scope: 'singleton', deps: [], factory: () => 'b' },
    })
    const error = await rejection(TestBed.create('Thing', { metadata: ambiguous }))
    expect(error.code).toBe(ErrorCode.AmbiguousInjection)
  })

  it('async factories are awaited', async () => {
    const asyncMetadata = defineTestMetadata({
      providers: [{ token: 'src/pool.ts#Pool', async: true, factory: async () => ({ ready: true }) }],
    })
    const { instance } = await TestBed.create('Pool', { metadata: asyncMetadata })
    expect(instance).toEqual({ ready: true })
  })

  it('a failing factory is a ZNIGHT015 InstantiationError carrying the cause and the source', async () => {
    const cause = new Error('cannot connect')
    const failing = createMetadata({
      'src/db.ts#Db': {
        scope: 'singleton',
        deps: [],
        factory: () => {
          throw cause
        },
        source: { file: 'src/db.ts', line: 4, column: 1 },
      },
      'src/pool.ts#Pool': { scope: 'singleton', deps: [], async: true, factory: () => Promise.reject(cause) },
    })
    const error = await rejection(TestBed.create('Db', { metadata: failing }))
    expect(error).toBeInstanceOf(InstantiationError)
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.cause).toBe(cause)
    expect((error as InstantiationError).source).toEqual({ file: 'src/db.ts', line: 4, column: 1 })
    const asyncError = await rejection(TestBed.create('Pool', { metadata: failing }))
    expect(asyncError.cause).toBe(cause)
  })

  it('request-scoped and transient targets are built directly', async () => {
    const scoped = defineTestMetadata({
      providers: [
        { class: AuditService, scope: 'request' },
        { class: Database, scope: 'transient' },
      ],
    })
    expect((await TestBed.create(AuditService, { metadata: scoped })).instance).toBeInstanceOf(AuditService)
    const transient = await TestBed.create(Database, { metadata: scoped })
    expect(transient.container.get(Database)).toBe(transient.instance)
  })
})

describe('TestBed.create: dependency kinds', () => {
  it('classes, interfaces (aliases) and externals are deep auto-mocks', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide })
    expect(instance.repository).toBeInstanceOf(PgUserRepository)
    const repository: unknown = mocks.get(UserRepository)
    expect(mocks.get(PgUserRepository) as unknown).toBe(repository)
    expect(mocks.get(T.UserRepository) as unknown).toBe(repository)
    expect(mocks.get(T.PgUserRepository) as unknown).toBe(repository)
    expect(mocks.get('PgUserRepository') as unknown).toBe(repository)
    expect(mocks.get(T.Logger)).toBe(mocks.get('Logger'))
    expect(mocks.tokens()).toEqual([T.PgUserRepository, T.Logger, T.AuditService])
  })

  it('configuration classes are real instances built from defaults', async () => {
    const { instance } = await TestBed.create(UserService, { metadata, provide })
    expect(instance.config).toBeInstanceOf(AppConfig)
    expect(isMock(instance.config)).toBe(false)
    expect(instance.config).toMatchObject({ name: 'znight', port: 3000, debug: false, tags: ['a', 'b'] })
    expect(instance.config.apiKey).toBeUndefined()
  })

  it('configuration values override defaults (by class, display name or prefix)', async () => {
    const byClass = await TestBed.create(UserService, {
      metadata,
      provide,
      config: [[AppConfig, { port: 8080, apiKey: 'secret' }]],
    })
    expect(byClass.instance.config).toMatchObject({ name: 'znight', port: 8080, apiKey: 'secret' })
    const byName = await TestBed.create(UserService, { metadata, provide, config: { AppConfig: { debug: true } } })
    expect(byName.instance.config.debug).toBe(true)
    const byPrefix = await TestBed.create(UserService, { metadata, provide, config: { app: { name: 'custom' } } })
    expect(byPrefix.instance.describe()).toBe('custom@postgres://test')
  })

  it('configuration defaults are copied (no state shared between tests)', async () => {
    const first = await TestBed.create(UserService, { metadata, provide })
    first.instance.config.tags.push('mutated')
    const second = await TestBed.create(UserService, { metadata, provide })
    expect(second.instance.config.tags).toEqual(['a', 'b'])
  })

  it('invalid configuration values are ZNIGHT012', async () => {
    const unknownClass = await rejection(TestBed.create(UserService, { metadata, provide, config: { Nope: {} } }))
    expect(unknownClass.code).toBe(ErrorCode.InvalidConfig)
    expect(unknownClass.hints.join()).toContain('AppConfig (prefix "app")')
    const unknownProperty = await rejection(
      TestBed.create(UserService, { metadata, provide, config: { AppConfig: { prot: 1 } } }),
    )
    expect(unknownProperty.code).toBe(ErrorCode.InvalidConfig)
    expect(unknownProperty.message).toContain('"prot"')
    const notAnObject = await rejection(
      TestBed.create(UserService, { metadata, provide, config: { AppConfig: 3 as never } }),
    )
    expect(notAnObject.code).toBe(ErrorCode.InvalidConfig)
    const none = await rejection(
      TestBed.create(UserController, {
        metadata: defineTestMetadata({ providers: [UserController] }),
        config: { x: {} },
      }),
    )
    expect(none.hints.join()).toContain('no configuration class')
  })

  it('a provided value wins over the configuration instance', async () => {
    const config = new AppConfig()
    const { instance } = await TestBed.create(UserService, { metadata, provide: { ...provide, AppConfig: config } })
    expect(instance.config).toBe(config)
  })

  it('qualified values must be provided (ZNIGHT001 naming them)', async () => {
    const error = await rejection(TestBed.create(UserService, { metadata }))
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('DbFactory.databaseUrl')
    expect(error.message).toContain('"databaseUrl"')
    expect(error.hints.join()).toContain('provide')
  })

  it('provided values are injected as is, by any key form', async () => {
    const byToken = await TestBed.create(UserService, { metadata, provide: [[T.DatabaseUrl, 'postgres://token']] })
    expect(byToken.instance.databaseUrl).toBe('postgres://token')
    const byMap = await TestBed.create(UserService, {
      metadata,
      provide: new Map([['DbFactory.databaseUrl', 'postgres://map']]),
    })
    expect(byMap.instance.databaseUrl).toBe('postgres://map')
    const repository = createMock(UserRepository)
    const byAlias = await TestBed.create(UserService, { metadata, provide: { ...provide, UserRepository: repository } })
    expect(byAlias.instance.repository).toBe(repository)
    expect(() => byAlias.mocks.get(UserRepository)).toThrow('passed with `provide`')
  })

  it('provide keys must designate something of the metadata', async () => {
    const unknown = await rejection(TestBed.create(UserService, { metadata, provide: { ...provide, Nope: 1 } }))
    expect(unknown.code).toBe(ErrorCode.MissingProvider)
    expect(unknown.message).toContain('"Nope"')
    const duplicate = await rejection(
      TestBed.create(UserService, {
        metadata,
        provide: [
          [T.DatabaseUrl, 'a'],
          ['DbFactory.databaseUrl', 'b'],
        ],
      }),
    )
    expect(duplicate.code).toBe(ErrorCode.DuplicateProvider)
    expect(await rejection(TestBed.create(UserService, { metadata, provide: [['x']] as never }))).toBeInstanceOf(
      TypeError,
    )
  })

  it('optional dependencies are undefined unless provided', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide })
    expect(instance.cache).toBeUndefined()
    expect(() => mocks.get(T.Cache)).toThrow('optional dependency')
    const cache: Cache = { get: () => 'hit' }
    const provided = await TestBed.create(UserService, { metadata, provide: { ...provide, [T.Cache]: cache } })
    expect(provided.instance.cache).toBe(cache)
  })

  it('multi dependencies are empty unless members are provided', async () => {
    const { instance } = await TestBed.create(UserService, { metadata, provide })
    expect(instance.listeners).toEqual([])
    const listener = new AuditListener()
    const provided = await TestBed.create(UserService, { metadata, provide: { ...provide, AuditListener: listener } })
    expect(provided.instance.listeners).toEqual([listener])
    provided.mocks.get(UserRepository).findById.mockResolvedValue({ id: '1', name: 'Ada' })
    await provided.instance.findById('1')
    expect(listener.seen).toEqual([{ id: '1', name: 'Ada' }])
  })

  it('lazy dependencies resolve to the auto-mock', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide })
    const audit = mocks.get(AuditService)
    audit.record.mockReturnValue('recorded')
    expect(instance.track('login')).toBe('recorded')
    expect(audit.record).toHaveBeenCalledWith('login')
    expect((instance.audit as Lazy<AuditService>).get()).toBe(audit)
  })

  it('the same dependency always gets the same value', async () => {
    const twice = defineTestMetadata({
      providers: [{ token: 'src/pair.ts#Pair', deps: [Database, { lazy: Database }], factory: d => d }],
    })
    const { instance } = await TestBed.create<unknown[]>('Pair', { metadata: twice })
    const [direct, lazy] = instance as [Database, Lazy<Database>]
    expect(lazy.get()).toBe(direct)
  })

  it('@Provides values without qualifier and qualified classes are auto-mocked', async () => {
    class Pool {
      query(): number {
        return 1
      }
    }
    class Replica {}
    const factories = defineTestMetadata({
      providers: [
        { token: 'src/db.ts#DbFactory.pool', factory: () => new Pool() },
        { class: Replica, name: 'replica' },
        { token: 'src/consumer.ts#Consumer', deps: ['src/db.ts#DbFactory.pool', Replica], factory: d => d },
      ],
    })
    const { instance, mocks } = await TestBed.create<[Pool, Replica]>('Consumer', { metadata: factories })
    expect(isMock(instance[0])).toBe(true)
    expect(instance[1]).toBeInstanceOf(Replica)
    expect(mocks.get<Pool>('DbFactory.pool').query.mock).toBeDefined()
  })

  it('request-scoped externals (HttpContext) are auto-mocked, no scope needed', async () => {
    const scoped = createMetadata(
      { 'src/me.ts#Me': { scope: 'request', deps: [T.HttpContext], factory: d => ({ context: d[0] }) } },
      { externals: [{ token: T.HttpContext, scope: 'request', providedBy: 'HttpPlugin' }] },
    )
    const { instance, mocks } = await TestBed.create<{ context: unknown }>('Me', { metadata: scoped })
    expect(instance.context).toBe(mocks.get('HttpContext'))
  })

  it('unknown tokens (not declared anywhere) are auto-mocked', async () => {
    const loose = defineTestMetadata({
      providers: [{ token: 'src/a.ts#A', deps: ['@acme/lib#Thing'], factory: d => d }],
    })
    const { instance, mocks } = await TestBed.create<unknown[]>('A', { metadata: loose })
    expect(instance[0]).toBe(mocks.get('Thing'))
  })

  it('invalid dependency references are reported', async () => {
    const broken = createMetadata({
      'src/a.ts#A': { scope: 'singleton', deps: [{ nope: true } as never], factory: () => 1 },
    })
    const error = await rejection(TestBed.create('A', { metadata: broken }))
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
  })
})

describe('TestBed.create: interceptors', () => {
  it("by default (aop: 'none') interceptor dependencies are neither mocked nor applied", async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide })
    mocks.get(UserRepository).findById.mockResolvedValue({ id: '1', name: 'Ada' })
    expect(await instance.findById('1')).toEqual({ id: '1', name: 'Ada' })
    expect(mocks.has(TimingInterceptor)).toBe(false)
    expect(() => mocks.get(TimingInterceptor)).toThrow('interceptor')
    expect(Object.hasOwn(instance, 'findById')).toBe(false)
  })

  it("aop: 'real' builds the interceptor (its dependencies auto-mocked) and applies it", async () => {
    const { instance, mocks, container } = await TestBed.create(UserService, { metadata, provide, aop: 'real' })
    mocks.get(UserRepository).findById.mockResolvedValue({ id: '1', name: 'Ada' })
    expect((await instance.findById('1')) as unknown).toEqual({ intercepted: { id: '1', name: 'Ada' } })
    const interceptor = container.get(TimingInterceptor)
    expect(interceptor).toBeInstanceOf(TimingInterceptor)
    expect(interceptor.labels).toEqual(['users.find'])
    // the logger is shared by the service and the interceptor
    expect(mocks.get<Logger>('Logger').info).toHaveBeenCalledWith('users.find:start')
    expect(() => mocks.get(TimingInterceptor)).toThrow('built for real')
  })

  it("aop: 'real' uses a provided interceptor", async () => {
    const intercept = mock((invocation: { proceed(): unknown }) => invocation.proceed())
    const { instance, mocks } = await TestBed.create(UserService, {
      metadata,
      provide: { ...provide, TimingInterceptor: { intercept } },
      aop: 'real',
    })
    mocks.get(UserRepository).findById.mockResolvedValue(undefined)
    await instance.findById('1')
    expect(intercept).toHaveBeenCalledTimes(1)
  })

  it("aop: 'real' with an external interceptor requires a provided instance", async () => {
    const external = createMetadata(
      {
        'src/a.ts#A': {
          scope: 'singleton',
          class: AuditService,
          deps: ['@znight/observability#LoggedInterceptor'],
          factory: () => new AuditService(),
          interceptors: { record: { async: false, chain: [{ dep: 0 }] } },
        },
      },
      { externals: [{ token: '@znight/observability#LoggedInterceptor', providedBy: 'ObservabilityPlugin' }] },
    )
    const error = await rejection(TestBed.create(AuditService, { metadata: external, aop: 'real' }))
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('ObservabilityPlugin')
    const intercept = createSpy((invocation: { proceed(): unknown }) => `<${invocation.proceed()}>`)
    const { instance } = await TestBed.create(AuditService, {
      metadata: external,
      aop: 'real',
      overrides: [['LoggedInterceptor', { intercept }]],
    })
    expect(instance.record('x')).toBe('<x>')
  })

  it('a failing interceptor application is a ZNIGHT015', async () => {
    const invalid = createMetadata({
      'src/a.ts#A': {
        scope: 'singleton',
        class: AuditService,
        deps: ['src/i.ts#I'],
        factory: () => new AuditService(),
        interceptors: { record: { async: false, chain: [{ dep: 0 }] } },
      },
      'src/i.ts#I': { scope: 'singleton', deps: [], factory: () => ({ notAnInterceptor: true }) },
    })
    const error = await rejection(TestBed.create(AuditService, { metadata: invalid, aop: 'real' }))
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
  })

  it('rejects an unknown aop mode', async () => {
    expect(await rejection(TestBed.create(UserService, { metadata, aop: 'mock' as never }))).toBeInstanceOf(TypeError)
  })
})

describe('TestBed.create: overrides', () => {
  it('a value replaces the auto-mock', async () => {
    const logger: Logger = { info: () => undefined, error: () => undefined }
    const { instance } = await TestBed.create(UserService, { metadata, provide, overrides: { Logger: logger } })
    expect(instance.logger).toBe(logger)
  })

  it('a definition is built, its own dependencies resolved like the target ones', async () => {
    const { instance, mocks } = await TestBed.create(UserService, {
      metadata,
      provide,
      overrides: [overrideFactory(UserRepository, d => new PgUserRepository(d[0]), { deps: [T.Database] })],
    })
    expect(instance.repository).toBeInstanceOf(PgUserRepository)
    expect(isMock(instance.repository)).toBe(false)
    mocks.get(Database).query.mockResolvedValue([{ id: '1', name: 'Ada' }])
    expect(await instance.findById('1')).toEqual({ id: '1', name: 'Ada' })
    expect(() => mocks.get(UserRepository)).toThrow('replaced with `overrides`')
  })

  it('the compiled definition of a dependency can be reused to build it for real', async () => {
    const real = metadata.providers[T.PgUserRepository]
    const { instance, mocks } = await TestBed.create(UserService, {
      metadata,
      provide,
      overrides: [[UserRepository, real]],
    })
    expect(instance.repository).toBeInstanceOf(PgUserRepository)
    expect(mocks.has(Database)).toBe(true)
  })

  it('overrides win over provide', async () => {
    const { instance } = await TestBed.create(UserService, {
      metadata,
      provide: { ...provide, Logger: 'provided' },
      overrides: { Logger: 'overridden' },
    })
    expect(instance.logger as unknown).toBe('overridden')
  })

  it('a definition keyed by the target replaces its factory', async () => {
    const { instance } = await TestBed.create(UserController, {
      metadata,
      overrides: [overrideFactory(UserController, d => ({ wrapped: d[0] }) as never, { deps: [T.UserService] })],
    })
    expect(isMock((instance as unknown as { wrapped: unknown }).wrapped)).toBe(true)
  })

  it('the target cannot be replaced by a plain value', async () => {
    const error = await rejection(TestBed.create(UserController, { metadata, overrides: [[UserController, {}]] }))
    expect(error.code).toBe(ErrorCode.InvalidDecorator)
  })

  it('cyclic override definitions are reported', async () => {
    const cyclic = createMetadata({
      'src/a.ts#A': { scope: 'singleton', deps: ['src/b.ts#B'], factory: d => d },
      'src/b.ts#B': { scope: 'singleton', deps: ['src/a.ts#A'], factory: d => d },
      'src/c.ts#C': { scope: 'singleton', deps: [], factory: d => d },
    })
    // the target as a dependency of an override is auto-mocked like any other dependency
    const { instance } = await TestBed.create<unknown[]>('A', {
      metadata: cyclic,
      overrides: [overrideFactory('src/b.ts#B', d => d, { deps: ['src/a.ts#A'] })],
    })
    expect(isMock((instance[0] as unknown[])[0])).toBe(true)
    const error = await rejection(
      TestBed.create('A', {
        metadata: cyclic,
        overrides: [
          overrideFactory('src/b.ts#B', d => d, { deps: ['src/c.ts#C'] }),
          overrideFactory('src/c.ts#C', d => d, { deps: ['src/b.ts#B'] }),
        ],
      }),
    )
    expect(error.code).toBe(ErrorCode.CircularDependency)
    expect(error.message).toContain('A -> B -> C -> B')
  })
})

describe('TestBed.create: mocks registry', () => {
  it('unknown keys explain what is mocked', async () => {
    const { mocks } = await TestBed.create(UserService, { metadata, provide })
    expect(() => mocks.get(UserController)).toThrow('not a direct dependency of UserService')
    const error = thrown(() => mocks.get('Nope'))
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.hints[0]).toContain('PgUserRepository')
    expect(() => mocks.get(AppConfig)).toThrow('configuration class')
    expect(() => mocks.get('DbFactory.databaseUrl')).toThrow('`provide`')
    expect(mocks.has(UserController)).toBe(false)
    expect(mocks.has('Logger')).toBe(true)
  })

  it('a target without auto-mocked dependencies says so', async () => {
    const { mocks } = await TestBed.create(AuditService, { metadata })
    expect(mocks.tokens()).toEqual([])
    expect(thrown(() => mocks.get('Nope')).hints[0]).toContain('no auto-mocked dependency')
  })

  it('clearAll and resetAll act on every auto-mock', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide })
    const findById = mocks.get(UserRepository).findById
    findById.mockResolvedValue({ id: '1', name: 'Ada' })
    await instance.findById('1')
    mocks.clearAll()
    expect(findById).not.toHaveBeenCalled()
    expect(mocks.get<Logger>('Logger').info).not.toHaveBeenCalled()
    expect(await instance.findById('1')).toEqual({ id: '1', name: 'Ada' })
    mocks.resetAll()
    expect(findById('1')).toBeUndefined()
  })

  it('the deep option applies to every auto-mock', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata, provide, deep: true })
    expect(isMock(mocks.get(UserRepository).save({ id: '1', name: 'Ada' }))).toBe(true)
    expect(isMock(await instance.findById('1'))).toBe(true)
  })

  it('the mockFn option selects the spy implementation', async () => {
    const { mocks } = await TestBed.create(UserService, { metadata, provide, mockFn: 'builtin' })
    expect(isBuiltinSpy(mocks.get(UserRepository).findById)).toBe(true)
  })
})

describe('TestBed.create: container', () => {
  it('holds the target and every injected value', async () => {
    const { instance, mocks, container } = await TestBed.create(UserService, { metadata, provide })
    expect(container.get(UserService)).toBe(instance)
    expect(container.get(T.UserService)).toBe(instance)
    expect(container.get(UserRepository)).toBe(mocks.get(UserRepository))
    expect(container.get(PgUserRepository) as unknown).toBe(mocks.get(UserRepository))
    expect(container.get(T.Logger)).toBe(mocks.get('Logger'))
    expect(container.get(AppConfig)).toBe(instance.config)
    expect(container.get(T.DatabaseUrl)).toBe('postgres://test')
    expect(container.has(T.Cache)).toBe(false)
    expect(container.has(UserController)).toBe(false)
    await container.dispose()
  })
})

describe('TestBed.create: invalid options', () => {
  it('metadata is required', async () => {
    const missing = await rejection(TestBed.create(UserService, {} as never))
    expect(missing.code).toBe(ErrorCode.MissingProvider)
    expect(missing.hints.join()).toContain('@znight/compiler/bun')
    expect(await rejection(TestBed.create(UserService, undefined as never))).toBeInstanceOf(TypeError)
  })

  it('the metadata version must match', async () => {
    const error = await rejection(TestBed.create(UserService, { metadata: { ...metadata, version: 99 } }))
    expect(error.code).toBe(ErrorCode.VersionMismatch)
  })

  it('errors keep no suppressed cleanup errors', async () => {
    const error = await rejection(TestBed.create(UserService, { metadata }))
    expect(getSuppressedErrors(error)).toEqual([])
  })
})
