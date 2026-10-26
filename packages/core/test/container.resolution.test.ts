import { Container, CoreTokens, ErrorCode, ZnightError } from '../src/index.ts'
import { caught, caughtSync, classDef, factoryDef, meta, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class Database {
  readonly url = 'memory://'
}

class UserRepository {
  readonly db: Database
  constructor(db: Database) {
    this.db = db
  }
}

abstract class Repository {}

class PgRepository extends Repository {}

function create(): Container {
  return Container.create(
    meta(
      {
        [t('Database')]: classDef(Database),
        [t('UserRepository')]: classDef(UserRepository, [t('Database')]),
        [t('PgRepository')]: classDef(PgRepository),
      },
      { aliases: { 'src/repository.ts#Repository': t('PgRepository') } },
    ),
  )
}

describe('Container.create', () => {
  it('rejects unsupported metadata versions with ZNIGHT018', () => {
    const error = caughtSync(() => Container.create(meta({}, { version: 2 })))
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.VersionMismatch)
    expect((error as ZnightError).message).toContain('version 2')
    expect((error as ZnightError).message).toContain('@znight/compiler 0.1.0')
    expect((error as ZnightError).hints.length).toBeGreaterThan(0)
  })

  it('rejects objects that are not metadata', () => {
    const error = caughtSync(() => Container.create({} as never))
    expect((error as ZnightError).code).toBe(ErrorCode.VersionMismatch)
    expect((caughtSync(() => Container.create(null as never)) as ZnightError).code).toBe(ErrorCode.VersionMismatch)
  })

  it('rejects malformed provider definitions (ZNIGHT005)', () => {
    const error = caughtSync(() => Container.create(meta({ [t('A')]: { scope: 'singleton', deps: [] } as never })))
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidDecorator)
    expect((error as ZnightError).message).toContain('A (src/app.ts#A)')
  })

  it('rejects async factories on non-singletons (ZNIGHT014)', () => {
    const error = caughtSync(() =>
      Container.create(meta({ [t('A')]: factoryDef(async () => 1, [], { scope: 'request', async: true }) })),
    )
    expect((error as ZnightError).code).toBe(ErrorCode.AsyncNonSingleton)
  })

  it('exposes the metadata and registers itself', async () => {
    const metadata = meta({})
    const container = Container.create(metadata)
    expect(container.metadata).toBe(metadata)
    expect(container.get(CoreTokens.Container)).toBe(container)
    expect(container.get(Container)).toBe(container)
    await container.init()
    expect(container.get(Container)).toBe(container)
  })

  it('ignores resolutionOrder entries that are not providers', async () => {
    const container = Container.create(
      meta({ [t('Database')]: classDef(Database) }, { order: ['src/ghost.ts#Ghost', t('Database')] }),
    )
    await container.init()
    expect(container.get(Database)).toBeInstanceOf(Database)
  })
})

describe('get', () => {
  it('resolves by class, token, alias and unique display name', async () => {
    const container = create()
    await container.init()
    const repository = container.get(UserRepository)
    expect(repository).toBeInstanceOf(UserRepository)
    expect(container.get(t('UserRepository'))).toBe(repository)
    expect(container.get('UserRepository')).toBe(repository)
    expect(container.get<Repository>('src/repository.ts#Repository')).toBe(container.get(PgRepository))
    expect(container.get('Repository')).toBe(container.get(PgRepository))
    expect(repository.db).toBe(container.get(Database))
  })

  it('resolves an abstract class through the alias sharing its name', async () => {
    const container = create()
    await container.init()
    expect(container.get(Repository)).toBe(container.get(PgRepository))
    expect(container.tokenOf(Repository)).toBe(t('PgRepository'))
  })

  it('does not match a same-named class of an unrelated hierarchy', async () => {
    const container = create()
    await container.init()
    const Other = class Database {}
    expect(caughtSync(() => container.get(Other))).toBeInstanceOf(ZnightError)
  })

  it('prefers the class hierarchy over a same-named external (abstract port behind an alias)', async () => {
    abstract class Logger {
      abstract log(message: string): void
    }
    class ConsoleLogger extends Logger {
      log(): void {}
    }
    const observability = '@znight/observability#Logger'
    for (const bound of [true, false]) {
      const container = Container.create(
        meta(
          {
            'src/console-logger.ts#ConsoleLogger': classDef(ConsoleLogger),
            [t('Audit')]: factoryDef(d => ({ logger: d[0] }), [{ token: observability, optional: true }]),
          },
          {
            aliases: { 'src/ports.ts#Logger': 'src/console-logger.ts#ConsoleLogger' },
            externals: [{ token: observability, providedBy: 'ObservabilityPlugin', optional: true }],
          },
        ),
      )
      if (bound) container.registerValue(observability, { info: () => undefined })
      await container.init()
      expect(container.get(Logger)).toBeInstanceOf(ConsoleLogger)
      expect(container.has(Logger)).toBe(true)
      expect(container.tokenOf(Logger)).toBe('src/console-logger.ts#ConsoleLogger')
    }
  })

  it('does not match a built-in of another class sharing the name', async () => {
    const container = create()
    await container.init()
    const UserContainer = class Container {}
    expect(container.getOptional(UserContainer)).toBeUndefined()
    expect(container.has(UserContainer)).toBe(false)
    expect((caughtSync(() => container.get(UserContainer)) as ZnightError).code).toBe(ErrorCode.MissingProvider)
  })

  it('matches a value by its class before a same-named external of unknown class', async () => {
    class Clock {}
    class SystemClock extends Clock {}
    const container = Container.create(meta({}, { externals: [{ token: '@acme/time#Clock', optional: true }] }))
    container.registerValue('src/clock.ts#Clock', new SystemClock())
    await container.init()
    expect(container.get(Clock)).toBeInstanceOf(SystemClock)
  })

  it('keeps resolving an abstract class whose implementation was overridden with a plain fake', async () => {
    const container = create()
    const fake = { fake: true }
    container.override(PgRepository, fake as never)
    container.registerValue('src/other.ts#Repository', new (class Repository {})())
    await container.init()
    expect(container.get(Repository)).toBe(fake)
  })

  it('resolves a class key through an alias to a class-less provider, before and after its creation', async () => {
    abstract class DatabaseClient {}
    const client = { query: () => [] } // structural: not an instance of DatabaseClient
    const container = Container.create(
      meta(
        { [t('Db.client')]: factoryDef(() => client), [t('Root')]: factoryDef(() => 'root') },
        { aliases: { 'src/db.ts#DatabaseClient': t('Db.client') } },
      ),
    )
    await container.init({ only: [t('Root')] })
    expect(container.has(DatabaseClient)).toBe(true)
    expect(container.get(DatabaseClient)).toBe(client)
    expect(container.get(DatabaseClient)).toBe(client)
  })

  it('resolves a class key to an `implements` fake overriding a class-less provider', async () => {
    abstract class Mailer {
      abstract send(to: string): void
    }
    class FakeMailer implements Mailer {
      send(): void {}
    }
    const fake = new FakeMailer() // structural: not an instance of Mailer
    const container = Container.create(
      meta(
        { [t('Mail.mailer')]: factoryDef(() => ({ send: () => undefined })) },
        {
          aliases: { 'src/mailer.ts#Mailer': t('Mail.mailer') },
        },
      ),
    )
    container.override(Mailer, fake)
    await container.init()
    expect(container.get(Mailer)).toBe(fake)
  })

  it('still reports ZNIGHT008 when several candidates belong to the class hierarchy', async () => {
    abstract class Store {}
    class MemoryStore extends Store {}
    class RedisStore extends Store {}
    const container = Container.create(
      meta(
        { 'src/memory.ts#MemoryStore': classDef(MemoryStore), 'src/redis.ts#RedisStore': classDef(RedisStore) },
        {
          aliases: { 'src/a.ts#Store': 'src/memory.ts#MemoryStore', 'src/b.ts#Store': 'src/redis.ts#RedisStore' },
          externals: [{ token: '@acme/store#Store', optional: true }],
        },
      ),
    )
    await container.init()
    const error = caughtSync(() => container.get(Store)) as ZnightError
    expect(error.code).toBe(ErrorCode.AmbiguousInjection)
    expect(error.message).toContain('MemoryStore')
    expect(error.message).toContain('RedisStore')
    expect(error.message).not.toContain('@acme/store#Store')
    expect(container.has(Store)).toBe(false)
  })

  it('throws ZNIGHT008 listing candidates for an ambiguous display name', async () => {
    const container = Container.create(
      meta({ 'src/a.ts#Logger': factoryDef(() => 'a'), 'src/b.ts#Logger': factoryDef(() => 'b') }),
    )
    await container.init()
    const error = caughtSync(() => container.get('Logger')) as ZnightError
    expect(error.code).toBe(ErrorCode.AmbiguousInjection)
    expect(error.message).toContain('src/a.ts#Logger')
    expect(error.message).toContain('src/b.ts#Logger')
    expect(container.get('src/a.ts#Logger')).toBe('a')
    expect(container.has('Logger')).toBe(false)
    expect(caughtSync(() => container.getOptional('Logger'))).toBeInstanceOf(ZnightError)
  })

  it('throws ZNIGHT001 for unknown tokens and classes, with hints', async () => {
    const container = create()
    await container.init()
    const byToken = caughtSync(() => container.get('src/nope.ts#Nope')) as ZnightError
    expect(byToken.code).toBe(ErrorCode.MissingProvider)
    expect(byToken.message).toContain('Nope (src/nope.ts#Nope)')
    class NotAProvider {}
    const byClass = caughtSync(() => container.get(NotAProvider)) as ZnightError
    expect(byClass.code).toBe(ErrorCode.MissingProvider)
    expect(byClass.hints.join(' ')).toContain('@Injectable()')
  })

  it('throws ZNIGHT015 when resolving providers before init()', () => {
    const container = create()
    const error = caughtSync(() => container.get(Database)) as ZnightError
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.message).toContain('not initialised')
  })

  it('returns registered values before init()', () => {
    const container = create()
    container.registerValue('@acme/clock#Clock', { now: () => 1 })
    expect(container.get<{ now(): number }>('@acme/clock#Clock').now()).toBe(1)
  })

  it('keeps returning the same singleton instance', async () => {
    const container = create()
    await container.init()
    expect(container.get(Database)).toBe(container.get(Database))
  })

  it('reports a failed initialisation on later resolutions', async () => {
    const container = Container.create(
      meta({
        [t('Database')]: factoryDef(() => {
          throw new Error('boom')
        }),
        [t('Lazy')]: factoryDef(() => 'lazy', [], { scope: 'transient' }),
      }),
    )
    await caught(() => container.init())
    const error = caughtSync(() => container.get(t('Lazy'))) as ZnightError
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.message).toContain('failed to initialise')
  })
})

describe('getOptional / has / tokenOf', () => {
  it('getOptional returns undefined for unknown keys and resolves known ones', async () => {
    const container = create()
    await container.init()
    expect(container.getOptional('src/nope.ts#Nope')).toBeUndefined()
    expect(container.getOptional(class Unknown {})).toBeUndefined()
    expect(container.getOptional(Database)).toBe(container.get(Database))
    expect(container.getOptional('UserRepository')).toBe(container.get(UserRepository))
  })

  it('getOptional returns undefined for unregistered optional externals and missing externals', async () => {
    const container = Container.create(
      meta({}, { externals: [{ token: '@x/y#Opt', optional: true }, { token: '@x/y#Req' }] }),
    )
    await container.init()
    expect(container.getOptional('@x/y#Opt')).toBeUndefined()
    expect(container.getOptional('@x/y#Req')).toBeUndefined()
    expect((caughtSync(() => container.get('@x/y#Req')) as ZnightError).code).toBe(ErrorCode.MissingProvider)
    expect(container.get('@x/y#Opt')).toBeUndefined()
  })

  it('has() reports bound keys', async () => {
    const container = create()
    expect(container.has(Database)).toBe(true)
    expect(container.has('Database')).toBe(true)
    expect(container.has('src/repository.ts#Repository')).toBe(true)
    expect(container.has('src/nope.ts#Nope')).toBe(false)
    expect(container.has(class Nope {})).toBe(false)
    await container.init()
    expect(container.has(Database)).toBe(true)
  })

  it('tokenOf() maps classes, aliases and display names to canonical tokens', () => {
    const container = create()
    expect(container.tokenOf(UserRepository)).toBe(t('UserRepository'))
    expect(container.tokenOf('src/repository.ts#Repository')).toBe(t('PgRepository'))
    expect(container.tokenOf('UserRepository')).toBe(t('UserRepository'))
    expect(container.tokenOf(class Nope {})).toBeUndefined()
    expect(container.tokenOf(Container)).toBe(CoreTokens.Container)
  })

  it('follows alias chains', async () => {
    const container = Container.create(
      meta(
        { [t('Impl')]: factoryDef(() => 'impl') },
        { aliases: { 'src/a.ts#A': 'src/b.ts#B', 'src/b.ts#B': t('Impl') } },
      ),
    )
    await container.init()
    expect(container.get('src/a.ts#A')).toBe('impl')
    expect(container.get('A')).toBe('impl')
  })
})
