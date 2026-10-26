/**
 * Import routes (§4.2): how the generated module imports a value or a type.
 *
 * - application declaration: relative specifier from the importing file (normally `outFile`) to the
 *   **declaring** module, with the extension mapped by `importExtension`, and the name that module
 *   exports it under (alias-aware: `export { Internal as Public }` → `Public`; `export = Foo` →
 *   `default`). A barrel can only re-export a binding its declaring module exports, so the
 *   declaring module is always usable; importing it directly (never through barrels) also
 *   minimizes import cycles with the generated module (ZNIGHT020);
 * - package declaration: the bare specifier of the public entry and the public export name —
 *   never a path into another package. The specifier must resolve with the runtime conditions;
 * - members of exported namespaces are reached through `members` (`tokens.TokenHolder`);
 * - CommonJS modules (`export =` declarations, untyped packages) are imported through their default
 *   export, with the export path as `members` (`import legacy from 'legacy-ns'` → `legacy.Client`).
 */

import type { ImportExtension } from '../options.ts'
import type { Declaration } from './facts.ts'
import type { ProjectHost } from './host.ts'
import type { IdentityResolver } from './identity.ts'
import type { SymbolResolution, SymbolResolver } from './symbols.ts'

import path from 'node:path'

import { compareStrings } from './compare.ts'
import { namespaceFacts } from './facts.ts'
import { dirName, packageNameOf, relativePath } from './paths.ts'
import { declarationKey } from './symbols.ts'

/** How to import an entity: `import { exportName } from 'specifier'`, then access `members`. */
export interface ImportRoute {
  readonly specifier: string
  /** Export name, or `'default'`. */
  readonly exportName: string
  /** Property path after the import (namespace members), usually empty. */
  readonly members: readonly string[]
  /** The entity only exists as a type (interface, type alias, declaration file): use `import type`. */
  readonly typeOnly: boolean
}

/** Why no import route exists. */
export type ImportRouteFailureReason =
  | 'not-exported'
  | 'anonymous-default'
  | 'internal'
  | 'global'
  | 'unresolved'
  | 'runtime-unresolvable'

/** A failed import route computation (reported as ZNIGHT005 by the caller). */
export interface ImportRouteFailure {
  readonly reason: ImportRouteFailureReason
  readonly message: string
  readonly hints: readonly string[]
}

/** Result of {@link RouteResolver.routeOf}. */
export type ImportRouteResult =
  | { readonly ok: true; readonly route: ImportRoute }
  | { readonly ok: false; readonly error: ImportRouteFailure }

/**
 * Relative import specifier from `fromFile` to `targetFile`, with the extension mapped:
 * `js` (`.ts`/`.tsx` → `.js`, `.mts` → `.mjs`, `.cts` → `.cjs`), `ts` (unchanged) or `none`
 * (removed). Declaration files map to their JavaScript counterpart (`.d.ts` → `.js`).
 */
export function importSpecifier(fromFile: string, targetFile: string, importExtension: ImportExtension): string {
  let relative = relativePath(dirName(fromFile), targetFile)
  if (!relative.startsWith('../')) {
    relative = `./${relative}`
  }
  const declaration = /\.d\.([cm]?)ts$/.exec(relative)
  if (declaration) {
    const base = relative.slice(0, -declaration[0].length)
    return importExtension === 'none' ? base : `${base}.${declaration[1] ?? ''}js`
  }
  const extension = path.posix.extname(relative)
  const base = relative.slice(0, relative.length - extension.length)
  if (importExtension === 'none') {
    return base
  }
  if (importExtension === 'ts') {
    return relative
  }
  switch (extension) {
    case '.ts':
    case '.tsx':
    case '.jsx':
      return `${base}.js`
    case '.mts':
      return `${base}.mjs`
    case '.cts':
      return `${base}.cjs`
    default:
      return relative
  }
}

interface ExportCandidate {
  readonly file: string
  readonly exportName: string
  readonly typeOnly: boolean
}

/** Computes import routes. */
export class RouteResolver {
  readonly #host: ProjectHost
  readonly #symbols: SymbolResolver
  readonly #identities: IdentityResolver

  constructor(host: ProjectHost, symbols: SymbolResolver, identities: IdentityResolver) {
    this.#host = host
    this.#symbols = symbols
    this.#identities = identities
  }

  /** Import route of a symbol or declaration, from `fromFile` (default: `outFile`). */
  routeOf(target: SymbolResolution | Declaration, fromFile: string = this.#host.options.outFile): ImportRouteResult {
    const symbol = isSymbol(target) ? target : declarationSymbol(target)
    switch (symbol.kind) {
      case 'declaration':
        return this.#declarationRoute(symbol.declaration, fromFile)
      case 'expression': {
        const info = this.#identities.identityOf(symbol)
        if (info?.owner === 'package') {
          return this.#packageRoute(info.specifier, info.exportPath, info.public, info.displayName, fromFile, false)
        }
        return ok({
          specifier: importSpecifier(fromFile, symbol.file, this.#host.options.importExtension),
          exportName: 'default',
          members: [],
          typeOnly: false,
        })
      }
      case 'external': {
        if (symbol.path.length === 0) {
          return failure('unresolved', `A whole module (${symbol.specifier}) has no import route`, [])
        }
        if (symbol.reason === 'builtin') {
          const [exportName, ...members] = symbol.path as [string, ...string[]]
          return ok({ specifier: symbol.specifier, exportName, members, typeOnly: false })
        }
        const runtime = this.#host.resolveModule(fromFile, symbol.specifier, undefined, 'runtime')
        if (runtime.kind === 'not-found') {
          return runtimeFailure(symbol.specifier, fromFile)
        }
        // CommonJS without types: the default import (`module.exports`) is the only reliable binding.
        const members = symbol.path[0] === 'default' ? symbol.path.slice(1) : symbol.path
        return ok({ specifier: symbol.specifier, exportName: 'default', members, typeOnly: false })
      }
      case 'global':
        return failure('global', `'${symbol.name}' is a global and has no import route`, [])
      case 'module': {
        const info = this.#identities.identityOf(symbol)
        if (info?.owner === 'package') {
          return this.#packageRoute(info.specifier, info.exportPath, info.public, info.displayName, fromFile, false)
        }
        return failure(
          'unresolved',
          'A namespace import of an application module has no import route, import one of its exports',
          [],
        )
      }
      case 'unresolved':
        return failure('unresolved', symbol.message, [])
    }
  }

  #declarationRoute(declaration: Declaration, fromFile: string): ImportRouteResult {
    if (declaration.anonymous) {
      return failure('anonymous-default', `The default export of ${this.#display(declaration.file)} has no name`, [
        'Give it a name and export it: `export default class MyClass {}` or `export class MyClass {}`',
      ])
    }
    const info = this.#identities.identityOfDeclaration(declaration)
    const typeOnly = isTypeDeclaration(declaration)
    if (info.owner === 'package') {
      return this.#packageRoute(info.specifier, info.exportPath, info.public, declaration.name, fromFile, typeOnly)
    }
    // Members of a namespace are imported through their outermost namespace (each level must export them).
    let top = declaration
    const members: string[] = []
    while (top.namespace) {
      const parent: Declaration = top.namespace
      const exported = memberExportName(parent, top)
      if (exported === undefined) {
        return failure('not-exported', `'${top.name}' is not exported by namespace '${parent.name}'`, [
          `Export it: \`export ${top.kind} ${top.localName} ...\` inside the namespace`,
        ])
      }
      members.unshift(exported)
      top = parent
    }
    const candidate = this.#directExport(top)
    if (!candidate) {
      return failure('not-exported', `'${declaration.name}' is not exported by ${this.#display(declaration.file)}`, [
        `Export it: \`export ${top.kind} ${top.localName} ...\``,
      ])
    }
    const declaringFile = this.#host.getFile(candidate.file)
    return ok({
      specifier: importSpecifier(fromFile, candidate.file, this.#host.options.importExtension),
      exportName: candidate.exportName,
      members,
      typeOnly: typeOnly || candidate.typeOnly || declaringFile?.isDeclarationFile === true,
    })
  }

  #packageRoute(
    specifier: string | undefined,
    exportPath: readonly string[],
    isPublic: boolean,
    name: string,
    fromFile: string,
    typeOnly: boolean,
  ): ImportRouteResult {
    const [exportName, ...members] = exportPath
    if (!isPublic || specifier === undefined || exportName === undefined) {
      return failure('internal', `'${name}' is not exported by a public entry of ${specifier ?? 'its package'}`, [
        `Export it from the package entry point (package.json "exports")`,
      ])
    }
    const runtime = this.#host.resolveModule(fromFile, specifier, undefined, 'runtime')
    if (runtime.kind === 'not-found') {
      return runtimeFailure(specifier, fromFile)
    }
    if (exportName !== 'default' && this.#usesExportAssignment(specifier)) {
      // `export =` (CommonJS) entry: named exports are not reliable at runtime, use the default import.
      return ok({ specifier, exportName: 'default', members: exportPath, typeOnly })
    }
    return ok({ specifier, exportName, members, typeOnly })
  }

  /** `true` when the public entry `specifier` is declared with `export =`. */
  #usesExportAssignment(specifier: string): boolean {
    const resolution = this.#host.resolveFromDirectory(this.#host.options.root, specifier)
    return resolution.kind === 'file' && this.#host.getFile(resolution.path)?.facts.exportAssignment !== undefined
  }

  /** Name under which the declaring module itself exports `declaration` (alias-aware). */
  #directExport(declaration: Declaration): ExportCandidate | undefined {
    const file = this.#host.getFile(declaration.file)
    if (!file) {
      return undefined
    }
    const key = declarationKey(declaration)
    const names: ExportCandidate[] = []
    for (const [exported, entry] of file.facts.exports) {
      if (entry.kind !== 'local') {
        continue
      }
      const resolved = this.#symbols.resolveInScope({ file }, entry.local)
      if (
        resolved.kind === 'declaration' &&
        resolved.declarations.some(candidate => declarationKey(candidate) === key)
      ) {
        names.push({ file: file.path, exportName: exported, typeOnly: entry.typeOnly })
      }
    }
    const assignment = file.facts.exportAssignment
    if (assignment) {
      // `export = Foo` (CommonJS TypeScript): Foo is the default import of the module.
      const resolved = this.#symbols.resolveEntity({ file }, assignment.expression)
      if (
        resolved.kind === 'declaration' &&
        resolved.declarations.some(candidate => declarationKey(candidate) === key)
      ) {
        names.push({ file: file.path, exportName: 'default', typeOnly: false })
      }
    }
    return bestCandidate(names, declaration.localName)
  }

  #display(file: string): string {
    return relativePath(this.#host.options.root, file)
  }
}

function bestCandidate(candidates: readonly ExportCandidate[], localName: string): ExportCandidate | undefined {
  const sorted = [...candidates].sort(
    (a, b) => rank(a, localName) - rank(b, localName) || compareStrings(a.exportName, b.exportName),
  )
  return sorted[0]
}

/** Name under which a namespace exports one of its own members (`export { Hidden as Visible }` aware). */
function memberExportName(namespace: Declaration, member: Declaration): string | undefined {
  const names: string[] = []
  for (const [exported, entry] of namespaceFacts(namespace).exports) {
    if (entry.kind === 'local' && entry.local === member.localName) {
      names.push(exported)
    }
  }
  return names.includes(member.localName) ? member.localName : names.sort(compareStrings)[0]
}

function rank(candidate: ExportCandidate, localName: string): number {
  if (candidate.exportName === localName) {
    return 0
  }
  return candidate.exportName === 'default' ? 2 : 1
}

function isTypeDeclaration(declaration: Declaration): boolean {
  return declaration.kind === 'interface' || declaration.kind === 'type'
}

function isSymbol(value: SymbolResolution | Declaration): value is SymbolResolution {
  return !('localName' in value)
}

function declarationSymbol(declaration: Declaration): SymbolResolution {
  return { kind: 'declaration', declaration, declarations: [declaration] }
}

function ok(route: ImportRoute): ImportRouteResult {
  return { ok: true, route }
}

function failure(reason: ImportRouteFailureReason, message: string, hints: readonly string[]): ImportRouteResult {
  return { ok: false, error: { reason, message, hints } }
}

function runtimeFailure(specifier: string, fromFile: string): ImportRouteResult {
  return failure(
    'runtime-unresolvable',
    `'${specifier}' cannot be resolved from ${fromFile} with the runtime conditions`,
    [`Add '${packageNameOf(specifier)}' to the dependencies of the application`],
  )
}
