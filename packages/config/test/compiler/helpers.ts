/**
 * Helpers of the compiler extension tests: temporary applications linked to the workspace packages,
 * analysis, diagnostic rendering, a generation context built from the compiler's pure builders and
 * a tiny interpreter of generated nodes (runs generated code without the code generator).
 */
import type {
  AnalysisResult,
  ApplicationGraph,
  ClassInfo,
  ClassRef,
  Diagnostic,
  GenerateContext,
  GenNode,
  ValueRef,
  ZnightOptions,
} from '@znight/compiler'
import type { DependencyRef, ProviderDefinition, ZnightMetadata } from '@znight/core'
import type { StoredConfig, StoredConfigData } from '../../src/compiler/index.ts'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, createGenBuilders, normalizeOptions, Project } from '@znight/compiler'

/** Real path of `packages/`. */
export const PACKAGES: string = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))

/** A temporary application. */
export interface TempApp {
  readonly root: string
  write(file: string, content: string): void
  cleanup(): void
}

/**
 * A temporary application whose `node_modules` links `@znight/core` and `@znight/config` (the
 * workspace packages), with `files` relative to its root.
 */
export function tempApp(files: Record<string, string>): TempApp {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-config-compiler-')))
  const write = (file: string, content: string): void => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  write(
    'package.json',
    JSON.stringify({
      name: 'config-app',
      private: true,
      type: 'module',
      dependencies: { '@znight/config': '*', '@znight/core': '*' },
    }),
  )
  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true, module: 'preserve' } }),
  )
  fs.mkdirSync(path.join(root, 'node_modules/@znight'), { recursive: true })
  for (const name of ['core', 'config']) {
    fs.symlinkSync(path.join(PACKAGES, name), path.join(root, 'node_modules/@znight', name), 'dir')
  }
  for (const [file, content] of Object.entries(files)) {
    write(file, content)
  }
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** Analysis of an application from source (`@znight/source`), extensions auto-discovered unless given. */
export function analyzeApp(root: string, options: ZnightOptions = {}): Promise<AnalysisResult> {
  const project = new Project(normalizeOptions({ root, conditions: ['@znight/source'], ...options }))
  project.refresh()
  return analyze(project)
}

/** `severity code file:line:column message` (+ hints and related locations) for each diagnostic. */
export function render(root: string, diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(diagnostic => {
    const lines = [
      `${diagnostic.severity} ${diagnostic.code} ${where(root, diagnostic.location)}: ${diagnostic.message}`,
    ]
    for (const hint of diagnostic.hints ?? []) lines.push(`  = hint: ${hint}`)
    for (const related of diagnostic.related ?? [])
      lines.push(`  - ${related.message} (${where(root, related.location)})`)
    return lines.join('\n')
  })
}

/** Only the first line (`severity code file:line:column message`) of each diagnostic. */
export function summary(root: string, diagnostics: readonly Diagnostic[]): string[] {
  return render(root, diagnostics).map(text => text.split('\n')[0] as string)
}

function where(root: string, location: Diagnostic['location']): string {
  if (location === undefined) return '-'
  return `${path.relative(root, location.file)}:${location.line}:${location.column}`
}

/** Data stored by the config extension. */
export function storedData(result: AnalysisResult): readonly StoredConfigData[] {
  return (result.graph.extensions.find(data => data.name === 'config')?.stored ?? []) as StoredConfigData[]
}

/** Config classes stored by the config extension, by display name. */
export function storedConfigs(result: AnalysisResult): Record<string, StoredConfig> {
  return Object.fromEntries(
    storedData(result)
      .filter((data): data is StoredConfig => data.kind === 'config')
      .map(data => [data.displayName, data]),
  )
}

// ------------------------------------------------------------------------------- generation

/** A module-level constant declared through `constant()`. */
export interface DeclaredConstant {
  readonly name: string
  readonly value: GenNode
  readonly type: GenNode | undefined
  readonly node: GenNode
}

/** A recording {@link GenerateContext}: the compiler's pure builders plus stub imports and constants. */
export interface TestGenerateContext extends GenerateContext<StoredConfigData> {
  readonly reports: Diagnostic[]
  readonly constants: Map<string, DeclaredConstant>
}

/**
 * A {@link GenerateContext} made of the compiler's pure builders and recording stubs. With
 * `constants: false`, it has no `constant()` method (older code generators).
 */
export function generateContext(
  graph: ApplicationGraph,
  stored: readonly StoredConfigData[],
  options: { readonly constants?: boolean } = {},
): TestGenerateContext {
  const builders = createGenBuilders()
  const reports: Diagnostic[] = []
  const constants = new Map<string, DeclaredConstant>()
  const importNode = (target: ImportTarget['target'], typeOnly: boolean): GenNode =>
    Object.freeze({ kind: 'gen:import', target, typeOnly }) as GenNode
  const context: TestGenerateContext = {
    ...builders,
    extension: 'config',
    options: undefined as never,
    types: undefined as never,
    graph,
    stored,
    reports,
    constants,
    binding: handle => graph.bindings.get(handle.id),
    provider: token => graph.providers.find(provider => provider.token === token),
    importValue: target => importNode(importTarget(target), false),
    importType: target => importNode(importTarget(target), true),
    importFrom: (module, name, importOptions) =>
      importNode({ kind: 'module', module, name }, importOptions?.type === true),
    tokenOf: target => {
      if (typeof target === 'string') return target
      return 'token' in target ? target.token : target.identity
    },
    constant: (name, value, constantOptions) => {
      let declared = constants.get(name)
      if (declared === undefined) {
        const node = Object.freeze({ kind: 'gen:constant', name, id: constants.size + 1 }) as GenNode
        const valueNode = typeof value === 'object' && value !== null ? value : builders.lit(value)
        declared = { name, value: valueNode, type: constantOptions?.type, node }
        constants.set(name, declared)
      }
      return declared.node
    },
    report: diagnostic => {
      reports.push(diagnostic)
    },
  }
  if (options.constants === false) {
    Reflect.deleteProperty(context, 'constant')
  }
  return context
}

type ImportTarget = Extract<GenNode, { kind: 'gen:import' }>

function importTarget(target: Parameters<GenerateContext['importValue']>[0]): ImportTarget['target'] {
  if (typeof target === 'string') return { kind: 'identity', identity: target }
  if ('declaration' in target) return { kind: 'identity', identity: (target as ClassInfo).identity }
  if ('token' in target) return { kind: 'identity', identity: (target as ClassRef).identity }
  return { kind: 'ref', ref: ('ref' in target ? target.ref : target) as ValueRef }
}

/** Runtime values of the imports of generated code: modules by specifier, classes by identity. */
export interface Imports {
  readonly modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly identities: Readonly<Record<string, unknown>>
  /** Constants declared with `constant()`, by name. */
  readonly constants?: ReadonlyMap<string, DeclaredConstant>
}

/** Evaluates a generated node (a small interpreter of the `GenNode` tree). */
export function interpret(node: GenNode, imports: Imports, scope: ReadonlyMap<string, unknown> = new Map()): unknown {
  switch (node.kind) {
    case 'gen:literal':
      return node.value
    case 'gen:object':
      return Object.fromEntries(node.entries.map(([key, value]) => [key, interpret(value, imports, scope)]))
    case 'gen:array':
      return node.items.map(item => interpret(item, imports, scope))
    case 'gen:import': {
      const target = node.target
      if (target.kind === 'module') return imports.modules[target.module]?.[target.name]
      const identity = target.kind === 'identity' ? target.identity : target.ref.identity
      return identity === undefined ? undefined : imports.identities[identity]
    }
    case 'gen:constant': {
      const declared = imports.constants?.get(node.name)
      if (declared === undefined) throw new Error(`unknown constant ${node.name}`)
      return interpret(declared.value, imports)
    }
    case 'gen:param':
      return scope.get(node.name)
    case 'gen:member':
      return (interpret(node.object, imports, scope) as Record<string, unknown>)[node.property]
    case 'gen:call': {
      const callee = interpret(node.callee, imports, scope) as (...args: unknown[]) => unknown
      const args = node.args.map(arg => interpret(arg, imports, scope))
      return node.new ? Reflect.construct(callee, args) : callee(...args)
    }
    case 'gen:arrow':
      return (...args: unknown[]) =>
        interpret(
          node.body,
          imports,
          new Map([...scope, ...node.params.map((param, index) => [param.name, args[index]] as const)]),
        )
    case 'gen:code':
      throw new Error('code templates are not interpreted')
  }
}

/**
 * The metadata the code generator would emit for an application made of config classes only
 * (providers with custom factories, externals, `extensions.config`), built by interpreting the
 * nodes produced by the extension.
 */
export function interpretedMetadata(
  graph: ApplicationGraph,
  stored: readonly StoredConfigData[],
  generateSection: (ctx: GenerateContext<StoredConfigData>) => GenNode | undefined,
  imports: Imports,
): ZnightMetadata {
  const ctx = generateContext(graph, stored)
  const runtime: Imports = { ...imports, constants: ctx.constants }
  const providers: Record<string, ProviderDefinition> = {}
  for (const provider of graph.providers) {
    const factory = provider.factory
    if (factory.kind !== 'custom') throw new Error(`unexpected ${factory.kind} provider ${provider.token}`)
    const node = ctx.arrow(['d'], d =>
      factory.generate(ctx, {
        cls: ctx.importValue(provider.classIdentity),
        deps: Array.from({ length: factory.args }, (_, index) => ctx.member(d, String(index))),
      }),
    )
    providers[provider.token] = {
      scope: provider.scope,
      class: imports.identities[provider.classIdentity] as NonNullable<ProviderDefinition['class']>,
      deps: provider.deps.map(dep => dep.ref as DependencyRef),
      factory: interpret(node, runtime) as ProviderDefinition['factory'],
    }
  }
  const section = generateSection(ctx)
  return {
    version: 1,
    providers,
    resolutionOrder: graph.resolutionOrder,
    externals: graph.externals.map(external => ({
      token: external.token,
      ...(external.providedBy === undefined ? {} : { providedBy: external.providedBy }),
    })),
    ...(section === undefined ? {} : { extensions: { config: interpret(section, runtime) as never } }),
  }
}
