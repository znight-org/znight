/**
 * Child process of the golden test: compiles one example application with the `@znight/compiler`
 * the example resolves (its sources with `--conditions=@znight/source`, its `dist` otherwise) and
 * prints the generated modules as JSON on stdout. Runs unchanged on Node.js (type stripping) and Bun.
 *
 * ```sh
 * node --conditions=@znight/source tests/support/compile-example.ts examples/rest-api source
 * bun tests/support/compile-example.ts examples/rest-api dist
 * ```
 *
 * `source`: the scan conditions include `@znight/source` (packages are analysed from their
 * TypeScript sources); `dist`: they do not (packages are analysed from their declaration files).
 * Nothing is written: `compile()` is pure.
 */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The part of `@znight/compiler` used here. */
interface CompilerModule {
  compile(options: Record<string, unknown>): Promise<{
    readonly ok: boolean
    readonly code: string
    readonly diagnostics: readonly unknown[]
  }>
  formatDiagnostics(diagnostics: readonly unknown[], options: { cwd: string; color: boolean }): string
  loadZnightConfig(
    cwd: string,
  ): Promise<{ readonly file: string | undefined; readonly options: Record<string, unknown> }>
}

/** What the golden test reads on stdout. */
export interface CompiledExample {
  /** The `@znight/compiler` entry that was loaded (sources or dist). */
  readonly compiler: string
  readonly modes: Record<string, { readonly ok: boolean; readonly code: string; readonly diagnostics: string }>
}

const SOURCE_CONDITION = '@znight/source'
const MODES = ['build', 'serve'] as const

const [rootArgument, variant] = process.argv.slice(2)
if (rootArgument === undefined || (variant !== 'source' && variant !== 'dist')) {
  throw new Error('usage: compile-example.ts <root> <source|dist>')
}
const root = resolve(rootArgument)
const compilerEntry = createRequire(join(root, 'package.json')).resolve('@znight/compiler')
const compiler = (await import(pathToFileURL(compilerEntry).href)) as CompilerModule

const { options } = await compiler.loadZnightConfig(root)
// `logLevel` is an option of the Bun preload; the conditions are what this variant sets
const { logLevel: _logLevel, conditions: configured, ...rest } = options
const base = Array.isArray(configured) ? (configured as string[]) : []
const conditions =
  variant === 'source'
    ? [...new Set([...base, SOURCE_CONDITION])]
    : base.filter(condition => condition !== SOURCE_CONDITION)

const modes: CompiledExample['modes'] = {}
for (const mode of MODES) {
  const result = await compiler.compile({ ...rest, root, mode, conditions })
  modes[mode] = {
    ok: result.ok,
    code: result.code,
    diagnostics: compiler.formatDiagnostics(result.diagnostics, { cwd: root, color: false }),
  }
}
const output: CompiledExample = { compiler: compilerEntry, modes }
process.stdout.write(JSON.stringify(output))
