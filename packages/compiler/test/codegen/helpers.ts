import type { CompileOptions, CompileResult, GenerateResult } from '../../src/compiler.ts'
import type { Diagnostic } from '../../src/project/index.ts'

import { fileURLToPath } from 'node:url'

import { compile, generate } from '../../src/compiler.ts'
import { formatDiagnostics } from '../../src/diagnostics/format.ts'
import { realPath, relativePath } from '../../src/project/index.ts'
import { COMPILER_VERSION } from '../../src/version.ts'
import { FIXTURES } from '../project/helpers.ts'

/** Real path of `test/fixtures/codegen`. */
export const CODEGEN: string = `${FIXTURES}/codegen`

/** Real path of the repository root. */
export const REPOSITORY: string = realPath(fileURLToPath(new URL('../../../..', import.meta.url))) as string

/** Root of a codegen fixture. */
export function fixtureRoot(name: string): string {
  return `${CODEGEN}/${name}`
}

/** Compiles a fixture from source (`@znight/source`). */
export function compileFixture(name: string, options: CompileOptions = {}): Promise<CompileResult> {
  return compile({ root: fixtureRoot(name), conditions: ['@znight/source'], ...options })
}

/** Generates (writes) the container module of a fixture. Fails loudly on errors. */
export async function generateFixture(name: string, options: CompileOptions = {}): Promise<GenerateResult> {
  const result = await generate({ root: fixtureRoot(name), conditions: ['@znight/source'], ...options })
  if (!result.ok) {
    throw new Error(`fixture ${name} failed to compile:\n${render(fixtureRoot(name), result.diagnostics)}`)
  }
  return result
}

/** Plain-text diagnostics (no colors), paths relative to `root`. */
export function render(root: string, diagnostics: readonly Diagnostic[]): string {
  return formatDiagnostics(diagnostics, { color: false, cwd: root })
}

/** Generated code with the compiler version replaced (stable snapshots across releases). */
export function stable(code: string): string {
  return code
    .replaceAll(`@znight/compiler ${COMPILER_VERSION}.`, '@znight/compiler <version>.')
    .replaceAll(`compiler: '${COMPILER_VERSION}'`, "compiler: '<version>'")
}

/** `ZNIGHT001 src/x.ts:12` for each diagnostic. */
export function codesOf(root: string, diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(diagnostic => {
    const location = diagnostic.location
    return `${diagnostic.code} ${location ? `${relativePath(root, location.file)}:${location.line}` : '-'}`
  })
}

/** Runs TypeScript 7 (`tsc --noEmit -p <root>`) and returns the error lines located under `root`. */
export function typecheck(root: string): { readonly errors: readonly string[]; readonly output: string } {
  const tsc = `${REPOSITORY}/node_modules/.bin/tsc`
  const result = Bun.spawnSync([tsc, '--noEmit', '-p', `${root}/tsconfig.json`, '--pretty', 'false'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  const errors = output
    .split('\n')
    .filter(line => /error TS\d+/.test(line))
    .filter(line => !line.startsWith('../') && !line.includes('/packages/core/'))
  return { errors, output }
}
