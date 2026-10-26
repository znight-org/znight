/**
 * Compiler extension loading (§6.5).
 *
 * - **Explicit** extensions come from `options.extensions` (they win over discovered ones with the
 *   same name).
 * - **Auto-discovery**: every package whose manifest declares `"compiler"` modules and that is
 *   imported by the scanned code (bare specifiers) or declares a decorator applied in it — decorators
 *   are resolved to their declaration, so a preset re-exporting `Controller` from `@znight/http`
 *   (`import { Controller } from '@acme/web'`) loads the `@znight/http` extension. `@znight/*`
 *   packages are trusted; other packages must be listed in `trustedExtensions` (otherwise a ZNIGHT018
 *   warning and the extension is not loaded).
 * - Modules are resolved from the package directory with the **runtime** conditions — plus the
 *   `@znight/source` condition when running under Bun, which imports TypeScript sources — and
 *   imported; the default export is a `CompilerExtension` or an array of them.
 * - Problems are ZNIGHT018: unsupported `apiVersion`, malformed extension, module that cannot be
 *   resolved or imported, two different extensions with the same name.
 */

import type { Node } from 'oxc-parser'
import type { Diagnostic, Location, PackageInfo, Project, ScopeRef } from '../project/index.ts'
import type { CompilerExtension, DecoratorSpec } from './api.ts'

import { pathToFileURL } from 'node:url'
import { ErrorCode } from '@znight/core'

import { walk } from '../analysis/ast.ts'
import { isEntityName } from '../analysis/decorators.ts'
import { SOURCE_CONDITION } from '../options.ts'
import { compareStrings } from '../project/compare.ts'
import { isBareSpecifier, LineIndex, ModuleResolver, packageNameOf, relativePath } from '../project/index.ts'
import { EXTENSION_API_VERSION } from './api.ts'

/** A loaded extension and where it comes from. */
export interface LoadedExtension {
  readonly extension: CompilerExtension
  readonly origin: 'option' | 'package'
  /** Package declaring it in its manifest (`origin: 'package'`). */
  readonly packageName: string | undefined
  /** Module specifier from the manifest (`@znight/http/compiler`). */
  readonly specifier: string | undefined
  /** Resolved module path. */
  readonly path: string | undefined
}

/** Result of {@link loadExtensions}. */
export interface ExtensionLoadResult {
  /** Explicit extensions first (in option order), then discovered ones (by package name). */
  readonly extensions: readonly LoadedExtension[]
  readonly diagnostics: readonly Diagnostic[]
}

/** A compiler module declared by a package manifest. */
export interface DiscoveredExtensionModule {
  readonly packageName: string
  readonly package: PackageInfo
  readonly specifier: string
  readonly trusted: boolean
}

/** Options of {@link loadExtensions}. */
export interface LoadExtensionsOptions {
  /** Module importer (tests). Default: dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>
  /** Add the `@znight/source` condition when resolving extension modules. Default: running under Bun. */
  readonly sourceCondition?: boolean
}

const TARGETS: readonly string[] = ['class', 'method', 'property', 'parameter', 'constructorParameter']
const KINDS: readonly string[] = ['static', 'value']

/**
 * Compiler modules declared by the manifests of the packages imported by the scanned code or
 * declaring a decorator applied in it, sorted by package name then declaration order.
 */
export function discoverExtensionModules(project: Project): DiscoveredExtensionModule[] {
  const rootDir = project.rootPackage?.dir
  const packages = new Map<string, PackageInfo>()
  const add = (name: string, info: PackageInfo | undefined): void => {
    if (info && info.dir !== rootDir && !packages.has(name)) {
      packages.set(name, info)
    }
  }
  const importers = new Map<string, string>()
  for (const file of project.files()) {
    for (const request of file.facts.moduleRequests) {
      if (!isBareSpecifier(request.specifier) || request.specifier.startsWith('node:')) {
        continue
      }
      const name = packageNameOf(request.specifier)
      if (!importers.has(name)) {
        importers.set(name, file.path)
      }
    }
  }
  for (const [name, importer] of importers) {
    add(name, project.packages.findInstalled(name, importer.slice(0, importer.lastIndexOf('/'))))
  }
  for (const [name, info] of decoratorOwners(project)) {
    add(name, info)
  }
  const trusted = new Set(project.options.trustedExtensions)
  const modules: DiscoveredExtensionModule[] = []
  for (const name of [...packages.keys()].sort(compareStrings)) {
    const info = packages.get(name) as PackageInfo
    const manifest = project.manifestOf(info)
    for (const specifier of manifest?.compiler ?? []) {
      modules.push({
        packageName: name,
        package: info,
        specifier,
        trusted: name.startsWith('@znight/') || trusted.has(name),
      })
    }
  }
  return modules
}

/**
 * Packages declaring the decorators applied to the classes of the scanned files (by package name).
 * Decorators are resolved like the analysis does (renamed imports, barrels, `export *`, packages
 * re-exporting another package's decorators).
 */
function decoratorOwners(project: Project): Map<string, PackageInfo> {
  const owners = new Map<string, PackageInfo>()
  const seen = new Set<string>()
  for (const file of project.files()) {
    for (const declarations of file.facts.declarations.values()) {
      for (const declaration of declarations) {
        if (declaration.kind !== 'class' || declaration.ambient) {
          continue
        }
        const scope: ScopeRef = { file, namespace: declaration.namespace }
        walk(declaration.node as Node, node => {
          if (node.type === 'BlockStatement' || node.type === 'StaticBlock') {
            return false // method bodies: no decorator of this class
          }
          if (node.type !== 'Decorator') {
            return true
          }
          const expression = node.expression
          const callee = expression.type === 'CallExpression' ? expression.callee : expression
          const key = `${file.path}\0${declaration.namespace?.name ?? ''}\0${file.textOf(callee)}`
          if (isEntityName(callee) && !seen.has(key)) {
            seen.add(key)
            const symbol = project.resolveIdentifier(scope, callee, 'value').symbol
            const owner = symbol.kind === 'declaration' ? project.ownerOf(symbol.declaration.file) : undefined
            if (owner?.kind === 'package' && owner.package.name !== undefined && !owners.has(owner.package.name)) {
              owners.set(owner.package.name, owner.package)
            }
          }
          return false
        })
      }
    }
  }
  return owners
}

/** Loads explicit and discovered compiler extensions. */
export async function loadExtensions(
  project: Project,
  options: LoadExtensionsOptions = {},
): Promise<ExtensionLoadResult> {
  const diagnostics: Diagnostic[] = []
  const importModule = options.importModule ?? ((url: string) => import(url))
  const loaded: LoadedExtension[] = []
  const names = new Map<string, LoadedExtension>()

  for (const candidate of project.options.extensions) {
    const problem = validateExtension(candidate)
    if (problem) {
      diagnostics.push(error(`Invalid compiler extension${nameOf(candidate)} in the "extensions" option: ${problem}`))
      continue
    }
    const extension = candidate as unknown as CompilerExtension
    const entry: LoadedExtension = {
      extension,
      origin: 'option',
      packageName: undefined,
      specifier: undefined,
      path: undefined,
    }
    loaded.push(entry)
    names.set(extension.name, entry)
  }

  const useSource = options.sourceCondition ?? typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  const resolver = new ModuleResolver({
    tsconfig: false,
    scanConditions: project.options.scanConditions,
    runtimeConditions: useSource
      ? [SOURCE_CONDITION, ...project.options.runtimeConditions]
      : project.options.runtimeConditions,
    aliases: [],
  })

  for (const module of discoverExtensionModules(project)) {
    const location = manifestFieldLocation(module.package)
    const at = (diagnostic: Diagnostic): Diagnostic => ({ ...diagnostic, location })
    if (!module.trusted) {
      diagnostics.push(
        at({
          code: ErrorCode.VersionMismatch,
          severity: 'warning',
          message: `${module.packageName} declares a compiler extension (${module.specifier}) but is not trusted: it is not loaded and its decorators are not analysed`,
          hints: [`Add '${module.packageName}' to the "trustedExtensions" option to load it`],
        }),
      )
      continue
    }
    const resolution = resolver.resolveFromDirectory(module.package.dir, module.specifier, 'runtime')
    if (resolution.kind !== 'file') {
      diagnostics.push(
        at(
          error(`Cannot resolve the compiler extension '${module.specifier}' of ${module.packageName}`, [
            `Check the "znight.compiler" field and the "exports" of ${module.packageName}`,
            ...(resolution.kind === 'not-found'
              ? [resolution.message.replaceAll(module.package.dir, module.packageName)]
              : []),
          ]),
        ),
      )
      continue
    }
    const display = relativePath(project.root, resolution.path)
    let exported: unknown
    try {
      const namespace = (await importModule(pathToFileURL(resolution.path).href)) as { default?: unknown }
      exported = namespace.default
    } catch (cause) {
      diagnostics.push(
        at(
          error(
            `Cannot load the compiler extension '${module.specifier}' of ${module.packageName}: ${messageOf(cause)}`,
          ),
        ),
      )
      continue
    }
    const candidates = Array.isArray(exported) ? exported : [exported]
    for (const candidate of candidates) {
      const problem = validateExtension(candidate)
      if (problem) {
        const versionProblem = problem.startsWith('apiVersion')
        diagnostics.push(
          at(
            error(
              `Invalid compiler extension${nameOf(candidate)} exported by '${module.specifier}' (${module.packageName}): ${problem}`,
              versionProblem
                ? [`Use versions of ${module.packageName} and @znight/compiler built for the same extension API`]
                : ['The module must default-export a CompilerExtension or an array of them'],
            ),
          ),
        )
        continue
      }
      const extension = candidate as CompilerExtension
      const existing = names.get(extension.name)
      if (existing) {
        if (existing.origin === 'option' || existing.extension === extension) {
          continue
        }
        diagnostics.push(
          at(
            error(
              `Two compiler extensions are named '${extension.name}': ${describe(existing, project)} and ${module.specifier} (${display}); the second one is ignored`,
              [
                'Several versions or copies of the same package are installed: deduplicate them (a single version of each @znight/* package)',
              ],
            ),
          ),
        )
        continue
      }
      const entry: LoadedExtension = {
        extension,
        origin: 'package',
        packageName: module.packageName,
        specifier: module.specifier,
        path: resolution.path,
      }
      loaded.push(entry)
      names.set(extension.name, entry)
    }
  }
  return { extensions: loaded, diagnostics }
}

/** Why a value is not a usable compiler extension (`undefined` when it is). */
export function validateExtension(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return 'not an object'
  }
  const extension = value as Partial<Record<keyof CompilerExtension, unknown>>
  if (typeof extension.name !== 'string' || extension.name === '') {
    return 'missing "name"'
  }
  if (extension.apiVersion !== EXTENSION_API_VERSION) {
    return `apiVersion ${JSON.stringify(extension.apiVersion)} is not supported by this compiler (supported: ${EXTENSION_API_VERSION})`
  }
  const decorators = extension.decorators
  if (typeof decorators !== 'object' || decorators === null || Array.isArray(decorators)) {
    return '"decorators" must be an object keyed by canonical identities'
  }
  for (const [identity, spec] of Object.entries(decorators as Record<string, unknown>)) {
    const separator = identity.lastIndexOf('#')
    if (separator <= 0 || separator === identity.length - 1) {
      return `decorator key ${JSON.stringify(identity)} is not a canonical identity ('<package>#<Export>')`
    }
    const problem = validateSpec(spec)
    if (problem) {
      return `decorator ${identity}: ${problem}`
    }
  }
  for (const hook of ['analyzeClass', 'validate', 'generate'] as const) {
    if (extension[hook] !== undefined && typeof extension[hook] !== 'function') {
      return `"${hook}" must be a function`
    }
  }
  return undefined
}

function validateSpec(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return 'the specification must be an object { targets, params }'
  }
  const spec = value as Partial<Record<keyof DecoratorSpec, unknown>>
  if (
    !Array.isArray(spec.targets) ||
    spec.targets.length === 0 ||
    spec.targets.some(target => !TARGETS.includes(target as string))
  ) {
    return `"targets" must be a non-empty array of ${TARGETS.join(', ')}`
  }
  if (!Array.isArray(spec.params) || spec.params.some(kind => !KINDS.includes(kind as string))) {
    return `"params" must be an array of 'static' | 'value'`
  }
  if (spec.rest !== undefined && !KINDS.includes(spec.rest as string)) {
    return `"rest" must be 'static' or 'value'`
  }
  return undefined
}

function describe(entry: LoadedExtension, project: Project): string {
  return entry.specifier && entry.path
    ? `${entry.specifier} (${relativePath(project.root, entry.path)})`
    : 'the "extensions" option'
}

/** Location of the `"compiler"` field of a package.json (start of the file when not found). */
function manifestFieldLocation(info: PackageInfo): Location {
  const found = info.text.search(/"compiler"\s*:/)
  const start = Math.max(found, 0)
  const end = found === -1 ? 0 : found + '"compiler"'.length
  const lines = new LineIndex(info.text)
  const from = lines.positionAt(start)
  const to = lines.positionAt(end)
  return {
    file: info.packageJsonPath,
    line: from.line,
    column: from.column,
    endLine: to.line,
    endColumn: to.column,
    start,
    end,
  }
}

function nameOf(value: unknown): string {
  const name = typeof value === 'object' && value !== null ? (value as { name?: unknown }).name : undefined
  return typeof name === 'string' && name !== '' ? ` '${name}'` : ''
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function error(message: string, hints?: readonly string[]): Diagnostic {
  return { code: ErrorCode.VersionMismatch, severity: 'error', message, ...(hints ? { hints } : {}) }
}
