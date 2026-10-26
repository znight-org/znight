import { Container, ErrorCode, token, type ZnightError } from '../src/index.ts'
import { caught, caughtSync, classDef, factoryDef, meta, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class Mailer {
  readonly kind: string = 'smtp'
}

class Notifier {
  readonly mailer: Mailer
  constructor(mailer: Mailer) {
    this.mailer = mailer
  }
}

const LOGGER = '@znight/observability#Logger'

function create(): Container {
  return Container.create(
    meta(
      {
        [t('Mailer')]: classDef(Mailer),
        [t('Notifier')]: classDef(Notifier, [t('Mailer')]),
      },
      {
        aliases: { 'src/mail.ts#MailPort': t('Mailer') },
        externals: [{ token: LOGGER, providedBy: 'ObservabilityPlugin' }],
      },
    ),
  )
}

describe('precedence', () => {
  it('application providers replace compiled providers', async () => {
    const container = create()
    const fake = { kind: 'fake' }
    container.provide(Mailer, fake as Mailer)
    await container.init()
    expect(container.get(Mailer)).toBe(fake)
    expect(container.get(Notifier).mailer).toBe(fake)
  })

  it('plugin registrations supersede application providers', async () => {
    const container = create()
    container.provide(LOGGER, 'from-app')
    container.registerValue(LOGGER, 'from-plugin')
    await container.init()
    expect(container.get(LOGGER)).toBe('from-plugin')
  })

  it('application providers registered after a plugin are ignored', async () => {
    const container = create()
    container.registerValue(LOGGER, 'from-plugin')
    container.provide(LOGGER, 'from-app')
    await container.init()
    expect(container.get(LOGGER)).toBe('from-plugin')
  })

  it('overrides supersede everything, whatever the order', async () => {
    const container = create()
    container.override(LOGGER, 'override')
    container.registerValue(LOGGER, 'plugin')
    container.provide(LOGGER, 'app')
    await container.init()
    expect(container.get(LOGGER)).toBe('override')
  })

  it('registerValue on a compiled token throws ZNIGHT004', () => {
    const container = create()
    const error = caughtSync(() => container.registerValue(t('Mailer'), new Mailer())) as ZnightError
    expect(error.code).toBe(ErrorCode.DuplicateProvider)
    expect(error.message).toContain('compiled provider')
    expect(error.hints.join(' ')).toContain('override')
    expect((caughtSync(() => container.register(t('Mailer'), classDef(Mailer))) as ZnightError).code).toBe(
      ErrorCode.DuplicateProvider,
    )
  })

  it('registerValue through an alias of a compiled provider throws too', () => {
    const container = create()
    expect((caughtSync(() => container.registerValue('src/mail.ts#MailPort', 1)) as ZnightError).code).toBe(
      ErrorCode.DuplicateProvider,
    )
  })

  it('registerValue on an overridden compiled token is ignored', async () => {
    const container = create()
    const fake = new Mailer()
    container.override(Mailer, fake)
    container.registerValue(t('Mailer'), new Mailer())
    await container.init()
    expect(container.get(Mailer)).toBe(fake)
  })

  it('registering the same token twice at plugin level throws ZNIGHT004 naming the first registration', () => {
    const container = create()
    container.registerValue(LOGGER, 1)
    const error = caughtSync(() => container.registerValue(LOGGER, 2)) as ZnightError
    expect(error.code).toBe(ErrorCode.DuplicateProvider)
    expect(error.message).toContain('container.register()')
  })

  it('providing the same token twice at application level throws ZNIGHT004', () => {
    const container = create()
    container.provide(LOGGER, 1)
    expect((caughtSync(() => container.provide(LOGGER, 2)) as ZnightError).code).toBe(ErrorCode.DuplicateProvider)
  })

  it('a later override replaces an earlier one', async () => {
    const container = create()
    container.override(LOGGER, 1)
    container.override(LOGGER, 2)
    await container.init()
    expect(container.get(LOGGER)).toBe(2)
  })
})

describe('override', () => {
  it('resolves aliases first', async () => {
    const container = create()
    const fake = { kind: 'fake' } as Mailer
    container.override('src/mail.ts#MailPort', fake)
    await container.init()
    expect(container.get(Mailer)).toBe(fake)
    expect(container.get(Notifier).mailer).toBe(fake)
  })

  it('accepts a provider definition (any scope, with dependencies)', async () => {
    const container = create()
    let created = 0
    container.override(Notifier, {
      scope: 'transient',
      deps: [t('Mailer')],
      factory: d => {
        created++
        return new Notifier(d[0])
      },
    })
    await container.init()
    const first = container.get(Notifier)
    const second = container.get(Notifier)
    expect(first).not.toBe(second)
    expect(first.mailer).toBe(container.get(Mailer))
    expect(created).toBe(2)
  })

  it('rejects unknown classes with ZNIGHT001', () => {
    const container = create()
    class Unknown {}
    expect((caughtSync(() => container.override(Unknown, new Unknown())) as ZnightError).code).toBe(
      ErrorCode.MissingProvider,
    )
  })

  it('may introduce new tokens', async () => {
    const container = create()
    container.override('src/new.ts#Feature', 42)
    await container.init()
    expect(container.get('Feature')).toBe(42)
  })
})

describe('register (runtime definitions)', () => {
  it('registers definitions depending on compiled tokens, ordered before their dependents', async () => {
    const order: string[] = []
    const container = Container.create(
      meta(
        {
          [t('Service')]: factoryDef(d => order.push(`service(${String(d[0])})`), [LOGGER]),
        },
        { externals: [{ token: LOGGER }] },
      ),
    )
    container.register(LOGGER, {
      scope: 'singleton',
      deps: [t('Clock')],
      factory: d => {
        order.push('logger')
        return `logger@${String(d[0])}`
      },
    })
    container.register(t('Clock'), {
      scope: 'singleton',
      deps: [],
      factory: () => {
        order.push('clock')
        return 'clock'
      },
    })
    await container.init()
    expect(order).toEqual(['clock', 'logger', 'service(logger@clock)'])
  })

  it('validates definitions (ZNIGHT005, ZNIGHT014)', () => {
    const container = create()
    expect((caughtSync(() => container.register('x', { scope: 'nope' } as never)) as ZnightError).code).toBe(
      ErrorCode.InvalidDecorator,
    )
    expect(
      (
        caughtSync(() =>
          container.register('x', { scope: 'transient', deps: [], factory: async () => 1, async: true }),
        ) as ZnightError
      ).code,
    ).toBe(ErrorCode.AsyncNonSingleton)
  })

  it('typed tokens check registered values at compile time', () => {
    const container = create()
    const Port = token<number>('@acme/port#Port')
    container.registerValue(Port, 8080)
    const port: number = container.get(Port)
    expect(port).toBe(8080)
    // @ts-expect-error the value must be a number (the override still applies at runtime)
    container.override(Port, 'http')
    expect(container.get(Port) as unknown).toBe('http')
  })

  it('registerExternal declares request-scoped externals for runtime definitions', async () => {
    const container = create()
    container.registerExternal({ token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' })
    container.register('@znight/http#RequestId', {
      scope: 'request',
      deps: ['@znight/http#HttpContext'],
      factory: d => `req-${(d[0] as { id: string }).id}`,
    })
    await container.init()
    const id = await container.runInScope(
      () => container.get('@znight/http#RequestId'),
      [['@znight/http#HttpContext', { id: '7' }]],
    )
    expect(id).toBe('req-7')
  })
})

describe('sealing', () => {
  it('rejects every registration after init() with ZNIGHT016', async () => {
    const container = create()
    const init = container.init()
    const attempts: (() => void)[] = [
      () =>
        container.register(
          'x',
          factoryDef(() => 1),
        ),
      () => container.registerValue('x', 1),
      () => container.provide('x', 1),
      () => container.override(Mailer, new Mailer()),
      () => container.registerExternal({ token: 'x' }),
    ]
    for (const attempt of attempts) {
      const error = caughtSync(attempt) as ZnightError
      expect(error.code).toBe(ErrorCode.ContainerSealed)
      expect(error.hints.length).toBeGreaterThan(0)
    }
    await init
  })

  it('stays sealed when init() fails', async () => {
    const container = Container.create(meta({ [t('A')]: factoryDef(() => 1, [LOGGER]) }))
    await caught(() => container.init())
    expect((caughtSync(() => container.registerValue(LOGGER, 1)) as ZnightError).code).toBe(ErrorCode.ContainerSealed)
  })

  it('init() is idempotent', async () => {
    let calls = 0
    const container = Container.create(meta({ [t('A')]: factoryDef(() => ++calls) }))
    const first = container.init()
    expect(container.init()).toBe(first)
    await first
    await container.init()
    expect(calls).toBe(1)
  })
})
