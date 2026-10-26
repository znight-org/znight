/**
 * Helpers of the compiler extension tests: throw-away applications (with `@znight/core`,
 * `@znight/messaging` and `zod` linked into their `node_modules`), analysis with the extension given
 * explicitly or discovered through the manifest, a generation context, and a small printer turning the
 * generated nodes into a TypeScript module (used until `@znight/compiler` ships its code generator).
 */
import type {
  AnalysisResult,
  ApplicationGraph,
  Diagnostic,
  ExtensionLoadResult,
  GenBuilders,
  GenerateContext,
  GenImport,
  GenNode,
  ImportRoute,
  StaticValue,
  TypeHelpers,
  ZnightOptions,
} from '@znight/compiler'
import type { MessagingData } from '../../src/compiler/index.ts'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyze,
  analyzeProject,
  createGenBuilders,
  isGenNode,
  normalizeOptions,
  Project,
  ValueRef,
} from '@znight/compiler'

import messaging from '../../src/compiler/index.ts'

const real = (url: URL): string => fs.realpathSync.native(fileURLToPath(url))

/** Values accepted by `lit()`. */
type LiteralValue = Parameters<GenBuilders['lit']>[0]

/** A module-level constant declared with `GenerateContext.constant()`. */
interface DeclaredConstant {
  readonly node: GenNode
  readonly name: string
  readonly value: GenNode
  readonly type: GenNode | undefined
}

/** Real path of `packages/messaging`. */
export const MESSAGING_DIR: string = real(new URL('../..', import.meta.url))
/** Real path of `packages/core`. */
export const CORE_DIR: string = real(new URL('../../../core', import.meta.url))
/** Real path of the `zod` package used by the tests. */
export const ZOD_DIR: string = real(new URL('../../node_modules/zod', import.meta.url))

/** A throw-away application. */
export interface TempApp {
  readonly root: string
  /** Writes a file (relative to the root) and returns its absolute path. */
  write(relative: string, content: string): string
  /** `root/relative`. */
  path(relative: string): string
  cleanup(): void
}

const apps: TempApp[] = []

/**
 * Creates an application in a temporary directory: `package.json`, `tsconfig.json` (strict, legacy
 * decorators), `node_modules/@znight/{core,messaging}` and `node_modules/zod` linked, plus `files`.
 */
export function tempApp(files: Readonly<Record<string, string>>): TempApp {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-messaging-'))).replaceAll('\\', '/')
  const app: TempApp = {
    root,
    write(relative, content) {
      const file = `${root}/${relative}`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return file
    },
    path: relative => `${root}/${relative}`,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  app.write(
    'package.json',
    JSON.stringify({
      name: 'messaging-app',
      private: true,
      type: 'module',
      dependencies: { '@znight/core': '*', '@znight/messaging': '*', zod: '*' },
    }),
  )
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
  fs.mkdirSync(`${root}/node_modules/@znight`, { recursive: true })
  fs.symlinkSync(CORE_DIR, `${root}/node_modules/@znight/core`, 'dir')
  fs.symlinkSync(MESSAGING_DIR, `${root}/node_modules/@znight/messaging`, 'dir')
  fs.symlinkSync(ZOD_DIR, `${root}/node_modules/zod`, 'dir')
  for (const [relative, content] of Object.entries(files)) app.write(relative, content)
  apps.push(app)
  return app
}

/** Removes every application created by {@link tempApp} (call it in `afterAll`). */
export function cleanupApps(): void {
  for (const app of apps.splice(0)) app.cleanup()
}

/** Analysis result plus its project. */
export interface AppAnalysis extends AnalysisResult {
  readonly project: Project
  readonly root: string
}

/** A refreshed project on an application, analysed from source (`@znight/source`). */
export function appProject(root: string, options: ZnightOptions = {}): Project {
  const project = new Project(normalizeOptions({ root, conditions: ['@znight/source'], ...options }))
  project.refresh()
  return project
}

/** Analyses an application with the messaging extension given explicitly (no discovery). */
export function analyzeWithExtension(root: string, options: ZnightOptions = {}): AppAnalysis {
  const project = appProject(root, options)
  const extensions: ExtensionLoadResult = {
    extensions: [
      { extension: messaging, origin: 'option', packageName: undefined, specifier: undefined, path: undefined },
    ],
    diagnostics: [],
  }
  return { ...analyzeProject(project, extensions), project, root: project.root }
}

/** Analyses an application, discovering the extension through the `@znight/messaging` manifest. */
export async function analyzeDiscovered(root: string, options: ZnightOptions = {}): Promise<AppAnalysis> {
  const project = appProject(root, options)
  return { ...(await analyze(project)), project, root: project.root }
}

/** Creates an application from `files` and analyses it with the extension. */
export function analyzeFiles(files: Readonly<Record<string, string>>, options: ZnightOptions = {}): AppAnalysis {
  return analyzeWithExtension(tempApp(files).root, options)
}

/** `ZNIGHT011 src/a.ts:12:3` for each diagnostic. */
export function codes(result: AppAnalysis, severity?: Diagnostic['severity']): string[] {
  return result.diagnostics
    .filter(diagnostic => severity === undefined || diagnostic.severity === severity)
    .map(diagnostic => `${diagnostic.code} ${where(result.root, diagnostic)}`)
}

/** `error ZNIGHT011 src/a.ts:12:3: message` (plus hints) for each diagnostic. */
export function render(result: AppAnalysis, code?: string): string[] {
  return result.diagnostics
    .filter(diagnostic => code === undefined || diagnostic.code === code)
    .map(diagnostic =>
      [
        `${diagnostic.severity} ${diagnostic.code} ${where(result.root, diagnostic)}: ${diagnostic.message}`,
        ...(diagnostic.hints ?? []).map(hint => `  = hint: ${hint}`),
        ...(diagnostic.related ?? []).map(
          related =>
            `  - ${related.message} (${path.relative(result.root, related.location.file)}:${related.location.line}:${related.location.column})`,
        ),
      ].join('\n'),
    )
}

/** Messages of the diagnostics with a code. */
export function messages(result: AppAnalysis, code: string): string[] {
  return result.diagnostics.filter(diagnostic => diagnostic.code === code).map(diagnostic => diagnostic.message)
}

function where(root: string, diagnostic: Diagnostic): string {
  const location = diagnostic.location
  return location === undefined ? '-' : `${path.relative(root, location.file)}:${location.line}:${location.column}`
}

/** Data stored by the extension. */
export function stored(result: AppAnalysis): readonly MessagingData[] {
  return (result.graph.extensions.find(data => data.name === 'messaging')?.stored ?? []) as MessagingData[]
}

// ---------------------------------------------------------------------------------------- generation

/** What a generation produced. */
export interface Generation {
  readonly node: GenNode | undefined
  /** Every import requested by the extension, in call order. */
  readonly imports: readonly GenImport[]
  readonly diagnostics: readonly Diagnostic[]
}

const NO_TYPES: TypeHelpers = new Proxy({} as TypeHelpers, {
  get() {
    throw new Error('the messaging extension does not use type helpers during generation')
  },
})

/**
 * A generation context over an analysis (the compiler's own context is built by its code
 * generator): pure builders from `createGenBuilders()`, imports recorded as `gen:import` nodes.
 */
export function generationContext(
  result: AppAnalysis,
  graph: ApplicationGraph = result.graph,
): {
  readonly ctx: GenerateContext<MessagingData>
  readonly imports: GenImport[]
  readonly constants: DeclaredConstant[]
  readonly diagnostics: Diagnostic[]
} {
  const builders = createGenBuilders()
  const imports: GenImport[] = []
  const constants: DeclaredConstant[] = []
  const diagnostics: Diagnostic[] = []
  const record = (target: GenImport['target'], typeOnly: boolean): GenNode => {
    const node: GenImport = Object.freeze({ kind: 'gen:import', target, typeOnly })
    imports.push(node)
    return node
  }
  const targetOf = (target: Parameters<GenerateContext['importValue']>[0]): GenImport['target'] => {
    if (typeof target === 'string') return { kind: 'identity', identity: target }
    if (target instanceof ValueRef) return { kind: 'ref', ref: target }
    if ('ref' in target && target.ref instanceof ValueRef) return { kind: 'ref', ref: target.ref }
    if ('identity' in target && typeof target.identity === 'string')
      return { kind: 'identity', identity: target.identity }
    throw new Error('unsupported import target')
  }
  const ctx: GenerateContext<MessagingData> = {
    ...builders,
    extension: 'messaging',
    options: result.project.options,
    types: NO_TYPES,
    graph,
    stored: (graph.extensions.find(data => data.name === 'messaging')?.stored ?? []) as MessagingData[],
    binding: handle => graph.bindings.get(handle.id),
    provider: token => graph.providers.find(provider => provider.token === token),
    importValue: target => record(targetOf(target), false),
    importType: target => record(targetOf(target), true),
    importFrom: (module, name, options) => record({ kind: 'module', module, name }, options?.type === true),
    tokenOf: target => {
      if (typeof target === 'string') return target
      return 'token' in target ? target.token : target.identity
    },
    constant: (name, value, options) => {
      const existing = constants.find(constant => constant.name === name)
      if (existing !== undefined) return existing.node
      const node = Object.freeze({ kind: 'gen:constant', name, id: constants.length + 1 }) as GenNode
      const printed = isGenNode(value) ? value : builders.lit(value)
      constants.push({ node, name, value: printed, type: options?.type })
      return node
    },
    report: diagnostic => {
      diagnostics.push(diagnostic)
    },
  }
  return { ctx, imports, constants, diagnostics }
}

/** Runs the extension's `generate` on an analysis. */
export function generate(result: AppAnalysis): Generation {
  const { ctx, imports, diagnostics } = generationContext(result)
  const node = messaging.generate?.(ctx)
  return { node, imports, diagnostics }
}

/** Display name of an import (`OrderConsumer`, `validateMessage`). */
export function importName(node: GenImport): string {
  switch (node.target.kind) {
    case 'ref':
      return node.target.ref.name
    case 'identity':
      return node.target.identity.slice(node.target.identity.lastIndexOf('#') + 1)
    case 'module':
      return node.target.name
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * Prints a node as TypeScript. Imports are printed with `name` (default: their display name); object
 * keys are printed bare when they are identifiers.
 */
export function print(node: GenNode, name: (node: GenImport) => string = importName): string {
  const go = (current: GenNode): string => print(current, name)
  switch (node.kind) {
    case 'gen:literal':
      return printLiteral(node.value)
    case 'gen:object':
      return node.entries.length === 0
        ? '{}'
        : `{ ${node.entries.map(([key, value]) => `${printKey(key)}: ${go(value)}`).join(', ')} }`
    case 'gen:array':
      return `[${node.items.map(go).join(', ')}]`
    case 'gen:import':
      return name(node)
    case 'gen:param':
      return node.name
    case 'gen:member':
      return IDENTIFIER.test(node.property)
        ? `${go(node.object)}.${node.property}`
        : `${go(node.object)}[${JSON.stringify(node.property)}]`
    case 'gen:call':
      return `${node.new ? 'new ' : ''}${go(node.callee)}(${node.args.map(go).join(', ')})`
    case 'gen:arrow': {
      const params = node.params
        .map(param => (param.type === undefined ? param.name : `${param.name}: ${go(param.type)}`))
        .join(', ')
      const body = node.body.kind === 'gen:object' ? `(${go(node.body)})` : go(node.body)
      return `${node.async ? 'async ' : ''}(${params}) => ${body}`
    }
    case 'gen:code':
      return node.parts
        .map((part, index) => part + (index < node.values.length ? go(node.values[index] as GenNode) : ''))
        .join('')
    default:
      // gen:constant (declared with `ctx.constant()`)
      return (node as { readonly name: string }).name
  }
}

function printKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key)
}

function printLiteral(value: LiteralValue): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (value === null || typeof value !== 'object') return String(value)
  if (value instanceof ValueRef) return value.text
  if (value instanceof RegExp) return String(value)
  if (value instanceof Date) return `new Date(${value.getTime()})`
  if (Array.isArray(value)) return `[${(value as readonly LiteralValue[]).map(printLiteral).join(', ')}]`
  const entries = Object.entries(value)
  return entries.length === 0
    ? '{}'
    : `{ ${entries.map(([key, item]) => `${printKey(key)}: ${printLiteral(item as LiteralValue)}`).join(', ')} }`
}

// --------------------------------------------------------------------------------- module printing

/**
 * Prints `metadata` (providers, resolution order, externals and the messaging section) as a module
 * importing every value through the import routes of the project, in the shape of §3.3. A stand-in for
 * the compiler's code generator, enough for constructor-injected providers.
 */
export function printMetadataModule(result: AppAnalysis, outFile: string): string {
  const { ctx, imports, constants } = generationContext(result)
  const project = result.project
  const graph = result.graph

  const providerEntries: [string, GenNode][] = graph.providers.map(provider => {
    if (provider.factory.kind !== 'constructor') throw new Error(`unsupported factory kind ${provider.factory.kind}`)
    const cls = ctx.importValue(provider.classIdentity)
    const args = provider.factory.args
    const factory =
      args === 0
        ? ctx.arrow([], () => ctx.construct(cls))
        : ctx.arrow(['d'], d =>
            ctx.construct(
              cls,
              Array.from({ length: args }, (_, index) => ctx.code`${d}[${index}]`),
            ),
          )
    const entries: [string, GenNode][] = [
      ['scope', ctx.lit(provider.scope)],
      ['class', cls],
      ['deps', ctx.lit(provider.deps.map(dep => dep.ref) as unknown as StaticValue)],
      ['factory', factory],
    ]
    return [provider.token, ctx.obj(entries)]
  })
  const externals = graph.externals.map(external =>
    ctx.lit({
      token: external.token,
      ...(external.scope === 'singleton' ? {} : { scope: external.scope }),
      ...(external.providedBy === undefined ? {} : { providedBy: external.providedBy }),
    }),
  )
  const section = messaging.generate?.(ctx)
  const metadata = ctx.obj([
    ['version', ctx.lit(1)],
    ['providers', ctx.obj(providerEntries)],
    ['resolutionOrder', ctx.lit([...graph.resolutionOrder])],
    ['externals', ctx.arr(externals)],
    ['extensions', section === undefined ? ctx.obj([]) : ctx.obj([['messaging', section]])],
  ])

  // import table: one local name per (specifier, export), value imports win over type-only ones
  const routes = new Map<GenImport, ImportRoute & { readonly local: string }>()
  const byKey = new Map<string, { specifier: string; exportName: string; local: string; typeOnly: boolean }>()
  const used = new Set<string>(['metadata', 'ZnightMetadata'])
  for (const node of imports) {
    const route = routeOf(project, node, outFile)
    const key = `${route.specifier}\0${route.exportName}`
    let entry = byKey.get(key)
    if (entry === undefined) {
      let local = route.exportName === 'default' ? 'imported' : route.exportName
      for (let index = 1; used.has(local); index++) local = `${route.exportName}$${index}`
      used.add(local)
      entry = { specifier: route.specifier, exportName: route.exportName, local, typeOnly: true }
      byKey.set(key, entry)
    }
    if (!node.typeOnly && !route.typeOnly) entry.typeOnly = false
    routes.set(node, { ...route, local: entry.local })
  }
  const printImport = (node: GenImport): string => {
    const route = routes.get(node)
    if (route === undefined) throw new Error('unknown import')
    return [route.local, ...route.members].join('.')
  }
  const body = print(metadata, printImport)
  const lines = ["import type { ZnightMetadata } from '@znight/core'"]
  for (const entry of [...byKey.values()].sort((a, b) => (a.specifier + a.local < b.specifier + b.local ? -1 : 1))) {
    const binding = entry.exportName === entry.local ? entry.local : `${entry.exportName} as ${entry.local}`
    lines.push(`import ${entry.typeOnly ? 'type ' : ''}{ ${binding} } from '${entry.specifier}'`)
  }
  lines.push('')
  for (const constant of constants) {
    const type = constant.type === undefined ? '' : `: ${print(constant.type, printImport)}`
    lines.push(`const ${constant.name}${type} = ${print(constant.value, printImport)}`)
  }
  lines.push(`export const metadata: ZnightMetadata = ${body}`, '')
  return lines.join('\n')
}

function routeOf(project: Project, node: GenImport, outFile: string): ImportRoute {
  const target = node.target
  if (target.kind === 'module')
    return { specifier: target.module, exportName: target.name, members: [], typeOnly: node.typeOnly }
  const result = project.importRoute(target.kind === 'ref' ? target.ref.symbol : target.identity, outFile)
  if (!result.ok) throw new Error(`no import route: ${result.error.message}`)
  return result.route
}
