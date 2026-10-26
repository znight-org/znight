import type { AnalysisResult } from '../../src/analyze.ts'
import type { ExtensionLoadResult } from '../../src/extensions/loader.ts'
import type { ProviderNode } from '../../src/graph/types.ts'
import type { ZnightOptions } from '../../src/options.ts'
import type { Diagnostic } from '../../src/project/index.ts'
import type { TempDir } from '../project/helpers.ts'

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { analyzeProject } from '../../src/analyze.ts'
import { loadExtensions } from '../../src/extensions/loader.ts'
import { normalizeOptions } from '../../src/options.ts'
import { Project, realPath, relativePath } from '../../src/project/index.ts'
import { FIXTURES, tempDir } from '../project/helpers.ts'

/** Real path of `test/fixtures/analysis`. */
export const ANALYSIS: string = `${FIXTURES}/analysis`

/** Real path of `packages/core` (linked into temporary applications). */
export const CORE: string = realPath(fileURLToPath(new URL('../../../core', import.meta.url))) as string

/** A refreshed project on `test/fixtures/analysis/<name>`. */
export function fixtureProject(name: string, options: ZnightOptions = {}): Project {
  return createProject(`${ANALYSIS}/${name}`, options)
}

/** A refreshed project on `root`, analysed from source (`@znight/source`). */
export function createProject(root: string, options: ZnightOptions = {}): Project {
  const project = new Project(normalizeOptions({ root, conditions: ['@znight/source'], ...options }))
  project.refresh()
  return project
}

/** Analysis result plus the project it was computed on. */
export interface FixtureAnalysis extends AnalysisResult {
  readonly project: Project
  readonly root: string
}

/** Loads the extensions and analyses a project. */
export async function analyzeRoot(
  root: string,
  options: ZnightOptions = {},
  extensions?: ExtensionLoadResult,
): Promise<FixtureAnalysis> {
  const project = createProject(root, options)
  const loaded = extensions ?? (await loadExtensions(project))
  return { ...analyzeProject(project, loaded), project, root: project.root }
}

/** Analyses `test/fixtures/analysis/<name>`. */
export function analyzeFixture(name: string, options: ZnightOptions = {}): Promise<FixtureAnalysis> {
  return analyzeRoot(`${ANALYSIS}/${name}`, options)
}

/** `ZNIGHT001 src/x.ts:12` for each diagnostic (files relative to the root). */
export function codes(result: FixtureAnalysis, severity?: 'error' | 'warning'): string[] {
  return result.diagnostics
    .filter(diagnostic => severity === undefined || diagnostic.severity === severity)
    .map(diagnostic => `${diagnostic.code} ${where(result.root, diagnostic)}`)
}

/** Diagnostics with a given code. */
export function withCode(result: FixtureAnalysis, code: string): Diagnostic[] {
  return result.diagnostics.filter(diagnostic => diagnostic.code === code)
}

/** Plain-text rendering of diagnostics (messages, hints, related locations) for snapshots. */
export function renderDiagnostics(root: string, diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map(diagnostic => {
      const lines = [`${diagnostic.severity} ${diagnostic.code} ${where(root, diagnostic)}: ${diagnostic.message}`]
      for (const hint of diagnostic.hints ?? []) {
        lines.push(`  = hint: ${hint}`)
      }
      for (const related of diagnostic.related ?? []) {
        lines.push(
          `  - ${related.message} (${relativePath(root, related.location.file)}:${related.location.line}:${related.location.column})`,
        )
      }
      return lines.join('\n')
    })
    .join('\n')
}

/** The provider with a token, failing loudly. */
export function provider(result: FixtureAnalysis, token: string): ProviderNode {
  const found = result.graph.providers.find(candidate => candidate.token === token)
  if (!found) {
    throw new Error(`no provider ${token}; providers: ${result.graph.providers.map(p => p.token).join(', ')}`)
  }
  return found
}

/** A temporary application with `@znight/core` linked into its `node_modules`. */
export function tempApp(files: Record<string, string>): TempDir {
  const dir = tempDir({
    'package.json': JSON.stringify({ name: 'temp-app', private: true, type: 'module' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true } }),
    ...files,
  })
  fs.mkdirSync(`${dir.root}/node_modules/@znight`, { recursive: true })
  fs.symlinkSync(CORE, `${dir.root}/node_modules/@znight/core`, 'dir')
  return dir
}

function where(root: string, diagnostic: Diagnostic): string {
  const location = diagnostic.location
  return location ? `${relativePath(root, location.file)}:${location.line}:${location.column}` : '-'
}
