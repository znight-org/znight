/**
 * Throw-away applications linked to the workspace packages, compiled with `compile()` of
 * `@znight/compiler` (the openapi extension is discovered through the manifest), and their
 * generated metadata imported.
 */
import type { Diagnostic } from '@znight/compiler'
import type { ZnightMetadata } from '@znight/core'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@znight/compiler'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Real path of `packages/openapi`. */
export const OPENAPI_ROOT: string = fs.realpathSync.native(path.resolve(here, '../..'))

const modules = (name: string): string => fs.realpathSync.native(path.join(OPENAPI_ROOT, 'node_modules', name))

/** Packages linked into the `node_modules` of temporary applications. */
const LINKS: Readonly<Record<string, string>> = {
  '@znight/core': modules('@znight/core'),
  '@znight/http': modules('@znight/http'),
  '@znight/openapi': OPENAPI_ROOT,
  zod: modules('zod'),
  valibot: modules('valibot'),
  arktype: modules('arktype'),
  '@valibot/to-json-schema': modules('@valibot/to-json-schema'),
  '@types/node': fs.realpathSync.native(path.join(OPENAPI_ROOT, '../../node_modules/@types/node')),
}

/** A temporary application. */
export interface TempApp {
  readonly root: string
  write(relative: string, content: string): void
  read(relative: string): string
  cleanup(): void
}

const created: TempApp[] = []

/** Creates an application in a temporary directory with `files`. */
export function tempApp(files: Readonly<Record<string, string>> = {}, manifest: Record<string, unknown> = {}): TempApp {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-openapi-')))
  const app: TempApp = {
    root,
    write(relative, content) {
      const file = path.join(root, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    },
    read(relative) {
      return fs.readFileSync(path.join(root, relative), 'utf8')
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  app.write(
    'package.json',
    JSON.stringify({ name: 'temp-app', version: '1.2.3', private: true, type: 'module', ...manifest }, null, 2),
  )
  app.write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, experimentalDecorators: true, module: 'preserve', target: 'ES2024' },
    }),
  )
  for (const [name, target] of Object.entries(LINKS)) {
    const link = path.join(root, 'node_modules', name)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(target, link, 'dir')
  }
  for (const [relative, content] of Object.entries(files)) app.write(relative, content)
  created.push(app)
  return app
}

/** Removes every temporary application created so far. */
export function cleanupApps(): void {
  for (const app of created.splice(0)) app.cleanup()
}

/** Result of {@link compileApp}. */
export interface CompiledApp {
  readonly diagnostics: readonly Diagnostic[]
  readonly code: string
  readonly outFile: string
  readonly ok: boolean
}

/** Compiles an application (serve mode, workspace sources). */
export async function compileApp(app: TempApp, options: Record<string, unknown> = {}): Promise<CompiledApp> {
  const result = await compile({ root: app.root, conditions: ['@znight/source'], mode: 'test', ...options })
  return { diagnostics: result.diagnostics, code: result.code, outFile: result.outFile, ok: result.ok }
}

let counter = 0

/** Compiles, writes the generated module and imports it. Throws on compile errors. */
export async function loadApp(app: TempApp, options: Record<string, unknown> = {}): Promise<ZnightMetadata> {
  const result = await compileApp(app, options)
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length > 0) throw new Error(render(app, errors).join('\n'))
  fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
  fs.writeFileSync(result.outFile, result.code)
  const module = (await import(`${pathToFileURL(result.outFile).href}?v=${++counter}`)) as {
    __ZNIGHT_METADATA__: ZnightMetadata
  }
  return module.__ZNIGHT_METADATA__
}

/** `severity code file:line:column message` lines (paths relative to the app root). */
export function render(app: { readonly root: string }, diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(diagnostic => {
    const location = diagnostic.location
    const where = location ? `${path.relative(app.root, location.file)}:${location.line}:${location.column}` : '-'
    return `${diagnostic.severity} ${diagnostic.code} ${where} ${diagnostic.message}`
  })
}

/** Diagnostics of the openapi codes (and ZNIGHT005), rendered. */
export function openapiDiagnostics(app: TempApp, result: CompiledApp): string[] {
  return render(
    app,
    result.diagnostics.filter(diagnostic => /^ZNIGHT0(0[5]|3\d)$/.test(diagnostic.code)),
  )
}

/** Copies `test/fixtures/<name>` into a temporary application. */
export function fixtureApp(name: string, manifest: Record<string, unknown> = {}): TempApp {
  const app = tempApp({}, manifest)
  fs.cpSync(path.join(OPENAPI_ROOT, 'test/fixtures', name), app.root, { recursive: true })
  return app
}

/** Validates a document against the OpenAPI 3.1 JSON Schema (`@seriousme/openapi-schema-validator`). */
export async function validateDocument(document: unknown): Promise<{ valid: boolean; errors: unknown }> {
  const { Validator } = await import('@seriousme/openapi-schema-validator')
  const result = await new Validator().validate(
    structuredClone(document) as Parameters<InstanceType<typeof Validator>['validate']>[0],
  )
  return { valid: result.valid, errors: result.errors }
}

let bookshelf: Promise<ZnightMetadata> | undefined

/** The metadata of the bookshelf fixture (compiled once per test file). */
export function bookshelfMetadata(): Promise<ZnightMetadata> {
  bookshelf ??= loadApp(fixtureApp('bookshelf'))
  return bookshelf
}
