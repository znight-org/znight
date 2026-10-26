/**
 * Analysis of config classes by the compiler extension: provider registration, ConfigSource
 * dependency, field definitions (names, types, enums, defaults, required, secrets), inheritance.
 */
import type { AnalysisResult } from '@znight/compiler'
import type { TempApp } from './helpers.ts'

import configExtension from '../../src/compiler/index.ts'
import { analyzeApp, render, storedConfigs, storedData, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const FIELDS = `
import { Config, Default, Env, Key, Secret } from '@znight/config'
import type { Flags, Level, Server } from './types.ts'
import { Mode, Port } from './types.ts'

@Config('database')
export class DatabaseConfig {
  host = 'localhost'
  port = 5432
  @Env('DATABASE_URL') url?: URL
  @Secret('DB_PASSWORD') password!: string
  poolSize: 5 | 10 | 20 = 10
  @Key('db.replicas') replicas: string[] = []
  ssl = false
}

@Config()
export class AppConfig {
  name!: string
  maxConnections?: number
  debug: boolean | undefined
  level!: Level
  mode: Mode = Mode.Fast
  ports: number[] = [80]
  tags!: readonly ('a' | 'b')[]
  modes!: Array<Mode>
  servers!: Server[]
  flags?: Flags
  record!: Record<string, number>
  inline!: { a: number }
  anything!: unknown
  tuple!: [string, number]
  matrix!: number[][]
  nullable!: string | null
  brand!: string & { readonly __brand: 'Id' }
  port!: Port
  openString!: 'x' | (string & {})
  template!: \`v\${number}\`
  @Default(3) retries!: number
  @Default('https://example.com') homepage!: URL
  @Default({ enabled: true }) features!: Flags
  @Default(['a', 'b']) list?: string[]
  @Default(8080) inferred
  @Secret() @Env('API_TOKEN') token!: string
  @Secret('SAME') @Env('SAME') same!: string
  @Secret() apiKey!: string
  'quoted-name' = 'x'
  computed: number = Number.parseInt('3', 10)
  created = new URL('https://znight.dev')
  static ignored = 1
  #hidden = 2
  readonly fromDeclare!: string
  method(): number {
    return this.#hidden
  }
}
`

const TYPES = `
export interface Server { host: string; port: number }
export interface Flags { enabled: boolean }
export type Level = 'debug' | 'info' | 'warn'
export enum Mode { Fast = 'fast', Safe = 'safe' }
export type Port = number & { readonly __brand: 'Port' }
`

describe('config classes', () => {
  let app: TempApp
  let result: AnalysisResult

  beforeAll(async () => {
    app = tempApp({ 'src/config.ts': FIELDS, 'src/types.ts': TYPES })
    result = await analyzeApp(app.root)
  })
  afterAll(() => app.cleanup())

  it('analyses them without diagnostics', () => {
    expect(render(app.root, result.diagnostics)).toEqual([])
  })

  it('loads the extension from the package manifest', () => {
    const loaded = result.extensions.find(entry => entry.extension.name === 'config')
    expect(loaded).toMatchObject({
      origin: 'package',
      packageName: '@znight/config',
      specifier: '@znight/config/compiler',
    })
    expect(loaded?.extension).toBe(configExtension)
  })

  it('registers singleton providers built by a custom factory with the ConfigSource as an optional dependency', () => {
    expect(result.graph.providers.map(provider => provider.token)).toEqual([
      'src/config.ts#AppConfig',
      'src/config.ts#DatabaseConfig',
    ])
    for (const provider of result.graph.providers) {
      expect(provider).toMatchObject({
        kind: 'custom',
        registeredBy: 'config',
        scope: 'singleton',
        async: false,
        factory: { kind: 'custom', args: 1 },
      })
      expect(provider.deps.map(dep => dep.ref)).toEqual([{ token: '@znight/config#ConfigSource', optional: true }])
      expect(provider.deps[0]?.label).toBe(`configuration source of ${provider.displayName}`)
      expect(provider.importRoute).toMatchObject({ specifier: '../config.js', exportName: provider.displayName })
    }
  })

  it('declares the ConfigSource external of ConfigPlugin (package manifest)', () => {
    expect(result.graph.externals).toEqual([
      {
        token: '@znight/config#ConfigSource',
        displayName: 'ConfigSource',
        scope: 'singleton',
        providedBy: 'ConfigPlugin',
        optional: false,
        origin: 'manifest',
      },
    ])
    expect(result.graph.resolutionOrder).toEqual(['src/config.ts#AppConfig', 'src/config.ts#DatabaseConfig'])
  })

  it('generates the field definitions of the README example', () => {
    const database = storedConfigs(result).DatabaseConfig
    expect(database).toEqual({
      kind: 'config',
      token: 'src/config.ts#DatabaseConfig',
      displayName: 'DatabaseConfig',
      prefix: 'database',
      bases: [],
      fields: [
        {
          property: 'host',
          env: 'DATABASE_HOST',
          key: 'database.host',
          type: 'string',
          required: false,
          secret: false,
        },
        {
          property: 'port',
          env: 'DATABASE_PORT',
          key: 'database.port',
          type: 'number',
          required: false,
          secret: false,
        },
        { property: 'url', env: 'DATABASE_URL', key: 'database.url', type: 'url', required: false, secret: false },
        {
          property: 'password',
          env: 'DB_PASSWORD',
          key: 'database.password',
          type: 'string',
          required: true,
          secret: true,
        },
        {
          property: 'poolSize',
          env: 'DATABASE_POOL_SIZE',
          key: 'database.poolSize',
          type: 'number',
          enum: [5, 10, 20],
          required: false,
          secret: false,
        },
        {
          property: 'replicas',
          env: 'DATABASE_REPLICAS',
          key: 'db.replicas',
          type: 'string[]',
          required: false,
          secret: false,
        },
        { property: 'ssl', env: 'DATABASE_SSL', key: 'database.ssl', type: 'boolean', required: false, secret: false },
      ],
    })
  })

  it('maps TypeScript types to field types and allowed values', () => {
    const fields = Object.fromEntries(
      (storedConfigs(result).AppConfig?.fields ?? []).map(field => [
        field.property,
        [field.type, field.enum, field.required, ...(Object.hasOwn(field, 'default') ? [field.default] : [])],
      ]),
    )
    expect(fields).toEqual({
      name: ['string', undefined, true],
      maxConnections: ['number', undefined, false],
      debug: ['boolean', undefined, false],
      level: ['string', ['debug', 'info', 'warn'], true],
      mode: ['string', ['fast', 'safe'], false],
      ports: ['number[]', undefined, false],
      tags: ['string[]', ['a', 'b'], true],
      modes: ['string[]', ['fast', 'safe'], true],
      servers: ['json', undefined, true],
      flags: ['json', undefined, false],
      record: ['json', undefined, true],
      inline: ['json', undefined, true],
      anything: ['json', undefined, true],
      tuple: ['json', undefined, true],
      matrix: ['json', undefined, true],
      nullable: ['string', undefined, false],
      brand: ['string', undefined, true],
      port: ['number', undefined, true],
      openString: ['string', undefined, true],
      template: ['string', undefined, true],
      retries: ['number', undefined, false, 3],
      homepage: ['url', undefined, false, 'https://example.com'],
      features: ['json', undefined, false, { enabled: true }],
      list: ['string[]', undefined, false, ['a', 'b']],
      inferred: ['number', undefined, false, 8080],
      token: ['string', undefined, true],
      same: ['string', undefined, true],
      apiKey: ['string', undefined, true],
      'quoted-name': ['string', undefined, false],
      computed: ['number', undefined, false],
      created: ['url', undefined, false],
      fromDeclare: ['string', undefined, true],
    })
  })

  it('derives names from the prefix, @Env, @Secret and @Key', () => {
    const names = Object.fromEntries(
      (storedConfigs(result).AppConfig?.fields ?? []).map(field => [
        field.property,
        [field.env, field.key, field.secret],
      ]),
    )
    expect(names.maxConnections).toEqual(['MAX_CONNECTIONS', 'maxConnections', false])
    expect(names.token).toEqual(['API_TOKEN', 'token', true])
    expect(names.same).toEqual(['SAME', 'same', true])
    expect(names.apiKey).toEqual(['API_KEY', 'apiKey', true])
    expect(names['quoted-name']).toEqual(['QUOTED_NAME', 'quoted-name', false])
    expect(storedConfigs(result).AppConfig?.prefix).toBeUndefined()
  })

  it('only emits optional keys when they have a value', () => {
    const fields = storedConfigs(result).AppConfig?.fields ?? []
    const name = fields.find(field => field.property === 'name') as object
    expect(Object.keys(name)).toEqual(['property', 'env', 'key', 'type', 'required', 'secret'])
    const retries = fields.find(field => field.property === 'retries') as object
    expect(Object.keys(retries)).toEqual(['property', 'env', 'key', 'type', 'default', 'required', 'secret'])
    const level = fields.find(field => field.property === 'level') as object
    expect(Object.keys(level)).toEqual(['property', 'env', 'key', 'type', 'enum', 'required', 'secret'])
  })
})

describe('extension loading', () => {
  const source = `
import { Config } from '@znight/config'
@Config('http') export class HttpConfig { port = 3000 }
`
  let app: TempApp
  beforeAll(() => {
    app = tempApp({ 'src/http.config.ts': source })
  })
  afterAll(() => app.cleanup())

  it('works with the extension given explicitly (it wins over the discovered one)', async () => {
    const explicit = await analyzeApp(app.root, { extensions: [configExtension] })
    const discovered = await analyzeApp(app.root)
    expect(explicit.extensions.filter(entry => entry.extension.name === 'config').map(entry => entry.origin)).toEqual([
      'option',
    ])
    expect(render(app.root, explicit.diagnostics)).toEqual([])
    expect(storedData(explicit)).toEqual(storedData(discovered))
    expect(explicit.graph.providers.map(provider => provider.token)).toEqual(['src/http.config.ts#HttpConfig'])
  })

  it('is not loaded when the application does not import @znight/config', async () => {
    const other = tempApp({ 'src/main.ts': 'export const x = 1\n' })
    try {
      const result = await analyzeApp(other.root)
      expect(result.extensions.map(entry => entry.extension.name)).not.toContain('config')
    } finally {
      other.cleanup()
    }
  })
})

describe('inheritance', () => {
  let app: TempApp
  let result: AnalysisResult

  beforeAll(async () => {
    app = tempApp({
      'src/base.ts': `
import { Env, Secret } from '@znight/config'
export abstract class BaseConfig {
  @Env('LOG_LEVEL') logLevel: 'debug' | 'info' = 'info'
  @Secret() token!: string
  port = 1
}
export class PlainBase {
  region = 'eu'
}
`,
      'src/config.ts': `
import { Config } from '@znight/config'
import { BaseConfig, PlainBase } from './base.ts'

@Config('api')
export class ApiConfig extends BaseConfig {
  override port = 8080
  url!: string
}

@Config('worker')
export class WorkerConfig extends BaseConfig {}

@Config()
export class RegionConfig extends PlainBase {
  zone!: string
}
`,
    })
    result = await analyzeApp(app.root)
  })
  afterAll(() => app.cleanup())

  it('includes the properties of base classes (with the prefix of the config class)', () => {
    expect(render(app.root, result.diagnostics)).toEqual([])
    const configs = storedConfigs(result)
    expect(configs.ApiConfig?.bases).toEqual(['src/base.ts#BaseConfig'])
    expect(configs.ApiConfig?.fields.map(field => [field.property, field.env, field.required, field.secret])).toEqual([
      ['logLevel', 'LOG_LEVEL', false, false],
      ['token', 'API_TOKEN', true, true],
      ['port', 'API_PORT', false, false],
      ['url', 'API_URL', true, false],
    ])
    expect(configs.WorkerConfig?.fields.map(field => field.env)).toEqual(['LOG_LEVEL', 'WORKER_TOKEN', 'WORKER_PORT'])
    expect(configs.RegionConfig?.fields.map(field => field.property)).toEqual(['region', 'zone'])
    expect(configs.RegionConfig?.bases).toEqual(['src/base.ts#PlainBase'])
  })

  it('does not register base classes as providers', () => {
    expect(result.graph.providers.map(provider => provider.token)).toEqual([
      'src/config.ts#ApiConfig',
      'src/config.ts#RegionConfig',
      'src/config.ts#WorkerConfig',
    ])
  })
})
