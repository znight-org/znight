import type { ConfigFieldDefinition, ConfigMetadata, ConfigProblem } from '../src/index.ts'

import { ErrorCode } from '@znight/core'

import {
  ConfigValidationError,
  createConfigSource,
  loadConfig,
  resolveFields,
  SECRET_MASK,
  validateConfigs,
} from '../src/index.ts'
import { caught, field, source } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class AppConfig {
  host!: string
  port!: number
  debug = false
  tags?: string[]
}

const appFields: readonly ConfigFieldDefinition[] = [
  field('host', 'string', { env: 'APP_HOST', key: 'app.host' }),
  field('port', 'number', { env: 'APP_PORT', key: 'app.port', default: 3000, required: false }),
  field('debug', 'boolean', { env: 'APP_DEBUG', key: 'app.debug', required: false }),
  field('tags', 'string[]', { env: 'APP_TAGS', key: 'app.tags', required: false }),
]

describe('loadConfig', () => {
  it('instantiates the class and assigns coerced values', () => {
    const config = loadConfig(
      AppConfig,
      source({ APP_HOST: 'example.com', APP_PORT: '8080', APP_DEBUG: 'yes', APP_TAGS: 'a,b' }),
      appFields,
    )
    expect(config).toBeInstanceOf(AppConfig)
    expect(config).toEqual(
      Object.assign(new AppConfig(), { host: 'example.com', port: 8080, debug: true, tags: ['a', 'b'] }),
    )
  })

  it('applies defaults and keeps initializers when nothing is set', () => {
    const config = loadConfig(AppConfig, source({ APP_HOST: 'h' }), appFields)
    expect(config.port).toBe(3000)
    expect(config.debug).toBe(false)
    expect(config.tags).toBeUndefined()
  })

  it('assigns with define semantics (setters are bypassed, properties stay enumerable)', () => {
    class WithSetter {
      calls = 0
      set value(_value: string) {
        this.calls++
      }
    }
    const config = loadConfig(WithSetter, source({ VALUE: 'x' }), [field('value')])
    expect(config.calls).toBe(0)
    expect(Object.getOwnPropertyDescriptor(config, 'value')).toEqual({
      value: 'x',
      writable: true,
      enumerable: true,
      configurable: true,
    })
  })

  it('uses options.name in messages', async () => {
    const error = await caught(() => loadConfig(AppConfig, source({}), appFields, { name: 'Renamed' }))
    expect(error.message).toContain('Renamed.host')
  })

  describe('precedence', () => {
    const fields = [
      field('host', 'string', { env: 'DB_HOST', key: 'database.host', default: 'default-host', required: false }),
    ]

    class Db {
      host = 'initializer-host'
    }

    it('environment name > key path > default > initializer', () => {
      const all = createConfigSource([
        { origin: 'file', values: { database: { host: 'file-host' } } },
        { origin: 'env', values: { DB_HOST: 'env-host' } },
      ])
      expect(loadConfig(Db, all, fields).host).toBe('env-host')
      expect(loadConfig(Db, source({ database: { host: 'file-host' } }), fields).host).toBe('file-host')
      expect(loadConfig(Db, source({ 'database.host': 'flat-key' }), fields).host).toBe('flat-key')
      expect(loadConfig(Db, source({}), fields).host).toBe('default-host')
      const withoutDefault = [field('host', 'string', { env: 'DB_HOST', key: 'database.host', required: false })]
      expect(loadConfig(Db, source({}), withoutDefault).host).toBe('initializer-host')
    })

    it('the environment name wins even when it comes from an earlier layer', () => {
      const layered = createConfigSource([
        { origin: '.env', values: { DB_HOST: 'dotenv-host' } },
        { origin: 'config.json', values: { database: { host: 'json-host' } } },
      ])
      expect(loadConfig(Db, layered, fields).host).toBe('dotenv-host')
    })

    it('a flat environment-like key in a structured file matches the env name', () => {
      expect(loadConfig(Db, source({ DB_HOST: 'from-secret-json' }), fields).host).toBe('from-secret-json')
    })

    it('blank values fall back for non-string types only', () => {
      class Server {
        port = 1
        name = 'initial'
      }
      const serverFields = [
        field('port', 'number', { default: 3000, required: false }),
        field('name', 'string', { required: false }),
      ]
      const config = loadConfig(Server, source({ PORT: '  ', NAME: '' }), serverFields)
      expect(config.port).toBe(3000)
      expect(config.name).toBe('')
    })

    it('coerces defaults like source values', () => {
      class Remote {
        url!: URL
        retries!: number
      }
      const config = loadConfig(Remote, source({}), [
        field('url', 'url', { default: 'https://api.example.com/v1', required: false }),
        field('retries', 'number', { default: '5', required: false }),
      ])
      expect(config.url).toBeInstanceOf(URL)
      expect(config.url.href).toBe('https://api.example.com/v1')
      expect(config.retries).toBe(5)
    })

    it('a value identical for env and key is looked up once', () => {
      const looked: string[] = []
      const spy = {
        get: (key: string) => {
          looked.push(key)
          return undefined
        },
        has: () => false,
        keys: () => [],
        origin: () => undefined,
      }
      class Plain {
        port = 1
      }
      loadConfig(Plain, spy, [field('port', 'number', { env: 'port', key: 'port', required: false })])
      expect(looked).toEqual(['port'])
    })
  })

  describe('validation', () => {
    it('aggregates every problem of the class in one ZNIGHT006 error', async () => {
      class Db {
        host!: string
        port!: number
        mode!: string
        url!: URL
      }
      const error = await caught(() =>
        loadConfig(
          Db,
          createConfigSource([
            { origin: '.env.local', values: { DB_PORT: 'abc' } },
            { origin: 'process.env', values: { DB_MODE: 'test' } },
            { origin: 'config.json', values: { database: { url: 'localhost' } } },
          ]),
          [
            field('host', 'string', { env: 'DB_HOST', key: 'database.host' }),
            field('port', 'number', { env: 'DB_PORT', key: 'database.port' }),
            field('mode', 'string', { env: 'DB_MODE', key: 'database.mode', enum: ['dev', 'prod'] }),
            field('url', 'url', { env: 'DB_URL', key: 'database.url' }),
          ],
        ),
      )
      expect(error).toBeInstanceOf(ConfigValidationError)
      const validation = error as ConfigValidationError
      expect(validation.code).toBe(ErrorCode.MissingConfig)
      expect(validation.name).toBe('ConfigValidationError')
      expect(validation.message).toBe(
        [
          'ZNIGHT006: Invalid configuration: 4 problems',
          '  - Db.host: missing required value; set DB_HOST (or key "database.host")',
          '  - Db.port: expected a number but got "abc" (DB_PORT from .env.local)',
          '  - Db.mode: expected one of "dev", "prod" but got "test" (DB_MODE from process.env)',
          '  - Db.url: expected an absolute URL but got "localhost" (database.url from config.json)',
        ].join('\n'),
      )
      expect(validation.problems.map(problem => [problem.property, problem.kind])).toEqual([
        ['host', 'missing'],
        ['port', 'invalid'],
        ['mode', 'invalid'],
        ['url', 'invalid'],
      ])
      expect(validation.problems[1]).toEqual({
        config: 'Db',
        property: 'port',
        env: 'DB_PORT',
        key: 'database.port',
        kind: 'invalid',
        message: 'expected a number but got "abc"',
        name: 'DB_PORT',
        origin: '.env.local',
      } satisfies ConfigProblem)
      expect(Object.isFrozen(validation.problems)).toBe(true)
      expect(validation.hints).toContain(
        'Configuration sources (lowest to highest precedence): .env.local < process.env < config.json',
      )
    })

    it('reports a missing value once with both names', async () => {
      const error = await caught(() => loadConfig(AppConfig, source({}), appFields))
      expect((error as ConfigValidationError).problems).toHaveLength(1)
      expect(error.message).toContain('AppConfig.host: missing required value; set APP_HOST (or key "app.host")')
    })

    it('shows a single name when env and key are equal', async () => {
      class Single {
        port!: number
      }
      const error = await caught(() =>
        loadConfig(Single, source({}), [field('port', 'number', { env: 'PORT', key: 'PORT' })]),
      )
      expect(error.message).toEndWith('Single.port: missing required value; set PORT')
    })

    it('does not fall back to a lower precedence when a value is invalid', async () => {
      class Db {
        port = 1
      }
      const layered = createConfigSource([
        { origin: 'file', values: { database: { port: 5432 } } },
        { origin: 'env', values: { PORT: 'nope' } },
      ])
      const error = await caught(() =>
        loadConfig(Db, layered, [field('port', 'number', { key: 'database.port', required: false })]),
      )
      expect(error.message).toContain('Db.port: expected a number but got "nope" (PORT from env)')
    })

    it('reports invalid defaults', async () => {
      class Broken {
        port!: number
      }
      const error = await caught(() =>
        loadConfig(Broken, source({}), [field('port', 'number', { default: 'eighty', required: false })]),
      )
      expect(error.message).toContain(
        'Broken.port: invalid default value: expected a number but got "eighty" (@Default)',
      )
    })

    it('a required field satisfied by an initializer is not missing', () => {
      class Initialized {
        retries = 3
      }
      expect(loadConfig(Initialized, source({}), [field('retries', 'number')]).retries).toBe(3)
    })

    it('rejects malformed field definitions with ZNIGHT012', async () => {
      class Empty {}
      const cases: [unknown, string][] = [
        [{}, 'expected an array of field definitions'],
        [[null], 'field #0 of Empty: expected an object'],
        [[{ ...field('a'), property: '' }], '"property" must be a non-empty string'],
        [[{ ...field('a'), env: 1 }], '"env" of "a" must be a non-empty string'],
        [[{ ...field('a'), key: '' }], '"key" of "a" must be a non-empty string'],
        [[{ ...field('a'), type: 'date' }], 'unsupported type "date" for "a"'],
        [[{ ...field('a'), enum: 'x' }], '"enum" of "a" must be an array'],
        [[field('a'), field('a')], 'property "a" is defined twice'],
      ]
      for (const [fields, message] of cases) {
        const error = await caught(() => loadConfig(Empty, source({}), fields as ConfigFieldDefinition[]))
        expect(error.message).toContain(message)
        expect((error as { code?: string }).code).toBe(ErrorCode.InvalidConfig)
      }
    })
  })

  describe('without ConfigSource', () => {
    it('reads process.env', () => {
      process.env.ZNIGHT_LOAD_TEST_PORT = '9090'
      try {
        class Server {
          port!: number
        }
        const config = loadConfig(Server, undefined, [field('port', 'number', { env: 'ZNIGHT_LOAD_TEST_PORT' })])
        expect(config.port).toBe(9090)
      } finally {
        delete process.env.ZNIGHT_LOAD_TEST_PORT
      }
    })

    it('reads options.env and hints at ConfigPlugin on failure', async () => {
      class Server {
        port!: number
      }
      const fields = [field('port', 'number')]
      expect(loadConfig(Server, undefined, fields, { env: { PORT: '1' } }).port).toBe(1)
      const error = await caught(() => loadConfig(Server, undefined, fields, { env: {} }))
      expect((error as ConfigValidationError).hints.some(hint => hint.includes('ConfigPlugin.configure()'))).toBe(true)
    })
  })

  describe('secrets', () => {
    it('never shows secret values in error messages', async () => {
      class Secrets {
        port!: number
      }
      const error = await caught(() =>
        loadConfig(Secrets, source({ SECRET_PORT: 'hunter2' }), [
          field('port', 'number', { env: 'SECRET_PORT', secret: true }),
        ]),
      )
      expect(error.message).not.toContain('hunter2')
      expect(error.message).toContain(`got ${SECRET_MASK}`)
    })
  })
})

describe('resolveFields', () => {
  it('collects values and problems without instantiating anything', () => {
    const result = resolveFields(
      'Thing',
      [field('a'), field('b', 'number'), field('c', 'number', { required: false })],
      source({ A: 'x', B: 'y' }),
    )
    expect([...result.values]).toEqual([['a', 'x']])
    expect(result.problems.map(problem => `${problem.property}:${problem.kind}`)).toEqual(['b:invalid'])
  })

  it('consults hasInitializer for fields without value', () => {
    const result = resolveFields('Thing', [field('a')], source({}), property => property === 'a')
    expect(result.problems).toEqual([])
    expect(result.values.size).toBe(0)
  })
})

describe('validateConfigs', () => {
  const metadata = (config: ConfigMetadata | undefined) => ({ extensions: config === undefined ? {} : { config } })

  it('reports the problems of every config class at once', async () => {
    const error = await caught(() =>
      validateConfigs(
        metadata({
          configs: [
            { token: 'src/app.config.ts#AppConfig', prefix: 'app', fields: appFields },
            {
              token: 'src/db.config.ts#DbConfig',
              fields: [field('password', 'string', { env: 'DB_PASSWORD', key: 'db.password', secret: true })],
            },
          ],
        }),
        source({ APP_PORT: 'x' }, 'process.env'),
      ),
    )
    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error.message).toBe(
      [
        'ZNIGHT006: Invalid configuration: 3 problems',
        '  - AppConfig.host: missing required value; set APP_HOST (or key "app.host")',
        '  - AppConfig.port: expected a number but got "x" (APP_PORT from process.env)',
        '  - DbConfig.password: missing required value; set DB_PASSWORD (or key "db.password")',
      ].join('\n'),
    )
  })

  it('uses tokens when display names collide', async () => {
    const error = await caught(() =>
      validateConfigs(
        metadata({
          configs: [
            { token: 'src/a/config.ts#Config', fields: [field('a')] },
            { token: 'src/b/config.ts#Config', fields: [field('b')] },
          ],
        }),
        source({}),
      ),
    )
    expect(error.message).toContain('src/a/config.ts#Config.a')
    expect(error.message).toContain('src/b/config.ts#Config.b')
  })

  it('passes when every value is valid, without metadata or with no config', () => {
    expect(() =>
      validateConfigs(
        metadata({ configs: [{ token: 'src/app.ts#AppConfig', fields: appFields }] }),
        source({ APP_HOST: 'h' }),
      ),
    ).not.toThrow()
    expect(() => validateConfigs({}, source({}))).not.toThrow()
    expect(() => validateConfigs(metadata(undefined), source({}))).not.toThrow()
    expect(() => validateConfigs(metadata({ configs: [] }), source({}))).not.toThrow()
  })

  it('rejects malformed config metadata with ZNIGHT012', async () => {
    for (const config of [{}, { configs: 'x' }, { configs: [null] }, { configs: [{ fields: [] }] }, 'x']) {
      const error = await caught(() => validateConfigs({ extensions: { config: config as never } }, source({})))
      expect((error as { code?: string }).code).toBe(ErrorCode.InvalidConfig)
    }
  })
})
