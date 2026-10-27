/**
 * The child process of `emitOpenApi()` (§7.5 of RFC 0002): loads the generated module of the
 * application (nothing is instantiated: no container, no plugin, no port), builds the document and
 * writes the result as JSON. Module side effects and globals stay in this process.
 *
 * - Bun: the compiler's preload serves the generated module and blanks the decorators.
 * - Node.js: a Vite server in middleware mode runs the module with the project config (the
 *   `znight()` plugin serves the generated module from memory).
 *
 * Usage: `<runtime> child <payload.json>` (the payload says where to write the result).
 */
import type { ZnightMetadata } from '@znight/core'
import type { SchemaConverter } from '../converters.ts'
import type { ChildPayload, ChildResult } from './protocol.ts'

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildOpenApiDocument } from '../build.ts'

const payload = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as ChildPayload

/** Imports a package as installed in the project (falls back to `@znight/openapi`'s resolution). */
function importFromProject(specifier: string): Promise<unknown> {
  let resolved: string | undefined
  try {
    resolved = createRequire(join(payload.root, 'package.json')).resolve(specifier)
  } catch {
    resolved = undefined
  }
  return import(resolved === undefined ? specifier : pathToFileURL(resolved).href)
}

function convertersOf(module: unknown, file: string): SchemaConverter[] {
  const value = (module as { default?: unknown } | undefined)?.default
  if (!Array.isArray(value) || value.some(converter => typeof (converter as SchemaConverter)?.convert !== 'function')) {
    throw new Error(`${file} must export an array of SchemaConverter as default export`)
  }
  return value as SchemaConverter[]
}

interface Loaded {
  readonly metadata: ZnightMetadata
  readonly converters: SchemaConverter[]
  close(): Promise<void>
}

async function loadWithBun(): Promise<Loaded> {
  const compiler = (await importFromProject('@znight/compiler')) as {
    createPreload(options: Record<string, unknown>): Promise<unknown>
    loadZnightConfig(cwd: string): Promise<{ file: string | undefined; options: Record<string, unknown> }>
  }
  const config = await compiler.loadZnightConfig(payload.root)
  const options = config.file === undefined ? payload.compilerOptions : config.options
  await compiler.createPreload({ ...options, root: payload.root, mode: 'serve', logLevel: 'silent' })
  const module = (await import(pathToFileURL(payload.outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata }
  const converters =
    payload.converters === undefined
      ? []
      : convertersOf(await import(pathToFileURL(payload.converters).href), payload.converters)
  return { metadata: module.__ZNIGHT_METADATA__, converters, close: async () => {} }
}

interface ViteLike {
  createServer(config: Record<string, unknown>): Promise<{
    readonly environments: Record<string, unknown>
    close(): Promise<void>
  }>
  isRunnableDevEnvironment?(environment: unknown): boolean
}

async function loadWithVite(): Promise<Loaded> {
  const vite = (await importFromProject('vite')) as ViteLike
  const plugins: unknown[] = []
  if (payload.viteConfig === false) {
    const compiler = (await importFromProject('@znight/compiler')) as { znight(options: unknown): unknown }
    plugins.push(compiler.znight({ ...payload.compilerOptions, root: payload.root }))
  }
  const server = await vite.createServer({
    root: payload.root,
    configFile: payload.viteConfig,
    ...(payload.configLoader === undefined ? {} : { configLoader: payload.configLoader }),
    appType: 'custom',
    logLevel: 'error',
    clearScreen: false,
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    plugins,
    ...(payload.sourceConditions === true
      ? {
          environments: {
            ssr: {
              resolve: {
                conditions: ['@znight/source', 'module', 'node', 'development|production'],
                externalConditions: ['@znight/source', 'node'],
              },
            },
          },
        }
      : {}),
  })
  try {
    const environment = server.environments['ssr'] as { runner?: { import(url: string): Promise<unknown> } }
    if (typeof vite.isRunnableDevEnvironment === 'function' && !vite.isRunnableDevEnvironment(environment)) {
      throw new Error('the ssr environment of the Vite config cannot run modules (isRunnableDevEnvironment)')
    }
    const runner = environment.runner
    if (runner === undefined) throw new Error('the ssr environment of the Vite config has no module runner')
    const module = (await runner.import(payload.outFile)) as { __ZNIGHT_METADATA__: ZnightMetadata }
    const converters =
      payload.converters === undefined ? [] : convertersOf(await runner.import(payload.converters), payload.converters)
    return { metadata: module.__ZNIGHT_METADATA__, converters, close: () => server.close() }
  } catch (error) {
    await server.close()
    throw error
  }
}

let result: ChildResult
try {
  const loaded = payload.runtime === 'bun' ? await loadWithBun() : await loadWithVite()
  try {
    const built = await buildOpenApiDocument(loaded.metadata, {
      ...(payload.prefix === undefined ? {} : { prefix: payload.prefix }),
      converters: loaded.converters,
    })
    result = { ok: true, json: built.json, warnings: built.warnings, stats: built.stats }
  } finally {
    await loaded.close()
  }
} catch (error) {
  const details = error as { code?: unknown; hints?: unknown; message?: unknown }
  result = {
    ok: false,
    error: {
      code: typeof details.code === 'string' ? details.code : undefined,
      message: error instanceof Error ? error.message : String(error),
      hints: Array.isArray(details.hints) ? (details.hints as string[]) : [],
    },
  }
}
writeFileSync(payload.result, JSON.stringify(result))
process.exit(0)
