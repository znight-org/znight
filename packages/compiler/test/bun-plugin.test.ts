/**
 * The Bun API, in process: `znightBunPlugin()` against a recording plugin builder (generated module
 * served from memory and recompiled on reload, decorators blanked), `loadZnightConfig()`.
 * `createPreload()` and the `@znight/compiler/bun` preload run in real Bun processes:
 * `integration/bun.test.ts`.
 */
import type { BunOnLoadArgs, BunOnLoadResult, BunPluginBuild } from '../src/bun-plugin.ts'

import fs from 'node:fs'

import { loadZnightConfig, ZNIGHT_CONFIG_FILES, znightBunPlugin } from '../src/bun-plugin.ts'
import { createCompiler } from '../src/compiler.ts'
import { tempApp } from './analysis/helpers.ts'
import { tempDir } from './project/helpers.ts'
import { afterAll, afterEach, describe, expect, test as it } from 'bun:test'

type OnLoad = (args: BunOnLoadArgs) => BunOnLoadResult | Promise<BunOnLoadResult>

/** A plugin builder recording the `onLoad` registrations. */
function recordingBuild(): BunPluginBuild & { readonly handlers: { filter: RegExp; callback: OnLoad }[] } {
  const handlers: { filter: RegExp; callback: OnLoad }[] = []
  return {
    handlers,
    onLoad(constraints, callback) {
      handlers.push({ filter: constraints.filter, callback })
    },
  }
}

/** Loads `file` through the first handler whose filter matches, like Bun does. */
async function load(build: ReturnType<typeof recordingBuild>, file: string): Promise<BunOnLoadResult | undefined> {
  const handler = build.handlers.find(candidate => candidate.filter.test(file))
  return handler === undefined ? undefined : await handler.callback({ path: file })
}

const SERVICE = `import { Inject, Injectable } from '@znight/core'

@Injectable()
export class Service {
  constructor(@Inject('name') readonly name: string) {}
}
`

const FACTORY = `import { Factory, Provides } from '@znight/core'

@Factory()
export class Names {
  @Provides({ name: 'name' })
  name(): string {
    return 'x'
  }
}
`

describe('znightBunPlugin()', () => {
  const app = tempApp({ 'src/service.ts': SERVICE, 'src/names.ts': FACTORY, 'src/plain.ts': 'export const x = 1\n' })
  afterAll(() => app.cleanup())
  const outFile = `${app.root}/src/.znight/container.generated.ts`

  it('serves the generated module from memory and recompiles when it is loaded again (bun --hot)', async () => {
    const plugin = znightBunPlugin({ root: app.root })
    expect(plugin.name).toBe('znight')
    const build = recordingBuild()
    await plugin.setup(build)
    const first = await load(build, outFile)
    expect(first?.loader).toBe('ts')
    expect(first?.contents).toContain("['src/service.ts#Service']")
    expect(fs.existsSync(outFile)).toBe(false)

    app.write('src/extra.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Extra {}\n")
    const second = await load(build, outFile)
    expect(second?.contents).toContain("['src/extra.ts#Extra']")
    app.remove('src/extra.ts')
  })

  it('blanks the decorators of the analysed files only (positions unchanged)', async () => {
    const build = recordingBuild()
    await znightBunPlugin({ root: app.root }).setup(build)
    const service = await load(build, `${app.root}/src/service.ts`)
    expect(service?.loader).toBe('ts')
    expect(service?.contents).toBe(
      SERVICE.replace('@Injectable()', ' '.repeat(13)).replace("@Inject('name')", ' '.repeat(15)),
    )
    const names = await load(build, `${app.root}/src/names.ts`)
    expect(names?.contents).toContain(`  ;${' '.repeat(26)}\n  name(): string`)
    // files without Znight decorators are left to Bun (no handler matches them)
    expect(await load(build, `${app.root}/src/plain.ts`)).toBeUndefined()
    expect(await load(build, `${app.root}/src/service.tsx`)).toBeUndefined()
    // also with Windows separators
    expect(
      build.handlers.some(handler => handler.filter.test(`${app.root}/src/service.ts`.replaceAll('/', '\\'))),
    ).toBe(true)
  })

  it('leaves a file whose content changed since the analysis untouched', async () => {
    const build = recordingBuild()
    await znightBunPlugin({ root: app.root }).setup(build)
    const changed = `${SERVICE}// edited\n`
    app.write('src/service.ts', changed)
    try {
      expect((await load(build, `${app.root}/src/service.ts`))?.contents).toBe(changed)
    } finally {
      app.write('src/service.ts', SERVICE)
    }
  })

  it('does not strip with stripDecorators: false, and reuses a given compiler', async () => {
    const compiler = createCompiler({ root: app.root, stripDecorators: false })
    const result = await compiler.compile()
    const plugin = znightBunPlugin({ compiler })
    expect(plugin.compiler).toBe(compiler)
    const build = recordingBuild()
    await plugin.setup(build)
    expect(build.handlers).toHaveLength(1)
    expect((await load(build, outFile))?.contents).toBe(result.code)
    expect(compiler.last).toBe(result)
  })
})

describe('loadZnightConfig()', () => {
  const dir = tempDir()
  afterAll(() => dir.cleanup())
  afterEach(() => {
    delete process.env['ZNIGHT_CONFIG']
    for (const file of ZNIGHT_CONFIG_FILES) {
      dir.remove(file)
    }
    dir.remove('config')
  })

  it('defaults to { root: cwd } without a config file', async () => {
    expect(await loadZnightConfig(dir.root)).toEqual({ file: undefined, options: { root: dir.root } })
  })

  it('loads znight.config.ts (an object, or a function returning one), root relative to the file', async () => {
    dir.write('znight.config.ts', "export default { outFile: 'src/di.generated.ts', logLevel: 'info' as const }\n")
    expect(await loadZnightConfig(dir.root)).toEqual({
      file: `${dir.root}/znight.config.ts`,
      options: { outFile: 'src/di.generated.ts', logLevel: 'info', root: dir.root },
    })
    dir.remove('znight.config.ts')
    dir.write('znight.config.mjs', "export default async () => ({ root: 'app', prune: true })\n")
    expect((await loadZnightConfig(dir.root)).options).toEqual({ root: `${dir.root}/app`, prune: true })
  })

  it('honours ZNIGHT_CONFIG', async () => {
    dir.write('config/custom.ts', 'export default { reportUnused: true }\n')
    process.env['ZNIGHT_CONFIG'] = 'config/custom.ts'
    expect(await loadZnightConfig(dir.root)).toEqual({
      file: `${dir.root}/config/custom.ts`,
      options: { reportUnused: true, root: `${dir.root}/config` },
    })
    process.env['ZNIGHT_CONFIG'] = 'config/missing.ts'
    await expect(loadZnightConfig(dir.root)).rejects.toThrow('ZNIGHT_CONFIG points to a missing file')
  })

  it('rejects a config that is not an options object', async () => {
    dir.write('znight.config.js', 'export default [1, 2]\n')
    await expect(loadZnightConfig(dir.root)).rejects.toThrow('must default-export the compiler options')
  })
})
