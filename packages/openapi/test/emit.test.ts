/**
 * `emitOpenApi()` (§7.5 of RFC 0002): the modules run in a child process (Bun preload or a Vite
 * server on Node.js), the files are byte-identical on both runtimes and equal to the in-process
 * assembly; `check`, YAML, converters, compile errors and isolation of module side effects.
 */
import type { TempApp } from './support/apps.ts'

import fs from 'node:fs'
import path from 'node:path'

import { emitOpenApi } from '../src/emit/index.ts'
import { buildOpenApiDocument } from '../src/index.ts'
import { cleanupApps, fixtureApp, loadApp, tempApp } from './support/apps.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

/** The workspace runs from sources: the compiler analyses `@znight/*` with the source condition. */
const compilerOptions = (app: TempApp): Record<string, unknown> => ({ root: app.root, conditions: ['@znight/source'] })

describe('emitOpenApi', () => {
  let app: TempApp

  beforeAll(() => {
    app = fixtureApp('bookshelf')
    app.write(
      'src/side-effect.ts',
      "import { writeFileSync } from 'node:fs'\nwriteFileSync('side-effect.txt', 'ran')\n;(globalThis as Record<string, unknown>).__emitSideEffect = true\nexport const marker = 1\n",
    )
    // a module of the generated graph (main.ts is not part of it)
    app.write(
      'src/orders/order.controller.ts',
      `import '../side-effect.ts'\n${app.read('src/orders/order.controller.ts')}`,
    )
    app.write('src/openapi.converters.ts', "export default [{ name: 'noop', convert: () => undefined }]\n")
  })

  it('writes byte-identical files with Bun and Node.js, equal to the in-process assembly', async () => {
    const bun = await emitOpenApi({
      root: app.root,
      runtime: 'bun',
      output: 'bun.json',
      compilerOptions: compilerOptions(app),
    })
    const node = await emitOpenApi({
      root: app.root,
      runtime: 'node',
      output: ['node.json', 'docs/openapi.yaml'],
      compilerOptions: compilerOptions(app),
      prefix: '/api',
    })
    expect(bun.ok && node.ok).toBe(true)
    expect(bun.written).toEqual([path.join(app.root, 'bun.json')])
    expect(node.runtime).toBe('node')
    const inProcess = await buildOpenApiDocument(await loadApp(fixtureApp('bookshelf')))
    expect(app.read('bun.json')).toBe(inProcess.json)
    expect(JSON.parse(app.read('node.json'))).toEqual({ ...JSON.parse(inProcess.json), servers: [{ url: '/api' }] })
    expect(app.read('docs/openapi.yaml')).toStartWith('openapi: 3.1.1\n')
    expect((globalThis as Record<string, unknown>)['__emitSideEffect']).toBeUndefined()
    expect(fs.existsSync(path.join(app.root, 'side-effect.txt'))).toBe(true)
  }, 60_000)

  it('checks without writing: missing, fresh and stale outputs', async () => {
    const missing = await emitOpenApi({
      root: app.root,
      runtime: 'bun',
      output: 'check.json',
      check: true,
      compilerOptions: compilerOptions(app),
    })
    expect([missing.stale, missing.staleFiles, missing.written]).toEqual([
      true,
      [path.join(app.root, 'check.json')],
      [],
    ])
    expect(fs.existsSync(path.join(app.root, 'check.json'))).toBe(false)
    await emitOpenApi({ root: app.root, runtime: 'bun', output: 'check.json', compilerOptions: compilerOptions(app) })
    const unchanged = await emitOpenApi({
      root: app.root,
      runtime: 'bun',
      output: 'check.json',
      compilerOptions: compilerOptions(app),
    })
    expect(unchanged.written).toEqual([])
    const fresh = await emitOpenApi({
      root: app.root,
      runtime: 'bun',
      output: 'check.json',
      check: true,
      compilerOptions: compilerOptions(app),
    })
    expect(fresh.stale).toBe(false)
    app.write('check.json', '{}\n')
    const stale = await emitOpenApi({
      root: app.root,
      runtime: 'bun',
      output: 'check.json',
      check: true,
      compilerOptions: compilerOptions(app),
    })
    expect(stale.staleFiles).toEqual([path.join(app.root, 'check.json')])
  }, 60_000)

  it('loads converters from a module', async () => {
    const result = await emitOpenApi({
      root: app.root,
      runtime: 'bun',
      output: 'converted.json',
      converters: 'src/openapi.converters.ts',
      compilerOptions: compilerOptions(app),
    })
    expect(result.ok).toBe(true)
    await expect(
      emitOpenApi({
        root: app.root,
        runtime: 'bun',
        converters: 'src/missing.ts',
        compilerOptions: compilerOptions(app),
      }),
    ).rejects.toMatchObject({ code: 'ZNIGHT030' })
  }, 60_000)

  it('stops on compile errors before any module runs', async () => {
    const broken = tempApp({
      'src/main.ts':
        "import { OpenApiPlugin } from '@znight/openapi'\nimport './effect.ts'\nexport const plugin = OpenApiPlugin\n",
      'src/effect.ts': "import { writeFileSync } from 'node:fs'\nwriteFileSync('ran.txt', 'ran')\n",
      'src/service.ts':
        "import { Injectable } from '@znight/core'\n@Injectable()\nexport class A { constructor(readonly missing: Missing) {} }\nexport class Missing {}\n",
      'src/controller.ts':
        "import { Controller, Get } from '@znight/http'\n@Controller('/a')\nexport class AController {\n  @Get()\n  a(): bigint { return 1n }\n}\n",
    })
    const result = await emitOpenApi({ root: broken.root, runtime: 'bun', compilerOptions: compilerOptions(broken) })
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics.some(diagnostic => diagnostic.code === 'ZNIGHT032' && diagnostic.severity === 'error'),
    ).toBe(true)
    expect(fs.existsSync(path.join(broken.root, 'ran.txt'))).toBe(false)
    expect(fs.existsSync(path.join(broken.root, 'openapi.json'))).toBe(false)
  }, 60_000)

  it('reports assembly failures with their code', async () => {
    const failing = tempApp({
      'src/main.ts': "import { OpenApiPlugin } from '@znight/openapi'\nexport const plugin = OpenApiPlugin\n",
      'src/schemas.ts': "import { z } from 'zod'\nexport const Out = z.object({ n: z.string().transform(Number) })\n",
      'src/controller.ts': `import { Controller, Get } from '@znight/http'
import { ApiResponse } from '@znight/openapi'
import { Out } from './schemas.ts'
@Controller('/a')
export class AController {
  @Get()
  @ApiResponse(200, { schema: Out })
  a(): Response { return new Response() }
}
`,
    })
    await expect(
      emitOpenApi({ root: failing.root, runtime: 'bun', compilerOptions: compilerOptions(failing) }),
    ).rejects.toMatchObject({
      code: 'ZNIGHT037',
    })
  }, 60_000)
})
