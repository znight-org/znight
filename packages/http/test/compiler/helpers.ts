/**
 * Helpers of the compiler extension tests: throw-away applications linked to the workspace
 * packages, analysis with `@znight/compiler`, a fake `GenerateContext` and a small printer for the
 * generated nodes (the real code generator lives in `@znight/compiler`).
 */
import type {
  AnalysisResult,
  ClassRef,
  CompilerExtension,
  Diagnostic,
  GenerateContext,
  GenImport,
  GenNode,
  ZnightOptions,
} from '@znight/compiler'
import type { HttpControllerData } from '../../src/compiler/index.ts'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, createGenBuilders, normalizeOptions, Project } from '@znight/compiler'

import http from '../../src/compiler/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Real path of `packages/http`. */
export const HTTP_ROOT: string = fs.realpathSync.native(path.resolve(here, '../..'))
/** Fixtures of the compiler tests. */
export const FIXTURES: string = path.join(here, 'fixtures')

/** Packages linked into the `node_modules` of temporary applications. */
const LINKS: Record<string, string> = {
  '@znight/core': fs.realpathSync.native(path.join(HTTP_ROOT, 'node_modules/@znight/core')),
  '@znight/http': HTTP_ROOT,
  zod: fs.realpathSync.native(path.join(HTTP_ROOT, 'node_modules/zod')),
  valibot: fs.realpathSync.native(path.join(HTTP_ROOT, 'node_modules/valibot')),
  '@types/node': fs.realpathSync.native(path.join(HTTP_ROOT, '../../node_modules/@types/node')),
}

/** The TypeScript compiler of the repository (`tsc` script). */
export const TSC: string = fs.realpathSync.native(path.join(HTTP_ROOT, '../../node_modules/typescript/bin/tsc'))

/** A temporary application. */
export interface TempApp {
  readonly root: string
  write(relative: string, content: string): void
  cleanup(): void
}

const created: TempApp[] = []

/** Creates an application in a temporary directory (`package.json`, `tsconfig.json`, linked packages). */
export function tempApp(files: Record<string, string> = {}): TempApp {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-http-')))
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
  app.write('package.json', JSON.stringify({ name: 'temp-app', private: true, type: 'module' }))
  app.write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true, module: 'preserve' } }),
  )
  for (const [name, target] of Object.entries(LINKS)) {
    const link = path.join(root, 'node_modules', name)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(target, link, 'dir')
  }
  for (const [relative, content] of Object.entries(files)) {
    app.write(relative, content)
  }
  created.push(app)
  return app
}

/** Copies `fixtures/<name>` into a temporary application. */
export function fixtureApp(name: string): TempApp {
  const app = tempApp()
  fs.cpSync(path.join(FIXTURES, name), app.root, { recursive: true })
  return app
}

/** Removes every temporary application created so far. */
export function cleanupApps(): void {
  for (const app of created.splice(0)) {
    app.cleanup()
  }
}

/** Analysis result plus its project. */
export interface HttpAnalysis extends AnalysisResult {
  readonly project: Project
  readonly root: string
  /** Data stored by the http extension. */
  readonly controllers: readonly HttpControllerData[]
}

/**
 * Analyses an application. By default the extension is passed explicitly; with
 * `discover: true` it is loaded through the manifest of `@znight/http` (auto-discovery).
 */
export async function analyzeApp(
  root: string,
  options: ZnightOptions & { readonly discover?: boolean } = {},
): Promise<HttpAnalysis> {
  const { discover, ...rest } = options
  const project = new Project(
    normalizeOptions({
      root,
      conditions: ['@znight/source'],
      ...(discover ? {} : { extensions: [http as unknown as CompilerExtension] }),
      ...rest,
    }),
  )
  project.refresh()
  const result = await analyze(project)
  const stored = result.graph.extensions.find(extension => extension.name === 'http')?.stored ?? []
  return { ...result, project, root: project.root, controllers: stored as HttpControllerData[] }
}

/** `severity code file:line:column message` lines (paths relative to the root). */
export function render(result: { readonly root: string; readonly diagnostics: readonly Diagnostic[] }): string[] {
  return result.diagnostics.map(diagnostic => {
    const location = diagnostic.location
    const where = location ? `${path.relative(result.root, location.file)}:${location.line}:${location.column}` : '-'
    return `${diagnostic.severity} ${diagnostic.code} ${where} ${diagnostic.message}`
  })
}

/** Diagnostics of the http extension's codes only (ZNIGHT003/005/007/017/023), rendered. */
export function httpDiagnostics(result: HttpAnalysis): string[] {
  return render({
    root: result.root,
    diagnostics: result.diagnostics.filter(diagnostic =>
      ['ZNIGHT005', 'ZNIGHT007', 'ZNIGHT017', 'ZNIGHT003', 'ZNIGHT023'].includes(diagnostic.code),
    ),
  })
}

// -------------------------------------------------------------------------------------------------
// Generation
// -------------------------------------------------------------------------------------------------

/** Result of {@link generateSection}. */
export interface GeneratedSection {
  readonly node: GenNode | undefined
  /** Printed TypeScript expression (test printer). */
  readonly code: string
  /** Imports requested by the extension: `type HttpContext from @znight/http`, `UserController (identity)`... */
  readonly imports: string[]
  readonly diagnostics: Diagnostic[]
}

/** Runs `generate()` of the extension with a fake `GenerateContext` over an analysis. */
export function generateSection(result: HttpAnalysis): GeneratedSection {
  const imports = new Set<string>()
  const diagnostics: Diagnostic[] = []
  const track = (node: GenImport): GenImport => {
    imports.add(describeImport(node))
    return node
  }
  const target = (value: unknown): GenImport['target'] => {
    if (typeof value === 'string') {
      return { kind: 'identity', identity: value }
    }
    const record = value as { readonly identity?: string; readonly ref?: unknown }
    if (typeof record.identity === 'string') {
      return { kind: 'identity', identity: record.identity }
    }
    throw new TypeError('unsupported import target in tests')
  }
  const context: GenerateContext<HttpControllerData> = {
    ...createGenBuilders(),
    extension: 'http',
    options: result.project.options,
    types: undefined as never,
    graph: result.graph,
    stored: result.controllers,
    binding: () => undefined,
    provider: token => result.graph.providers.find(provider => provider.token === token),
    constant: () => {
      throw new Error('constant() is not used by the http extension')
    },
    importValue: value => track({ kind: 'gen:import', target: target(value), typeOnly: false }),
    importType: value => track({ kind: 'gen:import', target: target(value), typeOnly: true }),
    importFrom: (module, name, options) =>
      track({ kind: 'gen:import', target: { kind: 'module', module, name }, typeOnly: options?.type === true }),
    tokenOf: value => {
      if (typeof value === 'string') {
        return value
      }
      return 'token' in value ? (value as ClassRef).token : value.identity
    },
    report: diagnostic => {
      diagnostics.push(diagnostic)
    },
  }
  const node = http.generate?.(context)
  return { node, code: node === undefined ? '' : print(node), imports: [...imports].sort(), diagnostics }
}

function describeImport(node: GenImport): string {
  const prefix = node.typeOnly ? 'type ' : ''
  switch (node.target.kind) {
    case 'module':
      return `${prefix}${node.target.name} from ${node.target.module}`
    case 'identity':
      return `${prefix}${node.target.identity}`
    case 'ref':
      return `${prefix}${node.target.ref.identity ?? node.target.ref.text}`
  }
}

/** Prints a node as TypeScript (single quotes, 2-space indentation; for assertions only). */
export function print(node: GenNode, indent = ''): string {
  const inner = `${indent}  `
  switch (node.kind) {
    case 'gen:literal':
      return literal(node.value, indent)
    case 'gen:object':
      if (node.entries.length === 0) {
        return '{}'
      }
      return `{\n${node.entries.map(([key, value]) => `${inner}${propertyKey(key)}: ${print(value, inner)},`).join('\n')}\n${indent}}`
    case 'gen:array':
      if (node.items.length === 0) {
        return '[]'
      }
      return `[\n${node.items.map(item => `${inner}${print(item, inner)},`).join('\n')}\n${indent}]`
    case 'gen:import':
      switch (node.target.kind) {
        case 'module':
          return node.target.name
        case 'identity':
          return node.target.identity.slice(node.target.identity.lastIndexOf('#') + 1)
        case 'ref':
          return node.target.ref.name
      }
      return ''
    case 'gen:param':
      return node.name
    case 'gen:member':
      return /^[A-Za-z_$][\w$]*$/.test(node.property)
        ? `${print(node.object, indent)}.${node.property}`
        : `${print(node.object, indent)}[${quote(node.property)}]`
    case 'gen:call':
      return `${node.new ? 'new ' : ''}${print(node.callee, indent)}(${node.args.map(arg => print(arg, indent)).join(', ')})`
    case 'gen:arrow': {
      const params = node.params
        .map(param => (param.type === undefined ? param.name : `${param.name}: ${print(param.type, indent)}`))
        .join(', ')
      return `${node.async ? 'async ' : ''}(${params}) => ${print(node.body, indent)}`
    }
    case 'gen:code': {
      let text = node.parts[0] ?? ''
      node.values.forEach((value, index) => {
        text += print(value, indent) + (node.parts[index + 1] ?? '')
      })
      return text
    }
  }
  throw new TypeError(`unknown node ${(node as { kind: string }).kind}`)
}

function literal(value: unknown, indent: string): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (typeof value === 'string') {
    return quote(value)
  }
  if (typeof value === 'bigint') {
    return `${value}n`
  }
  if (value === null || typeof value !== 'object') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => literal(item, indent)).join(', ')}]`
  }
  if (value instanceof Date || value instanceof RegExp) {
    return value instanceof Date ? `new Date(${value.getTime()})` : String(value)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return (value as { readonly name: string }).name // ValueRef
  }
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length === 0
    ? '{}'
    : `{ ${entries.map(([key, item]) => `${propertyKey(key)}: ${literal(item, indent)}`).join(', ')} }`
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key)
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
