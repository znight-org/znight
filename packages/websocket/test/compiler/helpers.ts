/**
 * Helpers of the compiler extension tests: throw-away applications linked to the workspace packages,
 * compiled with `compile()` (the extension discovered through the manifest).
 */
import type { CompileResult, Diagnostic, ZnightOptions } from '@znight/compiler'
import type { ZnightMetadata } from '@znight/core'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@znight/compiler'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Real path of `packages/websocket`. */
export const WEBSOCKET_ROOT: string = fs.realpathSync.native(path.resolve(here, '../..'))
const PACKAGES = path.dirname(WEBSOCKET_ROOT)

const LINKS: Readonly<Record<string, string>> = {
  '@znight/core': fs.realpathSync.native(path.join(PACKAGES, 'core')),
  '@znight/http': fs.realpathSync.native(path.join(PACKAGES, 'http')),
  '@znight/websocket': WEBSOCKET_ROOT,
  zod: fs.realpathSync.native(path.join(WEBSOCKET_ROOT, 'node_modules/zod')),
  '@types/node': fs.realpathSync.native(path.join(PACKAGES, '../node_modules/@types/node')),
}

/** A temporary application. */
export interface TempApp {
  readonly root: string
  write(relative: string, content: string): void
  cleanup(): void
}

const created: TempApp[] = []

/** Creates an application in a temporary directory (`package.json`, `tsconfig.json`, linked packages). */
export function tempApp(files: Readonly<Record<string, string>> = {}): TempApp {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-websocket-'))).replaceAll('\\', '/')
  const app: TempApp = {
    root,
    write(relative, content) {
      const file = path.join(root, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  app.write('package.json', JSON.stringify({ name: 'websocket-app', private: true, type: 'module' }))
  app.write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'preserve',
        moduleResolution: 'bundler',
        customConditions: ['@znight/source'],
        experimentalDecorators: true,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
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

/** Removes every temporary application created so far (call it in `afterAll`). */
export function cleanupApps(): void {
  for (const app of created.splice(0)) app.cleanup()
}

/** Compiles an application (the extension is discovered through the manifest). */
export function compileApp(root: string, options: ZnightOptions = {}): Promise<CompileResult> {
  return compile({ root, conditions: ['@znight/source'], ...options })
}

/** `severity code file:line:column message` lines (paths relative to the root), hints and related indented. */
export function render(root: string, diagnostics: readonly Diagnostic[], codes?: readonly string[]): string[] {
  return diagnostics
    .filter(diagnostic => codes === undefined || codes.includes(diagnostic.code))
    .map(diagnostic => {
      const location = diagnostic.location
      const where = location ? `${path.relative(root, location.file)}:${location.line}:${location.column}` : '-'
      return [
        `${diagnostic.severity} ${diagnostic.code} ${where} ${diagnostic.message}`,
        ...(diagnostic.hints ?? []).map(hint => `  = ${hint}`),
        ...(diagnostic.related ?? []).map(
          related =>
            `  - ${related.message} (${path.relative(root, related.location.file)}:${related.location.line}:${related.location.column})`,
        ),
      ].join('\n')
    })
}

/** Compiles, writes the generated module and imports it (fails on error diagnostics). */
export async function compileAndLoad(
  app: TempApp,
): Promise<{ readonly result: CompileResult; readonly metadata: ZnightMetadata }> {
  const result = await compileApp(app.root)
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length > 0) throw new Error(`compile failed:\n${render(app.root, errors).join('\n')}`)
  app.write(path.relative(app.root, result.outFile), result.code)
  const module = (await import(result.outFile)) as { __ZNIGHT_METADATA__: ZnightMetadata }
  return { result, metadata: module.__ZNIGHT_METADATA__ }
}
