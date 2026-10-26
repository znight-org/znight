/**
 * The main positive fixture (`test/fixtures/analysis/app`): inheritance + generics, factories,
 * qualifiers, multi, Lazy, optionality forms, interfaces/abstract classes, aliases, manifests
 * (fake `@znight/observability`), interceptors and a fake compiler extension (`@znight/fake-http`).
 */
import type { FixtureAnalysis } from './helpers.ts'

import { createGenBuilders } from '../../src/extensions/generate.ts'
import { ValueRef } from '../../src/project/index.ts'
import { analyzeFixture, codes, provider } from './helpers.ts'
import { beforeAll, describe, expect, test as it } from 'bun:test'

const CLOCK = 'src/core/clock.ts'
const SYSTEM_CLOCK = `${CLOCK}#SystemClock`
const USER_SERVICE = 'src/users/user.service.ts#UserService'
const TIMING = 'src/aop/timing.interceptor.ts#TimingInterceptor'
const LOGGED = '@znight/observability#LoggedInterceptor'
const CREATE_POOL = 'src/db/db.factory.ts#DbFactory.createPool'

let result: FixtureAnalysis

beforeAll(async () => {
  result = await analyzeFixture('app')
})

describe('analysis fixture: diagnostics', () => {
  it('has no error', () => {
    expect(codes(result, 'error')).toEqual([])
  })

  it('runs the extension validate hook with the bound graph', () => {
    const warnings = result.diagnostics.filter(diagnostic => diagnostic.severity === 'warning')
    expect(warnings.map(diagnostic => diagnostic.message)).toEqual([
      'fake-http validated UserController: context="@znight/fake-http#HttpContext" clock="src/core/clock.ts#SystemClock" guards=1',
    ])
  })
})

describe('analysis fixture: providers', () => {
  it('registers every provider, sorted by token', () => {
    expect(result.graph.providers.map(node => `${node.token} ${node.kind} ${node.scope} ${node.registeredBy}`)).toEqual(
      [
        'src/aop/timing.interceptor.ts#TimingInterceptor class singleton auto',
        'src/context/request-context.ts#RequestContext class request core',
        'src/context/request-context.ts#RequestLogger class transient core',
        'src/core/clock.ts#FakeClock class singleton core',
        'src/core/clock.ts#FrozenClock class singleton core',
        'src/core/clock.ts#SystemClock class singleton core',
        'src/core/config.ts#ConfigFactory class singleton core',
        'src/core/config.ts#ConfigFactory.apiUrl provides singleton core',
        'src/core/config.ts#ConfigFactory.config provides singleton core',
        'src/core/config.ts#ConfigFactory.port provides singleton core',
        'src/db/db.factory.ts#DbFactory class singleton core',
        'src/db/db.factory.ts#DbFactory.createPool provides singleton core',
        'src/db/db.factory.ts#DbFactory.replica provides transient core',
        'src/generics/box.ts#ClockBox class singleton core',
        'src/http/app.settings.ts#AppSettings custom singleton fake-http',
        'src/http/auth.guard.ts#AuthGuard class singleton auto',
        'src/http/user.controller.ts#UserController class singleton fake-http',
        'src/naming/renamed.ts#BarrelService class transient core',
        'src/naming/renamed.ts#NamespacedService class singleton core',
        'src/plugins/plugin.ts#AlphaPlugin class singleton core',
        'src/plugins/plugin.ts#BetaPlugin class singleton core',
        'src/users/audit.service.ts#AuditService class singleton core',
        'src/users/user.repository.ts#PgUserRepository class singleton core',
        'src/users/user.service.ts#UserService class singleton core',
      ],
    )
  })

  it('binds every form of injection point of UserService', () => {
    const node = provider(result, USER_SERVICE)
    expect(node.deps.map(dep => dep.ref)).toEqual([
      'src/users/user.repository.ts#PgUserRepository', // Repository<User>, through the heritage closure
      `${CLOCK}#FakeClock`, // @Inject('fake') Clock
      '@znight/observability#Logger', // manifest external
      { multi: ['src/plugins/plugin.ts#AlphaPlugin', 'src/plugins/plugin.ts#BetaPlugin'] }, // readonly Plugin[]
      { lazy: 'src/users/audit.service.ts#AuditService' }, // Lazy<AuditService>
      { token: '@znight/observability#Tracer', optional: true }, // optional external (manifest)
      { token: 'src/users/user.service.ts#Cache', optional: true }, // cache?: Cache
      { token: 'src/users/user.service.ts#Cache', optional: true }, // Cache | undefined = undefined
      { token: 'src/users/user.service.ts#Cache', optional: true }, // default value
      { token: 'src/users/user.service.ts#Cache', optional: true }, // @Optional() Cache | null
      TIMING,
      LOGGED,
    ])
    expect(node.deps.map(dep => dep.role as string)).toEqual([
      ...Array.from({ length: 10 }, () => 'parameter'),
      'interceptor',
      'interceptor',
    ])
    expect(node.factory).toEqual({ kind: 'constructor', args: 10 })
    expect(node.deps[0]?.label).toBe("parameter 'repository' of UserService")
    expect(node.lifecycle.map(hook => hook.hook)).toEqual(['onStart'])
    expect(node.source).toEqual({ file: 'src/users/user.service.ts', line: 18, column: 14 })
  })

  it('builds interceptor chains in decorator order (top-most first)', () => {
    const node = provider(result, USER_SERVICE)
    expect(
      node.interceptors.map(method => ({
        method: method.method,
        async: method.async,
        chain: method.chain.map(link => ({
          dep: link.dep,
          token: link.token,
          hasOptions: link.hasOptions,
          options: link.options,
          decorator: link.decorator,
        })),
      })),
    ).toEqual([
      {
        method: 'count',
        async: false,
        chain: [
          {
            dep: 10,
            token: TIMING,
            hasOptions: true,
            options: expect.any(ValueRef),
            decorator: '@znight/core#Intercept',
          },
        ],
      },
      {
        method: 'findById',
        async: true,
        chain: [
          {
            dep: 11,
            token: LOGGED,
            hasOptions: true,
            options: { level: 'debug' },
            decorator: '@znight/observability#Logged',
          },
          {
            dep: 10,
            token: TIMING,
            hasOptions: true,
            options: { label: 'users.find' },
            decorator: '@znight/core#Intercept',
          },
        ],
      },
    ])
  })

  it('keeps non-evaluable interceptor options as references to exported bindings', () => {
    const count = provider(result, USER_SERVICE).interceptors.find(method => method.method === 'count')
    const options = count?.chain[0]?.options
    expect(options).toBeInstanceOf(ValueRef)
    expect((options as ValueRef).identity).toBe('src/aop/options.ts#DYNAMIC')
  })

  it('resolves inherited constructors with type-argument substitution', () => {
    const repository = provider(result, 'src/users/user.repository.ts#PgUserRepository')
    expect(repository.deps.map(dep => dep.ref)).toEqual([CREATE_POOL, SYSTEM_CLOCK])
    expect(repository.deps.map(dep => dep.label)).toEqual([
      "parameter 'pool' of PgUserRepository (inherited from BaseRepository)",
      "parameter 'clock' of PgUserRepository (inherited from BaseRepository)",
    ])
    // ClockBox extends Holder<string, Clock> extends Box<B = Clock>: constructor(value: T = Clock)
    expect(provider(result, 'src/generics/box.ts#ClockBox').deps.map(dep => dep.ref)).toEqual([SYSTEM_CLOCK])
  })

  it('analyses factories and @Provides methods', () => {
    const pool = provider(result, CREATE_POOL)
    expect(pool.factory).toEqual({ kind: 'method', method: 'createPool', args: 1 })
    expect(pool.deps.map(dep => [dep.role, dep.ref])).toEqual([
      ['factory', 'src/db/db.factory.ts#DbFactory'],
      ['parameter', 'src/core/config.ts#ConfigFactory.config'],
    ])
    expect(pool).toMatchObject({ async: true, dispose: 'end', primary: true, name: undefined, method: 'createPool' })
    expect(pool.providedType).toEqual({ kind: 'reference', identity: 'pg-lite#Pool', name: 'Pool', typeArgs: [] })
    expect(pool.classIdentity).toBe('src/db/db.factory.ts#DbFactory')

    const replica = provider(result, 'src/db/db.factory.ts#DbFactory.replica')
    expect(replica).toMatchObject({ scope: 'transient', name: 'replica', async: false, primary: false })
    expect(replica.deps.map(dep => dep.ref)).toEqual([
      'src/db/db.factory.ts#DbFactory',
      'src/core/config.ts#ConfigFactory.apiUrl', // @Inject('apiUrl') string ↔ @Named('apiUrl') string
    ])
    // @Inject('port') number ↔ @Provides({ name: PORT }) number (const reference)
    expect(provider(result, 'src/db/db.factory.ts#DbFactory').deps.map(dep => dep.ref)).toEqual([
      'src/core/config.ts#ConfigFactory.port',
    ])
    expect(provider(result, 'src/core/config.ts#ConfigFactory.port')).toMatchObject({
      name: 'port',
      providedType: { kind: 'primitive', name: 'number' },
    })
  })

  it('recognises decorators through renamed imports, barrels and namespace imports', () => {
    expect(provider(result, 'src/naming/renamed.ts#NamespacedService').scope).toBe('singleton')
    const barrel = provider(result, 'src/naming/renamed.ts#BarrelService')
    expect(barrel.scope).toBe('transient')
    expect(barrel.deps.map(dep => dep.ref)).toEqual(['src/naming/renamed.ts#NamespacedService'])
  })

  it('applies @Named / @Primary / name options', () => {
    expect(provider(result, SYSTEM_CLOCK)).toMatchObject({ primary: true, name: undefined })
    expect(provider(result, `${CLOCK}#FakeClock`)).toMatchObject({ primary: false, name: 'fake' })
    expect(provider(result, `${CLOCK}#FrozenClock`)).toMatchObject({ name: 'frozen' })
  })

  it('auto-registers helper classes referenced as interceptors and guards', () => {
    expect(provider(result, TIMING).deps.map(dep => dep.ref)).toEqual([SYSTEM_CLOCK])
    expect(provider(result, 'src/http/auth.guard.ts#AuthGuard').deps.map(dep => dep.ref)).toEqual([SYSTEM_CLOCK])
  })

  it('records class import routes', () => {
    expect(provider(result, USER_SERVICE).importRoute).toEqual({
      specifier: '../users/user.service.js',
      exportName: 'UserService',
      members: [],
      typeOnly: false,
    })
  })
})

describe('analysis fixture: externals, aliases, order', () => {
  it('lists the externals referenced by bindings and interceptors', () => {
    expect(result.graph.externals).toEqual([
      {
        token: '@znight/fake-http#HttpContext',
        displayName: 'HttpContext',
        scope: 'request',
        providedBy: 'HttpPlugin',
        optional: false,
        origin: 'manifest',
      },
      {
        token: LOGGED,
        displayName: 'LoggedInterceptor',
        scope: 'singleton',
        providedBy: 'ObservabilityPlugin',
        optional: false,
        origin: 'manifest',
      },
      {
        token: '@znight/observability#Logger',
        displayName: 'Logger',
        scope: 'singleton',
        providedBy: 'ObservabilityPlugin',
        optional: false,
        origin: 'manifest',
      },
      {
        token: '@znight/observability#Tracer',
        displayName: 'Tracer',
        scope: 'singleton',
        providedBy: 'ObservabilityPlugin',
        optional: true,
        origin: 'manifest',
      },
    ])
  })

  it('emits aliases for types bound to exactly one provider (or one primary)', () => {
    expect(result.graph.aliases).toEqual([
      { key: 'pg-lite#Pool', token: CREATE_POOL },
      { key: 'src/core/clock.ts#Clock', token: SYSTEM_CLOCK },
      { key: 'src/core/config.ts#AppConfig', token: 'src/core/config.ts#ConfigFactory.config' },
      { key: 'src/generics/box.ts#Box', token: 'src/generics/box.ts#ClockBox' },
      { key: 'src/generics/box.ts#Holder', token: 'src/generics/box.ts#ClockBox' },
      { key: 'src/users/repository.ts#BaseRepository', token: 'src/users/user.repository.ts#PgUserRepository' },
      { key: 'src/users/repository.ts#Repository', token: 'src/users/user.repository.ts#PgUserRepository' },
      { key: 'src/users/user.repository.ts#UserRepository', token: 'src/users/user.repository.ts#PgUserRepository' },
    ])
  })

  it('orders providers topologically (dependencies first, Lazy ignored, ties by token)', () => {
    const order = result.graph.resolutionOrder
    expect([...order].sort()).toEqual(result.graph.providers.map(node => node.token))
    const position = new Map(order.map((token, index) => [token, index]))
    for (const edge of result.graph.edges) {
      if (edge.kind === 'lazy' || edge.kind === 'extension' || !position.has(edge.to)) {
        continue
      }
      expect(position.get(edge.to) as number).toBeLessThan(position.get(edge.from) as number)
    }
    // UserService -> Lazy<AuditService> and AuditService -> UserService: no cycle
    expect(position.get('src/users/audit.service.ts#AuditService') as number).toBeGreaterThan(
      position.get(USER_SERVICE) as number,
    )
    expect(order.slice(0, 6)).toEqual([
      'src/context/request-context.ts#RequestContext',
      'src/context/request-context.ts#RequestLogger',
      'src/core/clock.ts#FakeClock',
      'src/core/clock.ts#FrozenClock',
      'src/core/clock.ts#SystemClock',
      TIMING,
    ])
  })

  it('records typed edges', () => {
    const fromController = result.graph.edges.filter(edge => edge.from === 'src/http/user.controller.ts#UserController')
    expect(fromController.map(edge => `${edge.kind} ${edge.to} (${edge.label})`)).toEqual([
      "extension src/core/clock.ts#SystemClock (injection of 'Clock' (extension 'fake-http'))",
      'extension src/http/auth.guard.ts#AuthGuard (guard)',
      "dependency src/users/user.service.ts#UserService (parameter 'users' of UserController)",
    ])
    const kinds = new Set(result.graph.edges.filter(edge => edge.from === USER_SERVICE).map(edge => edge.kind))
    expect([...kinds].sort()).toEqual(['dependency', 'interceptor', 'lazy', 'multi'])
    expect(result.graph.edges.find(edge => edge.from === CREATE_POOL && edge.kind === 'factory')?.to).toBe(
      'src/db/db.factory.ts#DbFactory',
    )
  })
})

describe('analysis fixture: compiler extension', () => {
  it('stores extension data in call order (classes by identity)', () => {
    expect(result.graph.extensions).toEqual([
      {
        name: 'fake-http',
        stored: [
          { kind: 'settings', token: 'src/http/app.settings.ts#AppSettings', keys: ['APP_NAME', 'APP_DEBUG'] },
          {
            kind: 'controller',
            token: 'src/http/user.controller.ts#UserController',
            basePath: '/users',
            guards: ['src/http/auth.guard.ts#AuthGuard'],
            routes: [{ handler: 'get', path: '/:id', params: [{ name: 'id', type: 'string' }] }],
            context: 1,
            clock: 2,
          },
        ],
      },
    ])
    expect(result.extensions.map(entry => [entry.extension.name, entry.origin, entry.packageName])).toEqual([
      ['fake-http', 'package', '@znight/fake-http'],
    ])
  })

  it('resolves bindInjection requests', () => {
    expect(result.graph.bindings.get(1)).toBe('@znight/fake-http#HttpContext')
    expect(result.graph.bindings.get(2)).toBe(SYSTEM_CLOCK)
  })

  it('registers custom factories with bound dependencies', () => {
    const settings = provider(result, 'src/http/app.settings.ts#AppSettings')
    expect(settings.kind).toBe('custom')
    expect(settings.deps.map(dep => [dep.ref, dep.label])).toEqual([
      ['@znight/observability#Logger', 'logger of AppSettings'],
    ])
    if (settings.factory.kind !== 'custom') {
      throw new Error('expected a custom factory')
    }
    expect(settings.factory.args).toBe(1)
    const builders = createGenBuilders()
    const importFrom = (module: string, name: string) =>
      Object.freeze({ kind: 'gen:import' as const, target: { kind: 'module' as const, module, name }, typeOnly: false })
    const node = settings.factory.generate({ ...builders, importFrom } as never, {
      cls: builders.lit('cls'),
      deps: [builders.lit('dep')],
    })
    expect(node).toMatchObject({
      kind: 'gen:call',
      callee: { kind: 'gen:import', target: { module: '@znight/fake-http', name: 'load' } },
      args: [{ value: 'cls' }, { value: 'dep' }],
    })
  })
})
