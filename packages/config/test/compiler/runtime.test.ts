/**
 * End to end: config classes analysed by the compiler extension run with `Application.create` and
 * `ConfigPlugin` — typed values, defaults, enums, secrets masking and the aggregated ZNIGHT006 error.
 *
 * - "interpreted": the extension's nodes (factories, constants, config section) are evaluated by a
 *   tiny interpreter (no code generator needed);
 * - "compile()": the real generated module, when `@znight/compiler` exports `compile()`.
 */
import type { AnalysisResult, Diagnostic, ZnightOptions } from '@znight/compiler'
import type { ZnightMetadata } from '@znight/core'
import type { ConfigSource } from '../../src/index.ts'
import type { TempApp } from './helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'
import * as compiler from '@znight/compiler'
import { Application, InstantiationError, silentLogger } from '@znight/core'

import configExtension from '../../src/compiler/index.ts'
import { ConfigPlugin, ConfigValidationError, inline, loadConfig } from '../../src/index.ts'
import { analyzeApp, interpretedMetadata, render, storedData, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const DATABASE = 'src/config/database.config.ts#DatabaseConfig'
const HTTP = 'src/config/http.config.ts#HttpConfig'

const FILES = {
  'src/config/database.config.ts': `
import { Config, Default, Env, Secret } from '@znight/config'

export enum Level {
  Debug = 'debug',
  Info = 'info',
}

export interface PoolOptions {
  ssl: boolean
  idleMs?: number
}

@Config('database')
export class DatabaseConfig {
  host = 'localhost'
  port = 5432
  @Env('DATABASE_URL') url?: URL
  @Secret('DB_PASSWORD') password!: string
  poolSize: 5 | 10 | 20 = 10
  @Default(['primary']) replicas!: string[]
  level: Level = Level.Info
  @Default({ ssl: false }) pool!: PoolOptions

  describe(): string {
    return \`\${this.host}:\${this.port}\`
  }
}
`,
  'src/config/http.config.ts': `
import { Config, Default, Env, Key } from '@znight/config'

@Config('http')
export class HttpConfig {
  @Default(3000) port!: number
  @Env('PUBLIC_URL') publicUrl!: URL
  debug = false
  @Key('cors.origins') origins: string[] = []
}
`,
}

const VALID = {
  DB_PASSWORD: 's3cret',
  DATABASE_POOL_SIZE: '20',
  PUBLIC_URL: 'https://znight.dev',
  HTTP_DEBUG: 'yes',
  'cors.origins': 'https://a.dev, https://b.dev',
}

interface DatabaseConfig {
  host: string
  port: number
  url?: URL
  password: string
  poolSize: number
  replicas: string[]
  level: string
  pool: { ssl: boolean }
  describe(): string
}

interface HttpConfig {
  port: number
  publicUrl: URL
  debug: boolean
  origins: string[]
}

type MetadataFactory = () => Promise<ZnightMetadata>

function create(metadata: ZnightMetadata, values?: Record<string, string>): Promise<Application> {
  return Application.create({
    metadata,
    logger: silentLogger,
    plugins: values === undefined ? [] : [ConfigPlugin.configure({ loaders: [inline(values)] })],
  })
}

/** The same scenarios for every way of producing the metadata. */
function scenarios(load: MetadataFactory, classes: () => Record<string, new () => object>): void {
  it('creates typed config instances from the sources, defaults and initializers', async () => {
    const app = await create(await load(), VALID)
    try {
      const database = app.container.get<DatabaseConfig>(DATABASE)
      expect(database).toBeInstanceOf(classes()[DATABASE] as new () => object)
      expect(database.host).toBe('localhost')
      expect(database.port).toBe(5432)
      expect(database.url).toBeUndefined()
      expect(database.password).toBe('s3cret')
      expect(database.poolSize).toBe(20)
      expect(database.replicas).toEqual(['primary'])
      expect(database.level).toBe('info')
      expect(database.pool).toEqual({ ssl: false })
      expect(database.describe()).toBe('localhost:5432')

      const http = app.container.get<HttpConfig>(HTTP)
      expect(http.port).toBe(3000)
      expect(http.publicUrl).toBeInstanceOf(URL)
      expect(http.publicUrl.href).toBe('https://znight.dev/')
      expect(http.debug).toBe(true)
      expect(http.origins).toEqual(['https://a.dev', 'https://b.dev'])
    } finally {
      await app.stop()
    }
  })

  it('masks secrets', async () => {
    const app = await create(await load(), VALID)
    try {
      const database = app.container.get<DatabaseConfig>(DATABASE)
      expect(JSON.stringify(database)).toContain('"password":"[REDACTED]"')
      expect(JSON.stringify(database)).not.toContain('s3cret')
      expect(inspect(database)).not.toContain('s3cret')
      expect(String(database)).not.toContain('s3cret')
    } finally {
      await app.stop()
    }
  })

  it('reports every missing or invalid value of every class in one ZNIGHT006 error', async () => {
    const error = await create(await load(), {
      DATABASE_POOL_SIZE: '15',
      DATABASE_LEVEL: 'trace',
      HTTP_PORT: '80 80',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ConfigValidationError)
    const validation = error as ConfigValidationError
    expect(validation.code).toBe('ZNIGHT006')
    expect(validation.problems.map(problem => `${problem.config}.${problem.property}: ${problem.message}`)).toEqual([
      'DatabaseConfig.password: missing required value',
      'DatabaseConfig.poolSize: expected one of 5, 10, 20 but got 15',
      'DatabaseConfig.level: expected one of "debug", "info" but got "trace"',
      'HttpConfig.port: expected a number but got "80 80"',
      'HttpConfig.publicUrl: missing required value',
    ])
  })

  it('reads process.env without ConfigPlugin (the ConfigSource dependency is optional)', async () => {
    const saved = { DB_PASSWORD: process.env.DB_PASSWORD, PUBLIC_URL: process.env.PUBLIC_URL }
    process.env.DB_PASSWORD = 'from-env'
    process.env.PUBLIC_URL = 'https://env.dev'
    try {
      const app = await create(await load())
      try {
        expect(app.container.get<DatabaseConfig>(DATABASE).password).toBe('from-env')
        expect(app.container.get<HttpConfig>(HTTP).publicUrl.host).toBe('env.dev')
      } finally {
        await app.stop()
      }
      delete process.env.DB_PASSWORD
      const error = await create(await load()).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(InstantiationError)
      expect((error as InstantiationError).cause).toBeInstanceOf(ConfigValidationError)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
}

describe('end to end (interpreted generated nodes)', () => {
  let app: TempApp
  let result: AnalysisResult
  let classes: Record<string, new () => object>

  beforeAll(async () => {
    app = tempApp(FILES)
    result = await analyzeApp(app.root)
    const database = await import(path.join(app.root, 'src/config/database.config.ts'))
    const http = await import(path.join(app.root, 'src/config/http.config.ts'))
    classes = { [DATABASE]: database.DatabaseConfig, [HTTP]: http.HttpConfig }
  })
  afterAll(() => app.cleanup())

  const load: MetadataFactory = () =>
    Promise.resolve(
      interpretedMetadata(result.graph, storedData(result), ctx => configExtension.generate?.(ctx), {
        modules: { '@znight/config': { loadConfig } },
        identities: classes,
      }),
    )

  it('analyses the application without diagnostics', () => {
    expect(render(app.root, result.diagnostics)).toEqual([])
  })

  it('builds the metadata the runtime expects', async () => {
    const metadata = await load()
    expect(metadata.externals).toEqual([{ token: '@znight/config#ConfigSource', providedBy: 'ConfigPlugin' }])
    expect(Object.keys(metadata.providers)).toEqual([DATABASE, HTTP])
    expect(metadata.providers[DATABASE]?.deps).toEqual([{ token: '@znight/config#ConfigSource', optional: true }])
    const section = metadata.extensions?.config
    expect(section?.configs.map(config => [config.token, config.prefix, config.fields.length])).toEqual([
      [DATABASE, 'database', 8],
      [HTTP, 'http', 4],
    ])
  })

  it('passes the ConfigSource of the plugin to the factories', async () => {
    const app = await create(await load(), VALID)
    try {
      const source = app.container.get<ConfigSource>('@znight/config#ConfigSource')
      expect(source.get('DB_PASSWORD')).toBe('s3cret')
    } finally {
      await app.stop()
    }
  })

  scenarios(load, () => classes)
})

type Compile = (options: ZnightOptions) => Promise<{
  readonly code: string
  readonly outFile: string
  readonly diagnostics: readonly Diagnostic[]
}>

const compile = (compiler as Record<string, unknown>).compile as Compile | undefined

describe.skipIf(typeof compile !== 'function')('end to end (compile())', () => {
  let app: TempApp
  let code = ''
  let metadata: ZnightMetadata
  let classes: Record<string, new () => object>

  beforeAll(async () => {
    app = tempApp(FILES)
    const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'] })
    expect(render(app.root, result.diagnostics)).toEqual([])
    code = result.code
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, code)
    metadata = (await import(result.outFile)).__ZNIGHT_METADATA__
    const database = await import(path.join(app.root, 'src/config/database.config.ts'))
    const http = await import(path.join(app.root, 'src/config/http.config.ts'))
    classes = { [DATABASE]: database.DatabaseConfig, [HTTP]: http.HttpConfig }
  })
  afterAll(() => app.cleanup())

  it('emits loadConfig factories and the field constants once', () => {
    expect(code).toContain('loadConfig(')
    expect(code.match(/DatabaseConfig\$fields\b/g)?.length).toBe(3) // declaration, factory, section
    expect(code).toContain('ConfigFieldDefinition')
  })

  scenarios(
    () => Promise.resolve(metadata),
    () => classes,
  )
})
