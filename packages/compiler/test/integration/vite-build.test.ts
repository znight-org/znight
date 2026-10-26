/**
 * `vite build` with the `znight()` plugin (Vite JS API, real fixture applications): app defaults,
 * generated module, decorator stripping, source maps, build errors, warnings, the plugin API,
 * several server environments, and Vite running on Node.js. Built bundles run on Node.js and Bun.
 */
import type { ZnightPluginApi } from '../../src/vite.ts'

import fs from 'node:fs'
import { SourceMap } from 'node:module'
import { build, createBuilder, resolveConfig } from 'vite'

import { generate } from '../../src/compiler.ts'
import { DEFAULT_OUT_FILE } from '../../src/options.ts'
import { znight } from '../../src/vite.ts'
import { integrationApp, recordingLogger, report, run, SOURCE_CONDITION, stripAnsi, viteConfig } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const TIMEOUT = 30_000

const PROVIDERS = [
  'src/clock.ts#Clock',
  'src/greeting.service.ts#GreetingService',
  'src/settings.factory.ts#SettingsFactory',
  'src/settings.factory.ts#SettingsFactory.prefix',
]

const UNKNOWN_MAILER = `import { Injectable } from '@znight/core'

export interface Mailer {
  send(): void
}

@Injectable()
export class Notifier {
  constructor(readonly mailer: Mailer) {}
}
`

/** The application code of a bundle (`@znight/core` is bundled too: it is a linked package). */
function applicationCode(bundle: string): string {
  return bundle.slice(bundle.indexOf('/src/clock.ts'))
}

describe('vite build', () => {
  const app = integrationApp('app')
  afterAll(() => app.cleanup())
  const logger = recordingLogger()
  const plugin = znight()
  let bundle = ''

  it(
    'builds src/main.ts for Node.js with the generated container',
    async () => {
      await build(viteConfig(app.root, logger, { plugins: [plugin] }))
      expect(fs.readdirSync(`${app.root}/dist`).sort()).toEqual(['main.js', 'main.js.map'])
      bundle = fs.readFileSync(`${app.root}/dist/main.js`, 'utf8')
      const api = plugin.api as ZnightPluginApi
      expect(api.result?.ok).toBe(true)
      // build mode omits source locations from the bundle; the disk copy (for tsc, editors and
      // `znight generate --check`) is the same in every mode
      expect(api.result?.code).not.toContain('source:')
      expect(fs.readFileSync(`${app.root}/${DEFAULT_OUT_FILE}`, 'utf8')).toBe(api.result?.diskCode ?? '')
      expect(api.result?.diskCode).toContain("source: { file: 'src/clock.ts', line: 4, column: 14 }")
      expect(logger.text('info')).toMatch(/\[znight\] 4 providers compiled in \d+ ms/)
      expect(logger.text('warn')).toBe('')
    },
    TIMEOUT,
  )

  it(
    'leaves a disk copy that `znight generate --check` (serve mode) accepts',
    async () => {
      const check = await generate({ root: app.root, check: true })
      expect(check.ok).toBe(true)
      expect(check.stale).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'builds a read-only tree: the disk copy is best-effort (a warning)',
    async () => {
      const other = integrationApp('app')
      const directory = `${other.root}/src/.znight`
      fs.mkdirSync(directory, { recursive: true })
      fs.chmodSync(directory, 0o555)
      try {
        const otherLogger = recordingLogger()
        await build(viteConfig(other.root, otherLogger, { plugins: [znight()] }))
        expect(fs.readdirSync(`${other.root}/dist`).sort()).toEqual(['main.js', 'main.js.map'])
        expect(fs.existsSync(`${directory}/container.generated.ts`)).toBe(false)
        expect(otherLogger.text('warn')).toContain('[znight] cannot write src/.znight/container.generated.ts')
        const result = await run(['node', 'dist/main.js'], other.root)
        expect(report(result.stdout).greeting).toBe('Hello Ada @42')
      } finally {
        fs.chmodSync(directory, 0o755)
        other.cleanup()
      }
    },
    TIMEOUT,
  )

  it('strips every Znight decorator from the bundle', () => {
    const code = applicationCode(bundle)
    expect(code).toContain('var GreetingService = class {')
    expect(code).toContain('["src/greeting.service.ts#GreetingService"]')
    for (const decorator of [/\bInjectable\b/, /\bInject\(/, /\bFactory\(/, /\bProvides\b/, /decorate/]) {
      expect(code).not.toMatch(decorator)
    }
  })

  it(
    'runs on Node.js and Bun',
    async () => {
      for (const runtime of ['node', 'bun']) {
        const result = await run([runtime, 'dist/main.js'], app.root)
        expect(result.stderr).toBe('')
        expect(report(result.stdout)).toEqual({ greeting: 'Hello Ada @42', providers: PROVIDERS })
        expect(result.code).toBe(0)
      }
    },
    TIMEOUT,
  )

  it(
    'maps the bundle back to the TypeScript sources',
    async () => {
      const map = new SourceMap(JSON.parse(fs.readFileSync(`${app.root}/dist/main.js.map`, 'utf8')))
      const source = fs.readFileSync(`${app.root}/src/greeting.service.ts`, 'utf8').split('\n')
      const lines = bundle.split('\n')
      for (const [generated, original] of [
        ['throw new Error("boom from GreetingService")', "throw new Error('boom from GreetingService')"],
        ['greet(name) {', 'greet(name: string): string {'],
        ['var GreetingService = class {', 'export class GreetingService {'],
      ] as const) {
        const line = lines.findIndex(text => text.includes(generated))
        const entry = map.findEntry(line, (lines[line] ?? '').indexOf(generated.slice(0, 5))) as {
          originalSource?: string
          originalLine?: number
        }
        expect(entry.originalSource).toEndWith('/src/greeting.service.ts')
        expect(source[entry.originalLine ?? -1]).toContain(original.slice(0, 12))
      }
      // and Node.js reports errors at their source location
      const thrown = await run(['node', '--enable-source-maps', 'dist/main.js', '--fail'], app.root)
      expect(thrown.code).toBe(1)
      const line = source.findIndex(text => text.includes('boom from GreetingService')) + 1
      expect(thrown.stderr).toContain(`src/greeting.service.ts:${line}:`)
    },
    TIMEOUT,
  )

  it(
    'keeps the decorators with stripDecorators: false (and the bundle still runs)',
    async () => {
      const other = integrationApp('app')
      try {
        await build(viteConfig(other.root, recordingLogger(), { plugins: [znight({ stripDecorators: false })] }))
        const code = applicationCode(fs.readFileSync(`${other.root}/dist/main.js`, 'utf8'))
        expect(code).toContain('__decorate([Injectable()')
        expect(code).toContain('decorateParam(1, Inject("prefix"))')
        const result = await run(['node', 'dist/main.js'], other.root)
        expect(report(result.stdout).greeting).toBe('Hello Ada @42')
      } finally {
        other.cleanup()
      }
    },
    TIMEOUT,
  )
})

describe('dependencies', () => {
  it(
    'stay external (installed in node_modules), the bundle imports them at runtime',
    async () => {
      const app = integrationApp('app', {
        'node_modules/greeting-words/package.json': JSON.stringify({
          name: 'greeting-words',
          version: '1.0.0',
          type: 'module',
          exports: './index.js',
        }),
        'node_modules/greeting-words/index.js': "export const salutation = 'Howdy'\n",
        'src/settings.factory.ts': `import { Factory, Provides } from '@znight/core'
import { salutation } from 'greeting-words'

@Factory()
export class SettingsFactory {
  @Provides({ name: 'prefix' })
  prefix(): string {
    return salutation
  }
}
`,
      })
      try {
        await build(viteConfig(app.root, recordingLogger(), { plugins: [znight()] }))
        const code = fs.readFileSync(`${app.root}/dist/main.js`, 'utf8')
        expect(code).toContain('from "greeting-words"')
        expect(code).not.toContain("'Howdy'")
        const result = await run(['node', 'dist/main.js'], app.root)
        expect(report(result.stdout).greeting).toBe('Howdy Ada @42')
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )
})

describe('vite build errors and warnings', () => {
  it(
    'fails with the formatted diagnostics and writes nothing',
    async () => {
      const app = integrationApp('app', { 'src/notifier.ts': UNKNOWN_MAILER })
      try {
        const logger = recordingLogger()
        const failure = await build(viteConfig(app.root, logger, { plugins: [znight()] })).then(
          () => undefined,
          (error: unknown) => error as Error & { errors?: (Error & Record<string, unknown>)[] },
        )
        expect(failure).toBeDefined()
        const message = stripAnsi(failure?.message ?? '')
        expect(message).toContain('[plugin znight]')
        expect(message).toContain("ZnightError: ✗ ZNIGHT001: Missing provider for 'Mailer' required by Notifier")
        expect(message).toContain(' --> src/notifier.ts:9:32')
        expect(message).toContain('9 |   constructor(readonly mailer: Mailer) {}')
        expect(message).toContain('Build failed with 1 error')
        // no stack frame of the plugin
        expect(message).not.toContain('    at ')
        const cause = failure?.errors?.[0]
        expect(cause?.['plugin']).toBe('znight')
        expect(cause?.['pluginCode']).toBe('ZNIGHT001')
        expect(cause?.['diagnostics']).toHaveLength(1)
        expect(fs.existsSync(`${app.root}/dist`)).toBe(false)
        expect(fs.existsSync(`${app.root}/src/.znight`)).toBe(false)
        // printed once, by Vite, from the error
        expect(logger.text('error')).not.toContain('ZNIGHT001')
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )

  it(
    'prints warnings without failing',
    async () => {
      const app = integrationApp('app', {
        'src/unused.ts': "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Unused {}\n",
      })
      try {
        const logger = recordingLogger()
        await build(viteConfig(app.root, logger, { plugins: [znight({ reportUnused: true })] }))
        const warnings = logger.text('warn')
        expect(warnings).toContain('ZNIGHT019')
        expect(warnings).toContain('Unused')
        expect(warnings).toContain('Build succeeded with')
        expect(fs.existsSync(`${app.root}/dist/main.js`)).toBe(true)
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )
})

describe('app defaults', () => {
  const app = integrationApp('app')
  afterAll(() => app.cleanup())
  const resolve = (plugin = znight(), config = {}) =>
    resolveConfig(viteConfig(app.root, recordingLogger(), { plugins: [plugin], ...config }), 'build')

  it('configure a Node.js server build of src/main.ts', async () => {
    const config = await resolve()
    expect(config.build.ssr).toBe(`${app.root}/src/main.ts`)
    expect(config.build.outDir).toBe('dist')
    expect(config.build.target).toBe('node24')
    expect(config.build.sourcemap).toBe(true)
    expect(config.ssr.target).toBe('node')
  })

  it('never override the user config', async () => {
    const config = await resolve(znight({ app: { entry: 'src/server.ts' } }), {
      build: { outDir: 'out', sourcemap: false, target: 'node22' },
      ssr: { target: 'webworker' },
    })
    expect(config.build.ssr).toBe(`${app.root}/src/server.ts`)
    expect(config.build.outDir).toBe('out')
    expect(config.build.sourcemap).toBe(false)
    expect(config.build.target).toBe('node22')
    expect(config.ssr.target).toBe('webworker')
    expect((await resolve(znight(), { build: { ssr: 'src/other.ts' } })).build.ssr).toBe('src/other.ts')
    expect((await resolve(znight(), { build: { lib: { entry: 'src/index.ts' } } })).build.ssr).toBe(false)
    expect((await resolve(znight({ app: false }))).build.ssr).toBe(false)
  })

  it('expose the options to the CLI as plugin.api.options', () => {
    const options = { outFile: 'src/di.generated.ts', reportUnused: true }
    const api = znight(options).api as ZnightPluginApi
    expect(api.options).toBe(options)
    expect(api.compiler).toBeUndefined()
    expect(api.result).toBeUndefined()
  })
})

describe('several server environments', () => {
  it(
    'share one compile',
    async () => {
      const app = integrationApp('app')
      try {
        const logger = recordingLogger()
        const plugin = znight()
        const builder = await createBuilder(
          viteConfig(app.root, logger, {
            plugins: [plugin],
            environments: {
              ssr: { build: { outDir: 'dist/ssr' } },
              worker: { consumer: 'server', build: { outDir: 'dist/worker' } },
            },
            builder: {
              async buildApp(builder) {
                await builder.build(builder.environments['ssr'] as never)
                await builder.build(builder.environments['worker'] as never)
              },
            },
          }),
        )
        await builder.buildApp()
        expect(logger.messages.filter(message => message.text.includes('[znight]'))).toHaveLength(1)
        for (const environment of ['ssr', 'worker']) {
          const code = applicationCode(fs.readFileSync(`${app.root}/dist/${environment}/main.js`, 'utf8'))
          expect(code).toContain('["src/clock.ts#Clock"]')
          expect(code).not.toContain('Injectable')
          const result = await run(['node', `dist/${environment}/main.js`], app.root)
          expect(report(result.stdout).greeting).toBe('Hello Ada @42')
        }
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )
})

describe('Vite running on Node.js', () => {
  it(
    'builds with the plugin of vite.config.ts (compiler loaded from its sources)',
    async () => {
      const app = integrationApp('app', {
        'vite.config.ts': `import { znight } from '@znight/compiler'

export default {
  plugins: [znight()],
  ssr: { resolve: { conditions: ['@znight/source', 'module', 'node', 'development|production'] } },
}
`,
      })
      try {
        // `--conditions` loads the workspace packages from their TypeScript sources (Node.js type
        // stripping) and `--configLoader native` lets Node.js import vite.config.ts itself
        const result = await run(
          ['node', SOURCE_CONDITION, 'node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native'],
          app.root,
        )
        expect(result.code, result.stdout + result.stderr).toBe(0)
        expect(result.stdout).toMatch(/\[znight\] 4 providers compiled in \d+ ms/)
        const built = await run(['node', 'dist/main.js'], app.root)
        expect(report(built.stdout)).toEqual({ greeting: 'Hello Ada @42', providers: PROVIDERS })
        expect(applicationCode(fs.readFileSync(`${app.root}/dist/main.js`, 'utf8'))).not.toContain('Injectable')
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )
})
