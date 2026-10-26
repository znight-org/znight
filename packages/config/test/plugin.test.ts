import type { ConfigFieldDefinition, ConfigLoader, ConfigPluginInstance, ConfigSource } from '../src/index.ts'

import {
  Application,
  type CoreLogger,
  ErrorCode,
  InstantiationError,
  type LogContext,
  silentLogger,
  type ZnightError,
  type ZnightMetadata,
} from '@znight/core'

import {
  CONFIG_SOURCE_TOKEN,
  ConfigPlugin,
  ConfigTokens,
  ConfigValidationError,
  dotenv,
  env,
  inline,
  loadConfig,
} from '../src/index.ts'
import { caught, tempDir } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

// ---------------------------------------------------------------------------------------------
// What the compiler generates for:
//
//   @Config('database') export class DatabaseConfig { host = 'localhost'; port = 5432; @Secret('DB_PASSWORD') password!: string }
//   @Config('http') export class HttpConfig { port = 3000; @Env('PUBLIC_URL') publicUrl!: URL; mode: 'dev' | 'prod' = 'dev' }
//   @Injectable() export class Server { constructor(http: HttpConfig, db: DatabaseConfig) {} }
// ---------------------------------------------------------------------------------------------

class DatabaseConfig {
  host = 'localhost'
  port = 5432
  password!: string
}

class HttpConfig {
  port = 3000
  publicUrl!: URL
  mode: 'dev' | 'prod' = 'dev'
}

class Server {
  readonly http: HttpConfig
  readonly db: DatabaseConfig
  constructor(http: HttpConfig, db: DatabaseConfig) {
    this.http = http
    this.db = db
  }
}

const DB = 'src/config/database.config.ts#DatabaseConfig'
const HTTP = 'src/config/http.config.ts#HttpConfig'
const SERVER = 'src/server.ts#Server'

const databaseFields: readonly ConfigFieldDefinition[] = [
  {
    property: 'host',
    env: 'DATABASE_HOST',
    key: 'database.host',
    type: 'string',
    default: 'localhost',
    required: false,
    secret: false,
  },
  {
    property: 'port',
    env: 'DATABASE_PORT',
    key: 'database.port',
    type: 'number',
    default: 5432,
    required: false,
    secret: false,
  },
  { property: 'password', env: 'DB_PASSWORD', key: 'database.password', type: 'string', required: true, secret: true },
]

const httpFields: readonly ConfigFieldDefinition[] = [
  {
    property: 'port',
    env: 'HTTP_PORT',
    key: 'http.port',
    type: 'number',
    default: 3000,
    required: false,
    secret: false,
  },
  { property: 'publicUrl', env: 'PUBLIC_URL', key: 'http.publicUrl', type: 'url', required: true, secret: false },
  {
    property: 'mode',
    env: 'HTTP_MODE',
    key: 'http.mode',
    type: 'string',
    enum: ['dev', 'prod'],
    default: 'dev',
    required: false,
    secret: false,
  },
]

const SOURCE_DEP = { token: CONFIG_SOURCE_TOKEN, optional: true } as const

const metadata: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    [DB]: {
      scope: 'singleton',
      class: DatabaseConfig,
      deps: [SOURCE_DEP],
      factory: d => loadConfig(DatabaseConfig, d[0], databaseFields),
    },
    [HTTP]: {
      scope: 'singleton',
      class: HttpConfig,
      deps: [SOURCE_DEP],
      factory: d => loadConfig(HttpConfig, d[0], httpFields),
    },
    [SERVER]: { scope: 'singleton', class: Server, deps: [HTTP, DB], factory: d => new Server(d[0], d[1]) },
  },
  resolutionOrder: [DB, HTTP, SERVER],
  externals: [{ token: CONFIG_SOURCE_TOKEN, providedBy: 'ConfigPlugin' }],
  extensions: {
    config: {
      configs: [
        { token: DB, prefix: 'database', fields: databaseFields },
        { token: HTTP, prefix: 'http', fields: httpFields },
      ],
    },
  },
}

function create(plugins: ConfigPluginInstance[], meta: ZnightMetadata = metadata, logger: CoreLogger = silentLogger) {
  return Application.create({ metadata: meta, plugins, logger, shutdown: { signals: false } })
}

describe('ConfigPlugin through Application.create', () => {
  it('loads every config class from the loaders and injects them', async () => {
    const plugin = ConfigPlugin.configure({
      loaders: [inline({ DB_PASSWORD: 's3cret', PUBLIC_URL: 'https://api.example.com', HTTP_PORT: '8080' })],
    })
    const app = await create([plugin])
    try {
      const server = app.get(Server)
      expect(server.http.port).toBe(8080)
      expect(server.http.publicUrl).toBeInstanceOf(URL)
      expect(server.http.mode).toBe('dev')
      expect(server.db).toBe(app.get(DatabaseConfig))
      expect(server.db.password).toBe('s3cret')
      expect(JSON.stringify(server.db)).not.toContain('s3cret')
      expect(plugin.name).toBe('config')
      expect(plugin.source?.get('HTTP_PORT')).toBe('8080')
      expect(app.getPlugin<ConfigPluginInstance>('config')).toBe(plugin)
    } finally {
      await app.stop()
    }
  })

  it('registers the ConfigSource external for injection', async () => {
    let injected: ConfigSource | undefined
    const meta: ZnightMetadata = {
      ...metadata,
      providers: {
        ...metadata.providers,
        'src/flags.ts#Flags': {
          scope: 'singleton',
          deps: [CONFIG_SOURCE_TOKEN],
          factory: d => {
            injected = d[0] as ConfigSource
            return {}
          },
        },
      },
      resolutionOrder: [...metadata.resolutionOrder, 'src/flags.ts#Flags'],
    }
    const plugin = ConfigPlugin.configure({
      loaders: [inline({ DB_PASSWORD: 'x', PUBLIC_URL: 'https://x.dev', FLAG: 'on' })],
    })
    const app = await create([plugin], meta)
    try {
      expect(injected).toBe(plugin.source as ConfigSource)
      expect(app.container.get(ConfigTokens.Source).get('FLAG')).toBe('on')
    } finally {
      await app.stop()
    }
  })

  it('validates every config class in register() and reports all problems at once', async () => {
    const created: string[] = []
    const meta: ZnightMetadata = {
      ...metadata,
      providers: {
        ...metadata.providers,
        [SERVER]: {
          scope: 'singleton',
          deps: [HTTP, DB],
          factory: () => {
            created.push('server')
            return {}
          },
        },
      },
    }
    const error = await caught(() =>
      create(
        [
          ConfigPlugin.configure({
            loaders: [inline({ HTTP_PORT: 'eighty', HTTP_MODE: 'staging' }, { name: 'test' })],
          }),
        ],
        meta,
      ),
    )
    expect(error).toBeInstanceOf(ConfigValidationError)
    expect((error as ZnightError).code).toBe(ErrorCode.MissingConfig)
    expect(error.message).toBe(
      [
        'ZNIGHT006: Invalid configuration: 4 problems',
        '  - DatabaseConfig.password: missing required value; set DB_PASSWORD (or key "database.password")',
        '  - HttpConfig.port: expected a number but got "eighty" (HTTP_PORT from test)',
        '  - HttpConfig.publicUrl: missing required value; set PUBLIC_URL (or key "http.publicUrl")',
        '  - HttpConfig.mode: expected one of "dev", "prod" but got "staging" (HTTP_MODE from test)',
      ].join('\n'),
    )
    expect((error as ZnightError).hints).toContain('Configuration sources (lowest to highest precedence): test')
    expect(created).toEqual([])
  })

  it('can skip the aggregated validation (each class then fails on creation)', async () => {
    const error = await caught(() => create([ConfigPlugin.configure({ loaders: [inline({})], validate: false })]))
    expect(error).toBeInstanceOf(InstantiationError)
    expect((error as ZnightError).code).toBe(ErrorCode.InstantiationFailed)
    expect(error.cause).toBeInstanceOf(ConfigValidationError)
  })

  it('uses [dotenv(), env()] by default: the environment wins over .env files', async () => {
    const { dir, cleanup } = await tempDir({
      '.env': 'DB_PASSWORD=from-dotenv\nPUBLIC_URL=https://dotenv.example.com\nHTTP_PORT=1111\n',
      '.env.production': 'HTTP_MODE=prod\n',
    })
    try {
      const plugin = ConfigPlugin.configure({ cwd: dir, env: { NODE_ENV: 'production', HTTP_PORT: '2222' } })
      const app = await create([plugin])
      try {
        const http = app.get(HttpConfig)
        expect(http.port).toBe(2222)
        expect(http.mode).toBe('prod')
        expect(http.publicUrl.hostname).toBe('dotenv.example.com')
        expect(app.get(DatabaseConfig).password).toBe('from-dotenv')
        expect(plugin.source?.describe?.()).toBe('.env < .env.production < process.env')
      } finally {
        await app.stop()
      }
    } finally {
      cleanup()
    }
  })

  it('reads structured sources by key path', async () => {
    const plugin = ConfigPlugin.configure({
      loaders: [
        inline(
          { database: { password: 'from-file', port: 6543 }, http: { publicUrl: 'https://file.example.com' } },
          { name: 'config.json' },
        ),
        env({ env: { DATABASE_PORT: '7000' } }),
      ],
    })
    const app = await create([plugin])
    try {
      expect(app.get(DatabaseConfig).password).toBe('from-file')
      expect(app.get(DatabaseConfig).port).toBe(7000)
      expect(app.get(HttpConfig).publicUrl.href).toBe('https://file.example.com/')
    } finally {
      await app.stop()
    }
  })

  it('wraps loader failures and rolls the application back', async () => {
    const failing: ConfigLoader = {
      name: 'remote',
      load: () => Promise.reject(new Error('connection refused')),
    }
    const error = await caught(() => create([ConfigPlugin.configure({ loaders: [failing] })]))
    expect(error.message).toBe('ZNIGHT006: Config loader "remote" failed: connection refused')
  })

  it('logs the loaded sources at debug level', async () => {
    const entries: [string, LogContext | undefined][] = []
    const logger: CoreLogger = { ...silentLogger, debug: (message, context) => entries.push([message, context]) }
    const app = await create(
      [
        ConfigPlugin.configure({
          loaders: [inline({ DB_PASSWORD: 'x', PUBLIC_URL: 'https://x.dev' }, { name: 'inline' })],
        }),
      ],
      metadata,
      logger,
    )
    await app.stop()
    const entry = entries.find(([message]) => message === 'Configuration loaded')
    expect(entry?.[1]).toMatchObject({ sources: 'inline', configs: 2 })
    expect(JSON.stringify(entries)).not.toContain('"x"')
  })

  it('works with metadata without config classes', async () => {
    const app = await create([ConfigPlugin.configure({ loaders: [inline({ A: '1' })] })], {
      version: 1,
      providers: {},
      resolutionOrder: [],
    })
    try {
      expect(app.container.get(ConfigTokens.Source).get('A')).toBe('1')
    } finally {
      await app.stop()
    }
  })

  it('rejects invalid loaders when configured', async () => {
    const error = await caught(() => ConfigPlugin.configure({ loaders: [{} as ConfigLoader] }))
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
  })
})

describe('without ConfigPlugin', () => {
  it('config classes read process.env', async () => {
    const saved = { ...process.env }
    process.env.DB_PASSWORD = 'env-only'
    process.env.PUBLIC_URL = 'https://env.example.com'
    process.env.HTTP_PORT = '4321'
    try {
      const app = await create([])
      try {
        expect(app.get(HttpConfig).port).toBe(4321)
        expect(app.get(DatabaseConfig).password).toBe('env-only')
        expect(app.get(DatabaseConfig).host).toBe('localhost')
      } finally {
        await app.stop()
      }
    } finally {
      for (const name of ['DB_PASSWORD', 'PUBLIC_URL', 'HTTP_PORT']) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
    }
  })

  it('a missing value fails the creation of its class (ZNIGHT015 caused by ZNIGHT006)', async () => {
    const saved = process.env.DB_PASSWORD
    delete process.env.DB_PASSWORD
    try {
      const error = await caught(() => create([]))
      expect(error).toBeInstanceOf(InstantiationError)
      const cause = error.cause as ConfigValidationError
      expect(cause).toBeInstanceOf(ConfigValidationError)
      expect(cause.problems[0]?.property).toBe('password')
      expect(cause.hints.some(hint => hint.includes('ConfigPlugin.configure()'))).toBe(true)
    } finally {
      if (saved !== undefined) process.env.DB_PASSWORD = saved
    }
  })

  it('works when the metadata does not declare the ConfigSource external', async () => {
    const { externals: _externals, ...withoutExternals } = metadata
    const saved = { ...process.env }
    process.env.DB_PASSWORD = 'no-external'
    process.env.PUBLIC_URL = 'https://no-external.dev'
    try {
      const app = await create([], withoutExternals)
      try {
        expect(app.get(DatabaseConfig).password).toBe('no-external')
      } finally {
        await app.stop()
      }
    } finally {
      for (const name of ['DB_PASSWORD', 'PUBLIC_URL']) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
    }
  })

  it('an injected ConfigSource without plugin is a missing external naming ConfigPlugin', async () => {
    const meta: ZnightMetadata = {
      version: 1,
      providers: { 'src/flags.ts#Flags': { scope: 'singleton', deps: [CONFIG_SOURCE_TOKEN], factory: () => ({}) } },
      resolutionOrder: ['src/flags.ts#Flags'],
      externals: [{ token: CONFIG_SOURCE_TOKEN, providedBy: 'ConfigPlugin' }],
    }
    const error = await caught(() => create([], meta))
    expect((error as ZnightError).code).toBe(ErrorCode.MissingProvider)
    expect(error.message).toContain('provided by ConfigPlugin')
  })
})

describe('dotenv() + ConfigPlugin in a full flow', () => {
  it('lets a .env override the environment with override: true', async () => {
    const { dir, cleanup } = await tempDir({ '.env': 'HTTP_PORT=5555\nDB_PASSWORD=p\nPUBLIC_URL=https://a.dev\n' })
    try {
      const variables: Record<string, string | undefined> = { HTTP_PORT: '1' }
      const app = await create([
        ConfigPlugin.configure({ cwd: dir, env: variables, loaders: [dotenv({ override: true }), env()] }),
      ])
      try {
        expect(app.get(HttpConfig).port).toBe(5555)
        expect(variables.HTTP_PORT).toBe('5555')
      } finally {
        await app.stop()
      }
    } finally {
      cleanup()
    }
  })
})
