/**
 * Helpers of the compiler extension tests: throw-away applications linked to the workspace packages,
 * analysis with the extension given explicitly, `compile()` (extension discovered through the
 * manifest, or given configured) to generate the real module, and the formatted diagnostics.
 */
import type { AnalysisResult, CompileResult, CompilerExtension, Diagnostic, ZnightOptions } from '@znight/compiler'
import type { GraphQLCompilerOptions, GraphQLData } from '../../src/compiler/index.ts'

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, compile, formatDiagnostics, normalizeOptions, Project } from '@znight/compiler'

import graphql from '../../src/compiler/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Real path of `packages/graphql`. */
export const GRAPHQL_ROOT: string = fs.realpathSync.native(path.resolve(here, '../..'))
const PACKAGES = path.dirname(GRAPHQL_ROOT)
const MODULES = path.join(GRAPHQL_ROOT, 'node_modules')

/** The TypeScript compiler of the repository. */
export const TSC: string = fs.realpathSync.native(path.join(PACKAGES, '../node_modules/typescript/bin/tsc'))

/** Packages linked into the `node_modules` of temporary applications. */
const LINKS: Readonly<Record<string, string>> = {
  '@znight/core': fs.realpathSync.native(path.join(MODULES, '@znight/core')),
  '@znight/graphql': GRAPHQL_ROOT,
  '@znight/http': fs.realpathSync.native(path.join(MODULES, '@znight/http')),
  graphql: fs.realpathSync.native(path.join(MODULES, 'graphql')),
  '@types/node': fs.realpathSync.native(path.join(PACKAGES, '../node_modules/@types/node')),
}

/** A temporary application. */
export interface TempApp {
  readonly root: string
  write(relative: string, content: string): void
  read(relative: string): string
  path(relative: string): string
  cleanup(): void
}

const created: TempApp[] = []

/** Creates an application in a temporary directory (`package.json`, `tsconfig.json`, linked packages). */
export function tempApp(files: Readonly<Record<string, string>> = {}): TempApp {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-graphql-'))).replaceAll('\\', '/')
  const app: TempApp = {
    root,
    write(relative, content) {
      const file = path.join(root, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    },
    read: relative => fs.readFileSync(path.join(root, relative), 'utf8'),
    path: relative => `${root}/${relative}`,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  app.write('package.json', JSON.stringify({ name: 'graphql-app', private: true, type: 'module' }))
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

/** Analysis result plus its project and the data stored by the extension. */
export interface GraphQLAnalysis extends AnalysisResult {
  readonly project: Project
  readonly root: string
  readonly stored: readonly GraphQLData[]
}

/** Analyses an application with the graphql extension given explicitly (plus discovered ones). */
export async function analyzeApp(
  root: string,
  options: ZnightOptions = {},
  extension: CompilerExtension = graphql as unknown as CompilerExtension,
): Promise<GraphQLAnalysis> {
  const project = new Project(
    normalizeOptions({ root, conditions: ['@znight/source'], extensions: [extension], ...options }),
  )
  project.refresh()
  const result = await analyze(project)
  const stored = result.graph.extensions.find(entry => entry.name === 'graphql')?.stored ?? []
  return { ...result, project, root: project.root, stored: stored as GraphQLData[] }
}

/** Creates an application from `files` and analyses it. */
export function analyzeFiles(
  files: Readonly<Record<string, string>>,
  options: ZnightOptions = {},
): Promise<GraphQLAnalysis> {
  return analyzeApp(tempApp(files).root, options)
}

/** `severity code file:line:column message` lines (paths relative to the root), hints and related indented. */
export function render(
  result: { readonly root: string; readonly diagnostics: readonly Diagnostic[] },
  codes: readonly string[] = GRAPHQL_CODES,
): string[] {
  return result.diagnostics
    .filter(diagnostic => codes.includes(diagnostic.code))
    .map(diagnostic => {
      const location = diagnostic.location
      const where = location ? `${path.relative(result.root, location.file)}:${location.line}:${location.column}` : '-'
      return [
        `${diagnostic.severity} ${diagnostic.code} ${where} ${diagnostic.message}`,
        ...(diagnostic.hints ?? []).map(hint => `  = ${hint}`),
        ...(diagnostic.related ?? []).map(
          related =>
            `  - ${related.message} (${path.relative(result.root, related.location.file)}:${related.location.line}:${related.location.column})`,
        ),
      ].join('\n')
    })
}

/** Codes the extension reports or reuses. */
export const GRAPHQL_CODES: readonly string[] = [
  'ZNIGHT001',
  'ZNIGHT003',
  'ZNIGHT005',
  'ZNIGHT010',
  'ZNIGHT019',
  'ZNIGHT023',
  'ZNIGHT060',
  'ZNIGHT061',
  'ZNIGHT062',
  'ZNIGHT063',
  'ZNIGHT064',
  'ZNIGHT065',
]

/** Diagnostics formatted like the CLI prints them (code frames), colours off, paths relative. */
export function formatted(
  result: { readonly root: string; readonly diagnostics: readonly Diagnostic[] },
  codes: readonly string[] = GRAPHQL_CODES,
): string {
  const diagnostics = result.diagnostics.filter(diagnostic => codes.includes(diagnostic.code))
  return formatDiagnostics(diagnostics, { cwd: result.root, color: false, summary: false })
}

/** The source text a diagnostic points at. */
export function pointed(diagnostic: Diagnostic): string {
  const location = diagnostic.location
  if (location === undefined) return ''
  return fs.readFileSync(location.file, 'utf8').slice(location.start, location.end)
}

/** Compiles an application with `compile()` (the extension is discovered through the manifest). */
export function compileApp(
  root: string,
  options: ZnightOptions & { readonly mode?: 'build' | 'serve' | 'test' } = {},
): Promise<CompileResult> {
  return compile({ root, conditions: ['@znight/source'], ...options })
}

/** Creates an application from `files` and compiles it. */
export async function compileFiles(
  files: Readonly<Record<string, string>>,
  options: ZnightOptions & { readonly mode?: 'build' | 'serve' | 'test' } = {},
): Promise<CompileResult & { readonly app: TempApp }> {
  const app = tempApp(files)
  return { ...(await compileApp(app.root, options)), app }
}

/** Result of {@link schemaOf}. */
export interface SchemaResult {
  readonly app: TempApp
  readonly root: string
  /** The SDL artifact (`''` when the compile failed). */
  readonly sdl: string
  readonly code: string
  readonly diagnostics: readonly Diagnostic[]
}

/** Compiles `files` with the extension configured with `{ sdl: 'schema.graphql', ...options }`. */
export async function schemaOf(
  files: Readonly<Record<string, string>>,
  options: GraphQLCompilerOptions = {},
  mode: 'build' | 'serve' = 'build',
): Promise<SchemaResult> {
  const app = tempApp(files)
  const extension = graphql.configure({ sdl: 'schema.graphql', ...options }) as unknown as CompilerExtension
  const result = await compileApp(app.root, { mode, extensions: [extension] })
  const sdl = result.extraFiles.find(file => file.file === app.path('schema.graphql'))?.content ?? ''
  return { app, root: app.root, sdl, code: result.code, diagnostics: result.diagnostics }
}

/** The `graphql` section of a generated module, as printed. */
export function section(code: string): string {
  const start = code.indexOf("    ['graphql']: {")
  if (start === -1) return ''
  const end = code.indexOf('\n    },\n', start)
  return code.slice(start, end + 7)
}

/** Type-checks `files` of an application (plus `src`) under max-strict options; returns the errors. */
export function typecheck(app: TempApp, files: readonly string[]): string[] {
  app.write(
    'tsconfig.check.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        lib: ['ES2024', 'ESNext.Disposable', 'DOM'],
        module: 'preserve',
        moduleResolution: 'bundler',
        customConditions: ['@znight/source'],
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noPropertyAccessFromIndexSignature: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        experimentalDecorators: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
      },
      include: ['src'],
      files, // `include` skips dot directories (src/.znight)
    }),
  )
  const run = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.check.json', '--pretty', 'false'], {
    cwd: app.root,
    encoding: 'utf8',
  })
  if (run.error !== undefined) throw run.error
  // errors of the application (its sources and the generated module), not of the linked packages'
  // sources, which are checked with their own settings
  return `${run.stdout}${run.stderr}`.split('\n').filter(line => line.startsWith('src/') && line.includes('error TS'))
}

/** `tsc` reports errors of the generated module (sanity check of {@link typecheck}). */
export function typecheckSanity(app: TempApp, file: string): string[] {
  const original = app.read(file)
  try {
    app.write(file, `${original}\nconst unused: number = 'not a number'\n`)
    return typecheck(app, [file])
  } finally {
    app.write(file, original)
  }
}
