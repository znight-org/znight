/**
 * Code generation of the config extension: the `extensions.config` section, the provider factories
 * and the shared field constants, as `GenNode` trees.
 */
import type { AnalysisResult, GenNode } from '@znight/compiler'
import type { StoredConfig } from '../../src/compiler/index.ts'
import type { TempApp } from './helpers.ts'

import configExtension from '../../src/compiler/index.ts'
import { analyzeApp, generateContext, render, storedData, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const FILES = {
  'src/b/app.config.ts': `
import { Config, Default, Secret } from '@znight/config'
@Config('app')
export class AppConfig {
  @Default(3000) port!: number
  @Secret('APP_TOKEN') token!: string
  mode: 'dev' | 'prod' = 'dev'
}
`,
  'src/a/app.config.ts': `
import { Config } from '@znight/config'
@Config()
export class AppConfig {
  name?: string
}
`,
  'src/z/models.ts': `
import { Config } from '@znight/config'
@Config('z')
export class ZConfig {
  enabled = true
}
`,
}

const A = 'src/a/app.config.ts#AppConfig'
const B = 'src/b/app.config.ts#AppConfig'
const Z = 'src/z/models.ts#ZConfig'

describe('generation', () => {
  let app: TempApp
  let result: AnalysisResult
  let configs: Record<string, StoredConfig>

  beforeAll(async () => {
    app = tempApp(FILES)
    result = await analyzeApp(app.root)
    configs = Object.fromEntries(
      storedData(result)
        .filter((data): data is StoredConfig => data.kind === 'config')
        .map(data => [data.token, data]),
    )
  })
  afterAll(() => app.cleanup())

  const section = (options: { constants?: boolean } = {}) => {
    const ctx = generateContext(result.graph, storedData(result), options)
    return { ctx, node: configExtension.generate?.(ctx) }
  }

  const factory = (token: string, ctx: ReturnType<typeof generateContext>): GenNode => {
    const provider = result.graph.providers.find(candidate => candidate.token === token)
    if (provider?.factory.kind !== 'custom') throw new Error(`no custom provider ${token}`)
    return provider.factory.generate(ctx, {
      cls: ctx.importValue(provider.classIdentity),
      deps: [ctx.code`d[0]`],
    })
  }

  it('compiles without diagnostics', () => {
    expect(render(app.root, result.diagnostics)).toEqual([])
  })

  it('emits the config section ordered by token, with the prefix only when there is one', () => {
    const { ctx, node } = section()
    const constant = (name: string) => ctx.constants.get(name)?.node
    expect(node).toEqual(
      ctx.obj({
        configs: ctx.arr([
          ctx.obj([
            ['token', A],
            ['fields', constant('AppConfig$fields') as GenNode],
          ]),
          ctx.obj([
            ['token', B],
            ['prefix', 'app'],
            ['fields', constant('AppConfig$fields$1') as GenNode],
          ]),
          ctx.obj([
            ['token', Z],
            ['prefix', 'z'],
            ['fields', constant('ZConfig$fields') as GenNode],
          ]),
        ]),
      }),
    )
    expect(ctx.reports).toEqual([])
  })

  it('declares the fields once per class as typed module constants', () => {
    const { ctx } = section()
    expect([...ctx.constants.keys()]).toEqual(['AppConfig$fields', 'AppConfig$fields$1', 'ZConfig$fields'])
    const declared = ctx.constants.get('AppConfig$fields$1')
    expect(declared?.value).toEqual(
      ctx.lit([
        {
          property: 'port',
          env: 'APP_PORT',
          key: 'app.port',
          type: 'number',
          default: 3000,
          required: false,
          secret: false,
        },
        { property: 'token', env: 'APP_TOKEN', key: 'app.token', type: 'string', required: true, secret: true },
        {
          property: 'mode',
          env: 'APP_MODE',
          key: 'app.mode',
          type: 'string',
          enum: ['dev', 'prod'],
          required: false,
          secret: false,
        },
      ]),
    )
    expect(declared?.type).toEqual(
      ctx.code`readonly ${ctx.importFrom('@znight/config', 'ConfigFieldDefinition', { type: true })}[]`,
    )
    expect(declared?.type).toMatchObject({
      kind: 'gen:code',
      parts: ['readonly ', '[]'],
      values: [
        {
          kind: 'gen:import',
          target: { kind: 'module', module: '@znight/config', name: 'ConfigFieldDefinition' },
          typeOnly: true,
        },
      ],
    })
  })

  it('generates factories calling loadConfig(Class, source, fields) with the same constant', () => {
    const { ctx } = section()
    for (const [token, name] of [
      [A, 'AppConfig$fields'],
      [B, 'AppConfig$fields$1'],
      [Z, 'ZConfig$fields'],
    ] as const) {
      const node = factory(token, ctx)
      expect(node).toEqual(
        ctx.call(ctx.importFrom('@znight/config', 'loadConfig'), [
          ctx.importValue(token),
          ctx.code`d[0]`,
          ctx.constants.get(name)?.node as GenNode,
        ]),
      )
    }
    expect(ctx.constants.size).toBe(3)
  })

  it('declares the constants from the factories too (whatever is generated first)', () => {
    const ctx = generateContext(result.graph, storedData(result))
    factory(Z, ctx)
    expect([...ctx.constants.keys()]).toEqual(['ZConfig$fields'])
    configExtension.generate?.(ctx)
    expect([...ctx.constants.keys()]).toEqual(['ZConfig$fields', 'AppConfig$fields', 'AppConfig$fields$1'])
  })

  it('inlines the field definitions when the context cannot declare constants', () => {
    const { ctx, node } = section({ constants: false })
    const fields = (config: StoredConfig) => ctx.lit(config.fields as never)
    expect(node).toEqual(
      ctx.obj({
        configs: ctx.arr([
          ctx.obj([
            ['token', A],
            ['fields', fields(configs[A] as StoredConfig)],
          ]),
          ctx.obj([
            ['token', B],
            ['prefix', 'app'],
            ['fields', fields(configs[B] as StoredConfig)],
          ]),
          ctx.obj([
            ['token', Z],
            ['prefix', 'z'],
            ['fields', fields(configs[Z] as StoredConfig)],
          ]),
        ]),
      }),
    )
    expect((factory(Z, ctx) as unknown as { args: GenNode[] }).args[2]).toEqual(fields(configs[Z] as StoredConfig))
  })

  it('inlines the fields in factories generated with another context', () => {
    const ctx = generateContext(result.graph, [])
    expect((factory(Z, ctx) as unknown as { args: GenNode[] }).args[2]).toEqual(ctx.lit(configs[Z]?.fields as never))
    expect(ctx.constants.size).toBe(0)
  })

  it('returns no section without config classes', () => {
    const ctx = generateContext(result.graph, [])
    expect(configExtension.generate?.(ctx)).toBeUndefined()
  })

  it('is deterministic', () => {
    expect(section().node).toEqual(section().node)
  })
})
