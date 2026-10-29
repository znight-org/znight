/** The `openapi()` Vite plugin in a real `vite build` (with the `znight()` plugin of the compiler). */
import fs from 'node:fs'
import path from 'node:path'
import { znight } from '@znight/compiler'
import { build, createLogger } from 'vite'

import { openapi } from '../src/vite.ts'
import { cleanupApps, fixtureApp } from './support/apps.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

describe('openapi() Vite plugin', () => {
  it('emits dist/openapi.json after the bundle; check fails on a stale committed file, never on dist', async () => {
    const app = fixtureApp('bookshelf')
    const config = (plugins: unknown[]) =>
      ({
        root: app.root,
        configFile: false,
        logLevel: 'silent',
        plugins: [znight({ root: app.root, conditions: ['@znight/source'] }), ...plugins],
        // the workspace packages are bundled from their sources
        environments: {
          ssr: { resolve: { conditions: ['@znight/source', 'module', 'node', 'development|production'] } },
        },
      }) as Parameters<typeof build>[0]
    await build(config([openapi({ runtime: 'bun' })]))
    expect(fs.existsSync(path.join(app.root, 'dist/main.js'))).toBe(true)
    const emitted = app.read('dist/openapi.json')
    expect(JSON.parse(emitted).info.title).toBe('Bookshelf API')
    app.write('openapi.json', '{}\n')
    await expect(build(config([openapi({ runtime: 'bun', output: 'openapi.json', check: true })]))).rejects.toThrow(
      'openapi.json is missing or out of date',
    )
    // CI from a clean checkout: the committed file is checked, the build output written
    const outputs = ['openapi.json', 'dist/openapi.json']
    app.write('openapi.json', emitted)
    fs.rmSync(path.join(app.root, 'dist'), { recursive: true, force: true })
    await build(config([openapi({ runtime: 'bun', output: outputs, check: true })]))
    expect(app.read('dist/openapi.json')).toBe(emitted)
    app.write('openapi.json', '{}\n')
    await expect(build(config([openapi({ runtime: 'bun', output: outputs, check: true })]))).rejects.toThrow(
      'openapi.json is missing or out of date',
    )
    expect(app.read('openapi.json')).toBe('{}\n')
    // every output in build.outDir: nothing to check, dist/openapi.json is written, a warning says so
    const warnings: string[] = []
    const customLogger = {
      ...createLogger('silent'),
      warn: (message: string) => void warnings.push(message),
      warnOnce: (message: string) => void warnings.push(message),
    }
    fs.rmSync(path.join(app.root, 'dist'), { recursive: true, force: true })
    await build({ ...config([openapi({ runtime: 'bun', check: true })]), customLogger })
    expect(app.read('dist/openapi.json')).toBe(emitted)
    expect(warnings.filter(warning => warning.includes('nothing is checked'))).toHaveLength(1)
    // a second instance (znight build --openapi on a config that has one) does nothing
    const first = openapi({ runtime: 'bun', output: 'first.json' })
    await build(config([first, openapi({ runtime: 'bun', output: 'second.json' })]))
    expect(fs.existsSync(path.join(app.root, 'first.json'))).toBe(true)
    expect(fs.existsSync(path.join(app.root, 'second.json'))).toBe(false)
  }, 120_000)
})
