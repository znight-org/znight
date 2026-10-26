import {
  Application,
  type ApplicationOptions,
  Container,
  type CoreLogger,
  CoreTokens,
  ErrorCode,
  getSuppressedErrors,
  Hooks,
  type Plugin,
  type PluginContext,
  type PluginOptions,
  resolveOptions,
  silentLogger,
  ZnightAggregateError,
  ZnightError,
} from '../src/index.ts'
import { caught, classDef, factoryDef, memoryLogger, meta, sleep, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const LOGGER = '@znight/observability#Logger'

type Hook = 'register' | 'onBootstrap' | 'onStart' | 'onReady' | 'onStop' | 'onDispose'
const HOOKS: readonly Hook[] = ['register', 'onBootstrap', 'onStart', 'onReady', 'onStop', 'onDispose']

/** A plugin recording its hooks in `log`; `impl` replaces some of them. */
function plugin(
  name: string,
  log: string[],
  impl: Partial<Record<Hook, (ctx: PluginContext) => unknown>> = {},
): Plugin {
  const result: Record<string, unknown> = { name }
  for (const hook of HOOKS) {
    result[hook] = async (ctx: PluginContext) => {
      log.push(`${name}.${hook}`)
      await impl[hook]?.(ctx)
    }
  }
  return result as unknown as Plugin
}

function lifecycle(name: string, log: string[], extra: Record<string, unknown> = {}): object {
  return {
    name,
    onStart: () => log.push(`${name}.onStart`),
    onReady: () => log.push(`${name}.onReady`),
    onStop: () => log.push(`${name}.onStop`),
    [Symbol.asyncDispose]: async () => log.push(`${name}.dispose`),
    ...extra,
  }
}

function providersMeta(log: string[]) {
  return meta(
    {
      [t('Db')]: factoryDef(() => {
        log.push('Db.create')
        return lifecycle('Db', log)
      }),
      [t('Repo')]: factoryDef(() => {
        log.push('Repo.create')
        return lifecycle('Repo', log)
      }, [t('Db'), LOGGER]),
    },
    { order: [t('Db'), t('Repo')], externals: [{ token: LOGGER, providedBy: 'ObservabilityPlugin' }] },
  )
}

function options(log: string[], extra: Partial<ApplicationOptions> = {}): ApplicationOptions {
  return {
    metadata: providersMeta(log),
    plugins: [plugin('a', log, { register: ctx => ctx.container.registerValue(LOGGER, 'logger') }), plugin('b', log)],
    logger: silentLogger,
    shutdown: { signals: false },
    ...extra,
  }
}

describe('Application.create', () => {
  it('runs providers → register → overrides → init → onBootstrap', async () => {
    const log: string[] = []
    const app = await Application.create({
      metadata: providersMeta(log),
      providers: [['@acme/config#Config', 'from-app']],
      plugins: [
        plugin('a', log, {
          register: ctx => {
            log.push(`config=${String(ctx.container.get('@acme/config#Config'))}`)
            ctx.container.registerValue(LOGGER, 'plugin-logger')
          },
          onBootstrap: ctx => log.push(`repo=${(ctx.container.get(t('Repo')) as { name: string }).name}`),
        }),
      ],
      overrides: { [LOGGER]: 'override-logger' },
      logger: silentLogger,
      shutdown: { signals: false },
    })
    expect(log).toEqual(['a.register', 'config=from-app', 'Db.create', 'Repo.create', 'a.onBootstrap', 'repo=Repo'])
    expect(app.get(LOGGER)).toBe('override-logger')
    expect(app.state).toBe('created')
  })

  it('accepts providers as a Map, pairs or a record, keyed by token or class', async () => {
    class Settings {
      readonly value: string = 'compiled'
    }
    const metadata = meta({ [t('Settings')]: classDef(Settings) })
    const fake = { value: 'fake' }
    const shared = { logger: silentLogger, shutdown: { signals: false as const } }
    const fromMap = await Application.create({ metadata, providers: new Map([[Settings, fake]]), ...shared })
    const fromPairs = await Application.create({ metadata, providers: [[t('Settings'), fake]], ...shared })
    const fromRecord = await Application.create({ metadata, providers: { [t('Settings')]: fake }, ...shared })
    for (const app of [fromMap, fromPairs, fromRecord]) expect(app.get(Settings)).toBe(fake)
  })

  it('registers itself, its hooks, its logger and the container as built-ins', async () => {
    const seen: unknown[] = []
    const metadata = meta({
      [t('Consumer')]: factoryDef(
        d => seen.push(...d),
        [CoreTokens.Application, CoreTokens.Hooks, CoreTokens.Logger, CoreTokens.Container],
      ),
    })
    const app = await Application.create({ metadata, logger: silentLogger, shutdown: { signals: false } })
    expect(seen).toEqual([app, app.hooks, app.logger, app.container])
    expect(app.get(Application)).toBe(app)
    expect(app.get(Hooks)).toBe(app.hooks)
    expect(app.get(Container)).toBe(app.container)
  })

  it('lets application providers replace a built-in', async () => {
    const custom = memoryLogger()
    const app = await Application.create({
      metadata: meta({}),
      providers: [[CoreTokens.Logger, custom]],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    expect(app.get(CoreTokens.Logger)).toBe(custom)
  })

  it('forwards init options (only the closure is instantiated)', async () => {
    const log: string[] = []
    await Application.create(options(log, { init: { only: [t('Db')] } }))
    expect(log).toContain('Db.create')
    expect(log).not.toContain('Repo.create')
  })

  it('rejects duplicate and invalid plugins', async () => {
    const log: string[] = []
    const duplicate = (await caught(() =>
      Application.create(options(log, { plugins: [plugin('x', log), plugin('x', log)] })),
    )) as ZnightError
    expect(duplicate.code).toBe(ErrorCode.DuplicateProvider)
    expect(duplicate.message).toContain('"x"')
    const invalid = (await caught(() => Application.create(options(log, { plugins: [{ name: '' }] })))) as ZnightError
    expect(invalid).toBeInstanceOf(ZnightError)
    expect(log).toEqual([])
  })

  it('rejects invalid shutdown options', async () => {
    const error = (await caught(() =>
      Application.create(options([], { shutdown: { signals: false, timeoutMs: -1 } })),
    )) as ZnightError
    expect(error.message).toContain('shutdown.timeoutMs')
  })

  it('rejects metadata with an unsupported version', async () => {
    const error = (await caught(() =>
      Application.create({ metadata: meta({}, { version: 99 }), logger: silentLogger }),
    )) as ZnightError
    expect(error.code).toBe(ErrorCode.VersionMismatch)
  })

  it('names the plugin in duplicate registrations', async () => {
    const log: string[] = []
    const error = (await caught(() =>
      Application.create(
        options(log, {
          plugins: [
            plugin('first', log, { register: ctx => ctx.container.registerValue(LOGGER, 1) }),
            plugin('second', log, { register: ctx => ctx.container.registerValue(LOGGER, 2) }),
          ],
        }),
      ),
    )) as ZnightError
    expect(error.code).toBe(ErrorCode.DuplicateProvider)
    expect(error.message).toContain('plugin "first"')
  })
})

describe('Application.create failures (transactional rollback)', () => {
  it('wraps plugin errors in ZNIGHT021 and disposes registered plugins in reverse order', async () => {
    const log: string[] = []
    const cause = new TypeError('cannot connect')
    const error = (await caught(() =>
      Application.create(
        options(log, {
          plugins: [
            plugin('a', log),
            plugin('b', log, {
              register: () => {
                throw cause
              },
            }),
            plugin('c', log),
          ],
        }),
      ),
    )) as ZnightError
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.message).toContain('Plugin "b" register() failed: cannot connect')
    expect(error.cause).toBe(cause)
    expect(log).toEqual(['a.register', 'b.register', 'b.onDispose', 'a.onDispose'])
  })

  it('propagates Znight errors from plugins unchanged', async () => {
    const original = new ZnightError(ErrorCode.MissingConfig, 'DB_URL is missing')
    const error = await caught(() =>
      Application.create(
        options([], {
          plugins: [
            plugin('config', [], {
              register: () => {
                throw original
              },
            }),
          ],
        }),
      ),
    )
    expect(error).toBe(original)
  })

  it('disposes plugins when the container fails to initialise', async () => {
    const log: string[] = []
    const error = (await caught(() => Application.create(options(log, { plugins: [plugin('a', log)] })))) as ZnightError
    expect(error.code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('provided by ObservabilityPlugin')
    expect(log).toEqual(['a.register', 'a.onDispose'])
  })

  it('disposes created singletons when onBootstrap fails and attaches cleanup errors', async () => {
    const log: string[] = []
    const error = (await caught(() =>
      Application.create(
        options(log, {
          plugins: [
            plugin('a', log, { register: ctx => ctx.container.registerValue(LOGGER, 'l') }),
            plugin('b', log, {
              onBootstrap: () => {
                throw new Error('routes are invalid')
              },
              onDispose: () => {
                throw new Error('cannot release b')
              },
            }),
          ],
        }),
      ),
    )) as ZnightError
    expect(error.message).toContain('Plugin "b" onBootstrap() failed: routes are invalid')
    expect(log).toEqual([
      'a.register',
      'b.register',
      'Db.create',
      'Repo.create',
      'a.onBootstrap',
      'b.onBootstrap',
      'Repo.dispose',
      'Db.dispose',
      'b.onDispose',
      'a.onDispose',
    ])
    const suppressed = getSuppressedErrors(error) as ZnightError[]
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]?.message).toContain('cannot release b')
  })
})

describe('start / stop', () => {
  it('starts providers then plugins, then signals readiness', async () => {
    const log: string[] = []
    const app = await Application.create(options(log))
    log.length = 0
    const starting = app.start()
    expect(app.state).toBe('starting')
    expect(app.start()).toBe(starting)
    await starting
    expect(app.state).toBe('ready')
    expect(log).toEqual([
      'Db.onStart',
      'Repo.onStart',
      'a.onStart',
      'b.onStart',
      'Db.onReady',
      'Repo.onReady',
      'a.onReady',
      'b.onReady',
    ])
    await app.start()
    expect(log).toHaveLength(8)
  })

  it('stops in three phases, in reverse order', async () => {
    const log: string[] = []
    const app = await Application.create(options(log))
    await app.start()
    log.length = 0
    const stopping = app.stop()
    expect(app.state).toBe('stopping')
    expect(app.stop()).toBe(stopping)
    await stopping
    expect(app.state).toBe('stopped')
    expect(log).toEqual([
      'b.onStop',
      'a.onStop',
      'Repo.onStop',
      'Repo.dispose',
      'Db.onStop',
      'Db.dispose',
      'b.onDispose',
      'a.onDispose',
    ])
    await app.stop()
    expect(log).toHaveLength(8)
  })

  it('only disposes when stopped before being started', async () => {
    const log: string[] = []
    const app = await Application.create(options(log))
    log.length = 0
    await app.stop()
    expect(log).toEqual(['Repo.dispose', 'Db.dispose', 'b.onDispose', 'a.onDispose'])
  })

  it('cannot be restarted', async () => {
    const app = await Application.create(options([]))
    await app.start()
    await app.stop()
    const error = (await caught(() => app.start())) as ZnightError
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.message).toContain('stopped')
  })

  it('waits for an in-progress start before stopping', async () => {
    const log: string[] = []
    const app = await Application.create(
      options(log, {
        plugins: [
          plugin('slow', log, {
            register: ctx => ctx.container.registerValue(LOGGER, 'l'),
            onStart: () => sleep(20),
          }),
        ],
      }),
    )
    log.length = 0
    const start = app.start()
    await sleep(1)
    await app.stop()
    await start
    expect(log.indexOf('slow.onReady')).toBeLessThan(log.indexOf('slow.onStop'))
    expect(app.state).toBe('stopped')
  })

  it('stops what was started when a provider onStart fails', async () => {
    const log: string[] = []
    const app = await Application.create({
      ...options(log),
      metadata: meta(
        {
          [t('Db')]: factoryDef(() => lifecycle('Db', log)),
          [t('Repo')]: factoryDef(
            () =>
              lifecycle('Repo', log, {
                onStart: () => {
                  throw new Error('migration failed')
                },
              }),
            [t('Db')],
          ),
        },
        { order: [t('Db'), t('Repo')] },
      ),
      plugins: [plugin('a', log)],
    })
    log.length = 0
    const error = (await caught(() => app.start())) as ZnightError
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.message).toContain('Repo.onStart() failed: migration failed')
    expect(app.state).toBe('failed')
    expect(log).toEqual(['Db.onStart', 'Repo.dispose', 'Db.onStop', 'Db.dispose', 'a.onDispose'])
    await app.stop()
    expect(app.state).toBe('failed')
  })

  it('stops started plugins when a plugin onStart fails', async () => {
    const log: string[] = []
    const app = await Application.create(
      options(log, {
        plugins: [
          plugin('a', log, { register: ctx => ctx.container.registerValue(LOGGER, 'l') }),
          plugin('b', log, {
            onStart: () => {
              throw new Error('port in use')
            },
          }),
        ],
      }),
    )
    log.length = 0
    const error = (await caught(() => app.start())) as ZnightError
    expect(error.message).toContain('Plugin "b" onStart() failed: port in use')
    expect(log).toEqual([
      'Db.onStart',
      'Repo.onStart',
      'a.onStart',
      'b.onStart',
      'a.onStop',
      'Repo.onStop',
      'Repo.dispose',
      'Db.onStop',
      'Db.dispose',
      'b.onDispose',
      'a.onDispose',
    ])
  })

  it('aggregates shutdown failures (ZNIGHT021) and still runs every step', async () => {
    const log: string[] = []
    const app = await Application.create(
      options(log, {
        plugins: [
          plugin('a', log, {
            register: ctx => ctx.container.registerValue(LOGGER, 'l'),
            onStop: () => {
              throw new Error('drain failed')
            },
          }),
          plugin('b', log, {
            onDispose: () => {
              throw new ZnightError(ErrorCode.LifecycleFailed, 'flush failed')
            },
          }),
        ],
      }),
    )
    await app.start()
    log.length = 0
    const error = (await caught(() => app.stop())) as ZnightAggregateError
    expect(error).toBeInstanceOf(ZnightAggregateError)
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.errors).toHaveLength(2)
    expect(error.message).toContain('Plugin "a" onStop() failed: drain failed')
    expect(error.message).toContain('Plugin "b" onDispose() failed')
    expect(((error.errors[1] as ZnightError).cause as Error).message).toContain('flush failed')
    expect(app.state).toBe('stopped')
    expect(log).toEqual([
      'b.onStop',
      'a.onStop',
      'Repo.onStop',
      'Repo.dispose',
      'Db.onStop',
      'Db.dispose',
      'b.onDispose',
      'a.onDispose',
    ])
  })

  it('times out hanging steps and keeps going', async () => {
    const log: string[] = []
    const app = await Application.create(
      options(log, {
        shutdown: { signals: false, hookTimeoutMs: 30, timeoutMs: 1000 },
        plugins: [
          plugin('a', log, {
            register: ctx => ctx.container.registerValue(LOGGER, 'l'),
            onStop: () => new Promise(() => {}),
          }),
        ],
      }),
    )
    await app.start()
    log.length = 0
    const started = performance.now()
    const error = (await caught(() => app.stop())) as ZnightAggregateError
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(25)
    expect(elapsed).toBeLessThan(500)
    expect(error.errors).toHaveLength(1)
    expect((error.errors[0] as ZnightError).message).toContain('Plugin "a" onStop() timed out after 30ms')
    expect(log).toEqual(['a.onStop', 'Repo.onStop', 'Repo.dispose', 'Db.onStop', 'Db.dispose', 'a.onDispose'])
  })

  it('enforces the global deadline across steps', async () => {
    const log: string[] = []
    const hang = () => new Promise(() => {})
    const app = await Application.create(
      options(log, {
        shutdown: { signals: false, hookTimeoutMs: 40, timeoutMs: 60 },
        plugins: [
          plugin('a', log, { register: ctx => ctx.container.registerValue(LOGGER, 'l'), onStop: hang }),
          plugin('b', log, { onStop: hang, onDispose: hang }),
        ],
      }),
    )
    await app.start()
    log.length = 0
    const started = performance.now()
    const error = (await caught(() => app.stop())) as ZnightAggregateError
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(150)
    expect(error.errors.length).toBe(3)
    // every step was still attempted (synchronous parts ran)
    expect(log).toContain('a.onDispose')
    expect(log).toContain('Db.dispose')
  })

  it('awaits async provider hooks', async () => {
    const log: string[] = []
    const app = await Application.create({
      ...options(log),
      metadata: meta({
        [t('Service')]: factoryDef(() => ({
          onStart: async () => {
            await sleep(5)
            log.push('Service.started')
          },
          onStop: async () => {
            await sleep(5)
            log.push('Service.stopped')
          },
        })),
      }),
      plugins: [plugin('p', log)],
    })
    await app.start()
    await app.stop()
    expect(log.indexOf('Service.started')).toBeLessThan(log.indexOf('p.onStart'))
    expect(log.indexOf('p.onStop')).toBeLessThan(log.indexOf('Service.stopped'))
  })
})

describe('plugins', () => {
  it('receive a shared context with getPlugin', async () => {
    interface HttpPlugin extends Plugin {
      readonly port: number
    }
    const http: HttpPlugin = { name: 'http', port: 3000 }
    let found: HttpPlugin | undefined
    let context: PluginContext | undefined
    const app = await Application.create({
      metadata: meta({}),
      logger: silentLogger,
      shutdown: { signals: false },
      plugins: [
        http,
        {
          name: 'consumer',
          onBootstrap(ctx) {
            found = ctx.getPlugin<HttpPlugin>('http')
            context = ctx
          },
        },
      ],
    })
    expect(found?.port).toBe(3000)
    expect(context?.app).toBe(app)
    expect(context?.container).toBe(app.container)
    expect(context?.hooks).toBe(app.hooks)
    expect(context?.metadata).toBe(app.metadata)
    expect(context?.getPlugin('missing')).toBeUndefined()
    expect(app.getPlugin('http')).toBe(http)
    expect(app.plugins.map(p => p.name)).toEqual(['http', 'consumer'])
  })

  it('can compute their options from the container in onBootstrap', async () => {
    class AppConfig {
      readonly port = 8080
    }
    const configure = (options: PluginOptions<{ port: number }>): Plugin & { port?: number } => {
      const result: Plugin & { port?: number } = {
        name: 'http',
        onBootstrap(ctx) {
          result.port = resolveOptions(options, ctx.container).port
        },
      }
      return result
    }
    const metadata = meta({ [t('AppConfig')]: classDef(AppConfig) })
    const dynamic = configure(c => ({ port: c.get(AppConfig).port }))
    const fixed = configure({ port: 1 })
    await Application.create({ metadata, plugins: [dynamic], logger: silentLogger, shutdown: { signals: false } })
    await Application.create({ metadata, plugins: [fixed], logger: silentLogger, shutdown: { signals: false } })
    expect(dynamic.port).toBe(8080)
    expect(fixed.port).toBe(1)
  })

  it('share a live logger that follows setLogger()', async () => {
    const first = memoryLogger()
    const second = memoryLogger()
    let captured: CoreLogger | undefined
    const app = await Application.create({
      metadata: meta({}),
      logger: first,
      shutdown: { signals: false },
      plugins: [
        {
          name: 'p',
          register(ctx) {
            captured = ctx.logger
          },
        },
      ],
    })
    captured?.info('before')
    app.setLogger(second)
    captured?.info('after')
    app.logger.warn('direct')
    expect(first.entries.map(entry => entry.message)).toEqual(['before'])
    expect(second.entries.map(entry => entry.message)).toEqual(['after', 'direct'])
    expect(app.get(CoreTokens.Logger)).toBe(app.logger)
  })

  it('report hook listener failures through the application logger', async () => {
    const logger = memoryLogger()
    const app = await Application.create({ metadata: meta({}), logger, shutdown: { signals: false } })
    const hooks = app.hooks as unknown as {
      on(name: string, fn: () => void): void
      emit(name: string, e: unknown): void
    }
    hooks.on('custom', () => {
      throw new Error('listener failed')
    })
    hooks.emit('custom', {})
    expect(logger.entries.some(entry => entry.level === 'error')).toBe(true)
  })
})

describe('hot module replacement', () => {
  it('stops the application when the module is disposed', async () => {
    let dispose: (() => void) | undefined
    const app = await Application.create({
      ...options([]),
      hot: {
        dispose(callback) {
          dispose = () => callback(undefined)
        },
      },
    })
    await app.start()
    dispose?.()
    await sleep(5)
    expect(app.state).toBe('stopped')
  })
})
