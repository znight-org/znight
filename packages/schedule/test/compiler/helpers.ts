/**
 * Helpers of the compiler extension tests: throw-away applications linked to the workspace packages,
 * analysis with the extension given explicitly, and `compile()` (extension discovered through the
 * manifest) to generate the real module.
 */
import type { AnalysisResult, CompileResult, CompilerExtension, Diagnostic, ZnightOptions } from '@znight/compiler'
import type { ZnightMetadata } from '@znight/core'
import type { JobData } from '../../src/compiler/index.ts'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, compile, normalizeOptions, Project } from '@znight/compiler'

import schedule from '../../src/compiler/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Real path of `packages/schedule`. */
export const SCHEDULE_ROOT: string = fs.realpathSync.native(path.resolve(here, '../..'))
const PACKAGES = path.dirname(SCHEDULE_ROOT)

/** Packages linked into the `node_modules` of temporary applications. */
const LINKS: Readonly<Record<string, string>> = {
  '@znight/core': fs.realpathSync.native(path.join(SCHEDULE_ROOT, 'node_modules/@znight/core')),
  '@znight/schedule': SCHEDULE_ROOT,
  // only read by the analysis (route + job conflicts, request values): never loaded at runtime here
  '@znight/http': fs.realpathSync.native(path.join(PACKAGES, 'http')),
  '@znight/messaging': fs.realpathSync.native(path.join(PACKAGES, 'messaging')),
  '@types/node': fs.realpathSync.native(path.join(PACKAGES, '../node_modules/@types/node')),
}

/** A temporary application. */
export interface TempApp {
  readonly root: string
  write(relative: string, content: string): void
  path(relative: string): string
  cleanup(): void
}

const created: TempApp[] = []

/** Creates an application in a temporary directory (`package.json`, `tsconfig.json`, linked packages). */
export function tempApp(files: Readonly<Record<string, string>> = {}): TempApp {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-schedule-'))).replaceAll('\\', '/')
  const app: TempApp = {
    root,
    write(relative, content) {
      const file = path.join(root, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    },
    path: relative => `${root}/${relative}`,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  app.write('package.json', JSON.stringify({ name: 'schedule-app', private: true, type: 'module' }))
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
export interface ScheduleAnalysis extends AnalysisResult {
  readonly project: Project
  readonly root: string
  readonly jobs: readonly JobData[]
}

/** Analyses an application with the schedule extension given explicitly (plus discovered ones). */
export async function analyzeApp(root: string, options: ZnightOptions = {}): Promise<ScheduleAnalysis> {
  const project = new Project(
    normalizeOptions({
      root,
      conditions: ['@znight/source'],
      extensions: [schedule as unknown as CompilerExtension],
      ...options,
    }),
  )
  project.refresh()
  const result = await analyze(project)
  const stored = result.graph.extensions.find(extension => extension.name === 'schedule')?.stored ?? []
  return { ...result, project, root: project.root, jobs: stored as JobData[] }
}

/** Creates an application from `files` and analyses it. */
export function analyzeFiles(
  files: Readonly<Record<string, string>>,
  options: ZnightOptions = {},
): Promise<ScheduleAnalysis> {
  return analyzeApp(tempApp(files).root, options)
}

/** `severity code file:line:column message` lines (paths relative to the root), hints indented. */
export function render(
  result: { readonly root: string; readonly diagnostics: readonly Diagnostic[] },
  codes: readonly string[] = ['ZNIGHT003', 'ZNIGHT005', 'ZNIGHT019', 'ZNIGHT040', 'ZNIGHT041'],
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

/** The caret span of a diagnostic: the source text it points at. */
export function pointed(result: ScheduleAnalysis, diagnostic: Diagnostic): string {
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

/** Compiles, writes the generated module and imports it. */
export async function compileAndLoad(
  app: TempApp,
): Promise<{ readonly result: CompileResult; readonly metadata: ZnightMetadata }> {
  const result = await compileApp(app.root)
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length > 0) {
    const codes = errors.map(error => error.code)
    throw new Error(`compile failed:\n${render({ root: app.root, diagnostics: errors }, codes).join('\n')}`)
  }
  app.write(path.relative(app.root, result.outFile), result.code)
  const module = (await import(result.outFile)) as { __ZNIGHT_METADATA__: ZnightMetadata }
  return { result, metadata: module.__ZNIGHT_METADATA__ }
}
