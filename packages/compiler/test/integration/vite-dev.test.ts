/**
 * The `znight()` plugin in a Vite dev server, used like Vitest does (middleware mode, modules run
 * by the SSR module runner): in-memory generated module (also before the disk copy exists),
 * stripped decorators, debounced incremental recompiles, error module, reloads.
 */
import type { ViteDevServer } from 'vite'
import type { ZnightPluginApi } from '../../src/vite.ts'

import fs from 'node:fs'
import { createServer } from 'vite'

import { DEFAULT_OUT_FILE } from '../../src/options.ts'
import { znight } from '../../src/vite.ts'
import { integrationApp, recordingLogger, sleep, viteConfig, waitFor } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const TIMEOUT = 30_000

const TEST_MODULE = `import { __ZNIGHT_METADATA__ } from '../src/.znight/container.generated.js'

export const tokens = Object.keys(__ZNIGHT_METADATA__.providers)
export const clockSource = __ZNIGHT_METADATA__.providers['src/clock.ts#Clock']?.source
`

interface TestModule {
  readonly tokens: readonly string[]
  readonly clockSource: unknown
}

interface ModuleRunner {
  import(url: string): Promise<unknown>
}

describe('dev server (Vitest-like)', () => {
  const app = integrationApp('app', { 'test/metadata.ts': TEST_MODULE })
  const logger = recordingLogger()
  const plugin = znight()
  const api = plugin.api as ZnightPluginApi
  const outFile = `${app.root}/${DEFAULT_OUT_FILE}`
  let server: ViteDevServer
  let runner: ModuleRunner
  const previousVitest = process.env['VITEST']

  beforeAll(async () => {
    process.env['VITEST'] = 'true'
    server = await createServer(
      viteConfig(app.root, logger, {
        plugins: [plugin],
        server: { middlewareMode: true, ws: false },
        appType: 'custom',
      }),
    )
    runner = (server.environments['ssr'] as unknown as { runner: ModuleRunner }).runner
  }, TIMEOUT)

  afterAll(async () => {
    if (previousVitest === undefined) {
      delete process.env['VITEST']
    } else {
      process.env['VITEST'] = previousVitest
    }
    await server.close()
    app.cleanup()
  })

  const metadata = async (): Promise<TestModule> => (await runner.import('/test/metadata.ts')) as TestModule

  /** The module once it satisfies `predicate` (a reload triggered by a change may still be running). */
  async function eventually(predicate: (module: TestModule) => boolean, what: string): Promise<TestModule> {
    let module: TestModule | undefined
    await waitFor(async () => {
      module = await metadata().catch(() => undefined)
      return module !== undefined && predicate(module)
    }, what)
    return module as TestModule
  }

  it(
    'serves the generated module from memory, before the disk copy exists',
    async () => {
      expect(fs.existsSync(outFile)).toBe(false)
      const module = await metadata()
      expect(module.tokens).toEqual([
        'src/clock.ts#Clock',
        'src/greeting.service.ts#GreetingService',
        'src/settings.factory.ts#SettingsFactory',
        'src/settings.factory.ts#SettingsFactory.prefix',
      ])
      // test mode (Vitest): provider source locations are emitted
      expect(module.clockSource).toEqual({ file: 'src/clock.ts', line: 4, column: 14 })
      expect(api.compiler?.mode).toBe('test')
      await waitFor(() => fs.existsSync(outFile), 'the disk copy')
      expect(fs.readFileSync(outFile, 'utf8')).toBe(api.result?.code ?? '')
    },
    TIMEOUT,
  )

  it('strips the Znight decorators from transformed modules', async () => {
    const transformed = await server.environments['ssr']?.transformRequest('/src/greeting.service.ts')
    expect(transformed?.code).toContain('class GreetingService')
    expect(transformed?.code).not.toMatch(/@Injectable|@Inject\(|Injectable\(\)|Inject\("prefix"\)/)
    const map = transformed?.map as { mappings?: string } | null | undefined
    expect(map?.mappings?.length ?? 0).toBeGreaterThan(0)
    // the plugin applies to the server environments only
    const client = await server.environments['client']?.transformRequest('/src/greeting.service.ts')
    expect(client?.code).toContain('Injectable()')
  })

  it(
    'recompiles once per burst of changes and reloads the generated module',
    async () => {
      const first = api.result
      const summaries = logger.messages.length
      app.write('src/a.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class A {}\n")
      app.write('src/b.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class B {}\n")
      app.write('src/c.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class C {}\n")
      await waitFor(() => api.result !== first && (api.result?.stats.providers ?? 0) === 7, 'the recompile')
      await sleep(300)
      const compiled = logger.messages.slice(summaries).filter(message => message.text.includes('[znight]'))
      expect(compiled).toHaveLength(1)
      expect(compiled[0]?.text).toContain('7 providers')
      await eventually(module => module.tokens.includes('src/c.ts#C'), 'the reloaded module')
      expect(fs.readFileSync(outFile, 'utf8')).toContain("['src/c.ts#C']")

      for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
        app.remove(file)
      }
      await waitFor(() => (api.result?.stats.providers ?? 0) === 4, 'the deletions')
      await eventually(module => module.tokens.length === 4, 'the reloaded module')
    },
    TIMEOUT,
  )

  it(
    'serves the error module on compile errors, keeps the disk copy, then recovers',
    async () => {
      const good = fs.readFileSync(outFile, 'utf8')
      app.write(
        'src/notifier.ts',
        "import { Injectable } from '@znight/core'\nexport interface Mailer {}\n@Injectable()\nexport class Notifier {\n  constructor(readonly mailer: Mailer) {}\n}\n",
      )
      await waitFor(() => api.result?.ok === false, 'the failed compile')
      expect(logger.text('error')).toContain("✗ ZNIGHT001: Missing provider for 'Mailer' required by Notifier")
      expect(fs.readFileSync(outFile, 'utf8')).toBe(good)
      const failure = await metadata().then(
        () => undefined,
        (error: unknown) => error as Error,
      )
      expect(failure?.name).toBe('ZnightError')
      expect(failure?.message).toContain(' --> src/notifier.ts:5:32')

      app.remove('src/notifier.ts')
      await waitFor(() => api.result?.ok === true, 'the fixed compile')
      await eventually(module => module.tokens.length === 4, 'the recovered module')
    },
    TIMEOUT,
  )

  it(
    'recompiles when a file read outside the include globs changes, or is created where an import failed',
    async () => {
      app.write('shared/names.ts', "export const NAME = 'alpha'\n")
      app.write(
        'src/named.ts',
        "import { Injectable } from '@znight/core'\nimport { NAME } from '../shared/names.ts'\n@Injectable({ name: NAME })\nexport class Named {}\n",
      )
      await waitFor(() => api.result?.code.includes("name: 'alpha'") === true, 'the named provider')
      expect(api.result?.watchFiles).toContain(`${app.root}/shared/names.ts`)

      app.write('shared/names.ts', "export const NAME = 'beta'\n")
      await waitFor(() => api.result?.code.includes("name: 'beta'") === true, 'the recompile')

      app.write(
        'src/named.ts',
        "import { Injectable } from '@znight/core'\nimport { LATER } from '../shared/later.ts'\n@Injectable({ name: LATER })\nexport class Named {}\n",
      )
      await waitFor(() => api.result?.ok === false, 'the failed compile')
      app.write('shared/later.ts', "export const LATER = 'later'\n")
      await waitFor(() => api.result?.code.includes("name: 'later'") === true, 'the fixed compile')

      for (const file of ['src/named.ts', 'shared']) {
        app.remove(file)
      }
      await waitFor(() => api.result?.ok === true && api.result.stats.providers === 4, 'the deletions')
    },
    TIMEOUT,
  )

  it(
    'recompiles on package.json changes and ignores writes to the generated module',
    async () => {
      const before = api.result
      fs.appendFileSync(outFile, '\n// touched\n')
      await sleep(300)
      expect(api.result).toBe(before)
      const manifest = JSON.parse(fs.readFileSync(`${app.root}/package.json`, 'utf8'))
      app.write('package.json', JSON.stringify({ ...manifest, description: 'changed' }, null, 2))
      await waitFor(() => api.result !== before, 'the recompile')
      expect(api.result?.ok).toBe(true)
    },
    TIMEOUT,
  )
})
