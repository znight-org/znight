/**
 * End-to-end: fixture application → compile → generated module written next to the sources →
 * imported under Bun → `Application.create({ metadata })` from `@znight/core` → real behaviour.
 */
import type { ZnightMetadata } from '@znight/core'

import { Application, Container } from '@znight/core'

import { fixtureRoot, generateFixture } from './helpers.ts'
import { LITERALS, webExtension } from './web-extension.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

interface LoggingModule {
  readonly Logger: new (lines?: string[]) => { readonly lines: string[] }
  readonly RequestId: new (value: string) => { readonly value: string }
  readonly LoggedInterceptor: new (logger: unknown) => object
}

// biome-ignore lint/suspicious/noExplicitAny: fixture instances are untyped from the test's point of view
type Any = any

/** `container.get()` of an untyped fixture class or token. */
const get = (container: Container, key: unknown): Any => container.get(key as never)

const root = fixtureRoot('app')
const LOGGER = '@fixture/logging#Logger'
const REQUEST_ID = '@fixture/logging#RequestId'
const LOGGED = '@fixture/logging#LoggedInterceptor'

describe('end-to-end: core features', () => {
  let metadata: ZnightMetadata
  let events: string[]
  let logging: LoggingModule
  // biome-ignore lint/suspicious/noExplicitAny: fixture modules are untyped from the test's point of view
  let source: Record<string, any>

  beforeAll(async () => {
    const result = await generateFixture('app')
    expect(result.diagnostics).toEqual([])
    metadata = (await import(result.outFile)).__ZNIGHT_METADATA__
    events = (await import(`${root}/src/events.ts`)).events
    logging = (await import(`${root}/node_modules/@fixture/logging/index.js`)) as LoggingModule
    source = {
      ...(await import(`${root}/src/clock.ts`)),
      ...(await import(`${root}/src/plugins.ts`)),
      ...(await import(`${root}/src/request.ts`)),
      ...(await import(`${root}/src/scheduler.ts`)),
      ...(await import(`${root}/src/infra/database.ts`)),
      ...(await import(`${root}/src/aop/timing.interceptor.ts`)),
      ...(await import(`${root}/src/users/repository.ts`)),
      ...(await import(`${root}/src/users/user.service.ts`)),
      ...(await import(`${root}/src/users/audit.service.ts`)),
    }
  })

  async function createApp(): Promise<{ app: Application; lines: string[] }> {
    const lines: string[] = []
    const logger = new logging.Logger(lines)
    const app = await Application.create({
      metadata,
      providers: [
        [LOGGER, logger],
        [LOGGED, new logging.LoggedInterceptor(logger)],
      ],
      shutdown: { signals: false },
    })
    return { app, lines }
  }

  let current: Application | undefined
  afterAll(async () => {
    await current?.stop()
  })

  it('exports typed metadata with the compiler version', () => {
    expect(metadata.version).toBe(1)
    expect(typeof metadata.compiler).toBe('string')
    expect(metadata.resolutionOrder.length).toBe(Object.keys(metadata.providers).length)
  })

  it('creates singletons once, through constructors and @Provides factories (async included)', async () => {
    const { app } = await createApp()
    current = app
    const container = app.container
    const service = get(container, source.UserService)
    expect(get(container, source.UserService)).toBe(service)
    const database = get(container, source.Database)
    expect(database).toBeInstanceOf(source.Database)
    expect(database.url).toBe('db://localhost:8080')
    expect(get(container, 'src/infra/infra.factory.ts#InfraFactory.port')).toBe(8080)
    expect(events).toContain('Database.open')
  })

  it('binds interfaces, base classes and generics through aliases and inherited constructors', () => {
    const container = (current as Application).container
    const service = get(container, source.UserService)
    const repository = get(container, source.UserRepository)
    expect(service.repository).toBe(repository)
    expect(get(container, source.BaseRepository)).toBe(repository)
    expect(get(container, 'src/users/repository.ts#Repository')).toBe(repository)
    expect(repository.database).toBe(get(container, source.Database))
    expect(repository.clock).toBeInstanceOf(source.SystemClock)
    expect(get(container, 'src/clock.ts#Clock')).toBeInstanceOf(source.SystemClock)
  })

  it('honours qualifiers, multi, optional, Lazy and externals', () => {
    const container = (current as Application).container
    const service = get(container, source.UserService)
    expect(service.clock).toBeInstanceOf(source.FixedClock)
    expect(service.clock.now()).toBe(42)
    expect(service.plugins.map((plugin: { name(): string }) => plugin.name())).toEqual(['alpha', 'beta'])
    expect(service.cache).toBeUndefined()
    expect(service.logger).toBe(get(container, LOGGER))
    const audit = service.audit.get()
    expect(audit).toBeInstanceOf(source.AuditService)
    expect(audit.users).toBe(service)
  })

  it('applies interceptors (top-most outermost) including auto-registered and manifest ones', async () => {
    const container = (current as Application).container
    const service = get(container, source.UserService)
    const lines = get(container, LOGGER).lines as string[]
    events.length = 0
    lines.length = 0
    get(container, source.UserRepository).seed({ id: '1', name: 'Ada' })
    expect(service.find('1')).toEqual({ id: '1', name: 'Ada' })
    expect(events).toEqual(['timing:find:find'])
    expect(lines).toEqual(['log:find'])
    expect(service.audit.get().entries).toEqual(['find 1'])
    expect(await service.count()).toBe(2)
    expect(events).toEqual(['timing:find:find', 'timing:count:count'])
    expect(get(container, source.TimingInterceptor).clock).toBeInstanceOf(source.SystemClock)
  })

  it('scopes request providers per runInScope and creates transients per injection', async () => {
    const container = (current as Application).container
    const reporter = get(container, source.Reporter)
    expect(reporter.first).not.toBe(reporter.second)
    expect(reporter.first).toBeInstanceOf(source.Counter)
    const [a, b, viaLazy] = await container.runInScope(
      (): Any[] => [get(container, source.RequestState), get(container, source.RequestState), reporter.state.get()],
      [[REQUEST_ID, new logging.RequestId('r1')]],
    )
    expect(a).toBe(b)
    expect(viaLazy).toBe(a)
    expect(a.requestId.value).toBe('r1')
    const other = await container.runInScope(
      (): Any => get(container, source.RequestState),
      [[REQUEST_ID, new logging.RequestId('r2')]],
    )
    expect(other).not.toBe(a)
    expect(other.requestId.value).toBe('r2')
    expect(() => get(container, source.RequestState)).toThrow('ZNIGHT013')
  })

  it('runs lifecycle hooks in resolution order and disposes in reverse', async () => {
    const app = current as Application
    events.length = 0
    await app.start()
    expect(events).toEqual(['UserService.onStart', 'Scheduler.onStart', 'UserService.onReady'])
    events.length = 0
    await app.stop()
    current = undefined
    expect(events).toEqual(['Scheduler.onStop', 'UserService.onStop', 'Database.close'])
  })

  it('reports missing externals at boot, naming the plugin', async () => {
    const container = Container.create(metadata)
    await expect(container.init()).rejects.toThrow('LoggingPlugin')
  })
})

describe('end-to-end: import naming', () => {
  it('imports colliding, default, aliased, unicode and quoted bindings and instantiates them', async () => {
    const result = await generateFixture('naming')
    const metadata = (await import(result.outFile)).__ZNIGHT_METADATA__ as ZnightMetadata
    const app = await Application.create({ metadata, shutdown: { signals: false } })
    const consumer: { all: { origin?: string; kind?: string }[] } = get(app.container, 'src/consumer.ts#Consumer')
    expect(consumer.all.map(item => item.origin ?? item.kind)).toEqual([
      'a',
      'b',
      'zz',
      'user-date',
      'user-url',
      'user-metadata',
      'd',
      'default',
      'internal',
      'unicode',
      "it's",
      'thing',
    ])
    expect(get(app.container, "src/it's/weird.ts#Thing")).toBe(consumer.all[11])
    await app.stop()
  })
})

describe('end-to-end: compiler extension', () => {
  it('generates custom factories, shared constants, typed invokers and every literal kind', async () => {
    const result = await generateFixture('web', { extensions: [webExtension] })
    expect(result.diagnostics).toEqual([])
    const metadata = (await import(result.outFile)).__ZNIGHT_METADATA__ as ZnightMetadata
    const web = await import(`${fixtureRoot('web')}/node_modules/@fixture/web/index.js`)
    const lines: string[] = []
    const app = await Application.create({
      metadata,
      providers: [['@fixture/web#Logger', new web.Logger(lines)]],
      shutdown: { signals: false },
    })
    const section = metadata.extensions?.web as {
      controllers: {
        token: string
        guards: string[]
        routes: { fullPath: string; pattern: RegExp; schema?: unknown; invoke: (c: unknown, ctx: unknown) => unknown }[]
      }[]
      settings: { token: string; fields: { property: string; env: string; default?: unknown }[] }[]
      literals: Record<string, unknown>
    }
    const [controller] = section.controllers
    if (!controller) {
      throw new Error('no controller')
    }
    const instance = get(app.container, controller.token)
    const [find, count] = controller.routes
    expect(find?.fullPath).toBe('/users/:id')
    expect(find?.pattern.exec('/users/7')?.[1]).toBe('7')
    expect(find?.invoke(instance, { params: { id: '7' } })).toBe('user 7')
    expect(() => find?.invoke(instance, { params: {} })).toThrow('invalid param "id"')
    expect(count?.invoke(instance, { params: {} })).toBe(2)
    const schemas = await import(`${fixtureRoot('web')}/src/schemas.ts`)
    expect(find?.schema).toBe(schemas.UserSchema)
    expect(count && 'schema' in count).toBe(false)
    expect(get(app.container, controller.guards[0] as string).allows()).toBe(true)

    const settings = get(app.container, 'src/settings.ts#AppSettings')
    expect(settings).toMatchObject({ name: 'default-name', port: 0 })
    expect(lines).toEqual(['built AppSettings'])
    expect(section.settings[0]?.fields).toEqual([
      { property: 'name', env: 'APP_NAME', default: 'default-name' },
      { property: 'port', env: 'APP_PORT', default: 0 },
    ])

    const literals = section.literals
    expect(Number.isNaN(literals.nan)).toBe(true)
    expect(literals.infinity).toBe(Number.POSITIVE_INFINITY)
    expect(literals.negativeInfinity).toBe(Number.NEGATIVE_INFINITY)
    expect(Object.is(literals.negativeZero, -0)).toBe(true)
    expect(literals.big).toBe(12345678901234567890n)
    expect(literals.date).toEqual(new Date(0))
    expect(literals.regexp).toEqual(/a\/b[']/gi)
    expect(literals.text).toBe(LITERALS.text)
    expect(literals.nested).toEqual([undefined, null, { 'weird key': true, "it's": [1, 2] }])
    expect(Object.keys(literals.proto as object)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(literals.proto)).toBe(Object.prototype)
    await app.stop()
  })
})
