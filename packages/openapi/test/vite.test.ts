/** The `openapi()` Vite plugin in a real `vite build` (with the `znight()` plugin of the compiler). */
import fs from 'node:fs'
import path from 'node:path'
import { znight } from '@znight/compiler'
import { build } from 'vite'

import { openapi } from '../src/vite.ts'
import { cleanupApps, fixtureApp } from './support/apps.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

describe('openapi() Vite plugin', () => {
  it('emits dist/openapi.json after the bundle, then fails a check when the file is stale', async () => {
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
    // a second instance (znight build --openapi on a config that has one) does nothing
    const first = openapi({ runtime: 'bun', output: 'first.json' })
    await build(config([first, openapi({ runtime: 'bun', output: 'second.json' })]))
    expect(fs.existsSync(path.join(app.root, 'first.json'))).toBe(true)
    expect(fs.existsSync(path.join(app.root, 'second.json'))).toBe(false)
  }, 120_000)
})
