/**
 * Canonical identities (§4.1).
 *
 * - application declaration: `<real path relative to root>#<Name>` (`src/users/user.service.ts#UserService`,
 *   `src/types.ts#NS.Inner` for namespace members, `src/x.ts#default` for anonymous defaults);
 * - package declaration: `<entry specifier>#<ExportPath>` where the entry is the package's public
 *   root entry (`@acme/lib#Logger`) or, when the root does not export it, the subpath entry
 *   (`@acme/lib/testing#FakeLogger`). Members of exported namespaces use a dotted path
 *   (`@acme/lib#tokens.TokenHolder`). The export path is computed by walking the public entries
 *   (`.ts` sources or `.d.ts`/`.d.mts` declarations), so it does not depend on conditions, symlinks
 *   or on how the package is bundled;
 * - package declaration not reachable from any public entry (internal):
 *   `<package>/<path relative to the package>#<Name>`, flagged `public: false`;
 * - builtin or untyped module export: `<specifier>#<ExportPath>` (`node:events#EventEmitter`, `pg#Pool`);
 * - global: `globalThis#<Name>` (`globalThis#Date`).
 */
import type { Declaration } from './facts.ts'
import type { ProjectHost } from './host.ts'
import type { PackageEntry, PackageInfo } from './packages.ts'
import type { SourceFile } from './source-file.ts'
import type { SymbolResolution, SymbolResolver } from './symbols.ts'

import { compareStrings } from './compare.ts'
import { namespaceFacts } from './facts.ts'
import { isJavaScriptPath, packageNameOf, relativePath, resolvePath } from './paths.ts'
import { declarationKey, pickDeclaration, symbolKey } from './symbols.ts'

/** Who owns the identified entity. */
export type IdentityOwner = 'application' | 'package' | 'external' | 'global'

/** A canonical identity and how it was derived. */
export interface IdentityInfo {
  /** The canonical identity string (also the provider token). */
  readonly identity: string
  /** Part after the last `#` (`UserService`, `tokens.TokenHolder`), used in messages. */
  readonly displayName: string
  readonly owner: IdentityOwner
  /**
   * Package and external identities: bare specifier of the public entry (`@acme/lib`,
   * `@acme/lib/sub`, `node:events`). Application identities: `undefined`.
   */
  readonly specifier: string | undefined
  /** Package and external identities: export path from {@link specifier} (`['tokens', 'TokenHolder']`). */
  readonly exportPath: readonly string[]
  /** `false` for package declarations not reachable from a public entry. */
  readonly public: boolean
  /** Application identities: declaring file relative to the root (POSIX). */
  readonly relativePath: string | undefined
}

/** Where a package declaration is publicly exported. */
export interface PublicExport {
  readonly entry: PackageEntry
  readonly path: readonly string[]
}

/** Prefix of identities of global names. */
export const GLOBAL_IDENTITY_PREFIX = 'globalThis#'

const MAX_NAMESPACE_DEPTH = 4

interface IndexedExport extends PublicExport {
  readonly entryIndex: number
}

/** Splits an identity into its owner part and its name part (around the last `#`). */
export function splitIdentity(identity: string): { readonly owner: string; readonly name: string } | undefined {
  const separator = identity.lastIndexOf('#')
  if (separator <= 0 || separator === identity.length - 1) {
    return undefined
  }
  return { owner: identity.slice(0, separator), name: identity.slice(separator + 1) }
}

/** Display name of an identity: the part after the last `#`. */
export function displayNameOf(identity: string): string {
  return identity.slice(identity.lastIndexOf('#') + 1)
}

/** Computes canonical identities. Memoized for the lifetime of the resolver (one compile). */
export class IdentityResolver {
  readonly #host: ProjectHost
  readonly #symbols: SymbolResolver
  readonly #indexes = new Map<string, ReadonlyMap<string, IndexedExport>>()
  readonly #entryFiles = new Map<string, string | null>()
  readonly #public = new Map<string, boolean>()

  constructor(host: ProjectHost, symbols: SymbolResolver) {
    this.#host = host
    this.#symbols = symbols
  }

  /**
   * Identity of a resolved symbol; `undefined` for unresolved symbols, whole external modules and
   * namespace objects that are not exported by a package (`import * as ns from './local.ts'`).
   */
  identityOf(symbol: SymbolResolution): IdentityInfo | undefined {
    switch (symbol.kind) {
      case 'declaration':
        return this.identityOfDeclaration(symbol.declaration)
      case 'expression':
        return this.#identityOfKey(symbol.file, `${symbol.file}#default`, 'default')
      case 'module': {
        // Only the namespace objects a package exports publicly (`export * as ns`) have an identity.
        const owner = this.#host.packages.ownerOf(symbol.file)
        const found = owner.kind === 'package' ? this.#index(owner.package).get(symbolKey(symbol)) : undefined
        return found ? publicIdentity(found) : undefined
      }
      case 'external':
        if (symbol.path.length === 0) {
          return undefined
        }
        return {
          identity: `${symbol.specifier}#${symbol.path.join('.')}`,
          displayName: symbol.path.join('.'),
          owner: 'external',
          specifier: symbol.specifier,
          exportPath: symbol.path,
          public: true,
          relativePath: undefined,
        }
      case 'global':
        return {
          identity: `${GLOBAL_IDENTITY_PREFIX}${symbol.name}`,
          displayName: symbol.name,
          owner: 'global',
          specifier: undefined,
          exportPath: [],
          public: true,
          relativePath: undefined,
        }
      default:
        return undefined
    }
  }

  /**
   * Finds the entity named by a canonical identity: `src/a.ts#Foo`, `src/ns.ts#NS.Inner`,
   * `@acme/lib#tokens.Holder`, `@acme/lib/src/internal.ts#Base` (internal), `pg#Pool`,
   * `node:events#EventEmitter`, `globalThis#Date`.
   */
  lookup(identity: string): SymbolResolution {
    const parts = splitIdentity(identity)
    if (!parts) {
      return { kind: 'unresolved', reason: 'unsupported-expression', message: `Invalid identity '${identity}'` }
    }
    if (parts.owner === 'globalThis') {
      return { kind: 'global', name: parts.name }
    }
    const host = this.#host
    const root = host.options.root
    const path = parts.name.split('.')
    const applicationFile = host.getFile(resolvePath(parts.owner, root))
    if (applicationFile && host.packages.ownerOf(applicationFile.path).kind === 'application') {
      const declared = declarationAt(applicationFile, path)
      if (declared) {
        return declared
      }
      // `<path>#default` also names `export default <expression>`, which is not a declaration.
      return parts.name === 'default'
        ? this.#symbols.resolveExport(applicationFile.path, 'default')
        : this.#symbols.resolveEntity({ file: applicationFile }, parts.name)
    }
    const resolution = host.resolveFromDirectory(root, parts.owner)
    let file: SourceFile | undefined
    if (resolution.kind === 'builtin') {
      return { kind: 'external', specifier: resolution.specifier, path, reason: 'builtin' }
    }
    if (resolution.kind === 'file') {
      file = host.getFile(resolution.path)
    } else {
      // Internal identity `<package>/<path in package>#<Name>`: not reachable through `exports`.
      const name = packageNameOf(parts.owner)
      const info = host.packages.findInstalled(name, root)
      file = info ? host.getFile(`${info.dir}${parts.owner.slice(name.length)}`) : undefined
      if (!file) {
        return {
          kind: 'unresolved',
          reason: 'module-not-found',
          message: `Cannot resolve '${parts.owner}' from ${root}`,
        }
      }
    }
    if (!file || (!file.facts.hasModuleSyntax && !file.isDeclarationFile && isJavaScriptPath(file.path))) {
      return { kind: 'external', specifier: parts.owner, path, reason: 'untyped' }
    }
    const [head = '', ...members] = path
    let symbol = this.#symbols.resolveExport(file.path, head)
    if (symbol.kind === 'unresolved') {
      return declarationAt(file, path) ?? symbol
    }
    for (const member of members) {
      symbol = this.#symbols.resolveMember(symbol, member)
    }
    return symbol
  }

  /** Identity of a declaration (application, public package export or package-internal). */
  identityOfDeclaration(declaration: Declaration): IdentityInfo {
    return this.#identityOfKey(declaration.file, declarationKey(declaration), declaration.name)
  }

  /**
   * `false` for a package-internal identity (`<package>/<path in package>#Name`): it depends on the
   * package layout (sources vs `dist`, chunk names), so it never becomes a runtime token. Every
   * other identity (application, public package export, builtin, global, unresolved) is public.
   */
  isPublic(identity: string): boolean {
    let cached = this.#public.get(identity)
    if (cached === undefined) {
      const symbol = this.lookup(identity)
      cached = symbol.kind !== 'declaration' || this.identityOfDeclaration(symbol.declaration).public
      this.#public.set(identity, cached)
    }
    return cached
  }

  /**
   * Public export index of a package: declaration key (`<file>#<name>`) → best public export.
   * Preference: root entry, then subpath entries (sorted); shorter export paths; named exports
   * before `default`; then lexicographic order.
   */
  publicIndex(info: PackageInfo): ReadonlyMap<string, PublicExport> {
    return this.#index(info)
  }

  /** File a public entry of a package resolves to with the scan conditions (`undefined` if none). */
  entryFile(info: PackageInfo, entry: PackageEntry): string | undefined {
    const key = `${info.dir}\0${entry.subpath}`
    const cached = this.#entryFiles.get(key)
    if (cached !== undefined) {
      return cached ?? undefined
    }
    const name = info.name ?? ''
    const specifier = entry.subpath === '.' ? name : `${name}${entry.subpath.slice(1)}`
    // Self-reference through `exports` first; packages without `exports` are resolved as a directory.
    let resolution = this.#host.resolveFromDirectory(info.dir, specifier)
    if (resolution.kind !== 'file' && entry.subpath === '.') {
      resolution = this.#host.resolveFromDirectory(info.dir, './')
    }
    const file = resolution.kind === 'file' ? resolution.path : undefined
    this.#entryFiles.set(key, file ?? null)
    return file
  }

  #identityOfKey(file: string, key: string, name: string): IdentityInfo {
    const owner = this.#host.packages.ownerOf(file)
    if (owner.kind === 'application') {
      const relative = relativePath(this.#host.options.root, file)
      return {
        identity: `${relative}#${name}`,
        displayName: name,
        owner: 'application',
        specifier: undefined,
        exportPath: [],
        public: true,
        relativePath: relative,
      }
    }
    const info = owner.package
    const found = this.#index(info).get(key)
    if (found) {
      return publicIdentity(found)
    }
    return {
      identity: `${info.publicName}/${relativePath(info.dir, file)}#${name}`,
      displayName: name,
      owner: 'package',
      specifier: info.publicName,
      exportPath: [],
      public: false,
      relativePath: undefined,
    }
  }

  #index(info: PackageInfo): ReadonlyMap<string, IndexedExport> {
    const cached = this.#indexes.get(info.dir)
    if (cached) {
      return cached
    }
    const index = new Map<string, IndexedExport>()
    // Guard against re-entrance (an entry re-exporting a package that re-exports this one).
    this.#indexes.set(info.dir, index)
    this.#host.packages.entries(info).forEach((entry, entryIndex) => {
      const file = this.entryFile(info, entry)
      if (file !== undefined) {
        this.#indexNamespace(info, { kind: 'module', file }, [], entry, entryIndex, index, new Set(), 0)
      }
    })
    return index
  }

  #indexNamespace(
    info: PackageInfo,
    symbol: SymbolResolution,
    prefix: readonly string[],
    entry: PackageEntry,
    entryIndex: number,
    index: Map<string, IndexedExport>,
    visited: Set<string>,
    depth: number,
  ): void {
    const key = symbolKey(symbol)
    if (visited.has(key) || depth > MAX_NAMESPACE_DEPTH) {
      return
    }
    visited.add(key)
    const symbols = this.#symbols
    const names = symbol.kind === 'module' ? symbols.exportNames(symbol.file) : symbols.membersOf(symbol)
    for (const name of names) {
      const resolved =
        symbol.kind === 'module' ? symbols.resolveExport(symbol.file, name) : symbols.resolveMember(symbol, name)
      const path = [...prefix, name]
      if (resolved.kind === 'declaration') {
        if (this.#owns(info, resolved.declaration.file)) {
          for (const declaration of resolved.declarations) {
            record(index, declarationKey(declaration), { entry, entryIndex, path })
          }
        }
        if (resolved.declarations.some(declaration => declaration.kind === 'namespace')) {
          this.#indexNamespace(info, resolved, path, entry, entryIndex, index, visited, depth + 1)
        }
      } else if (resolved.kind === 'expression') {
        if (this.#owns(info, resolved.file)) {
          record(index, `${resolved.file}#default`, { entry, entryIndex, path })
        }
      } else if (resolved.kind === 'module') {
        // `export * as ns`: the namespace object itself is public (a `declare namespace` in .d.ts).
        if (this.#owns(info, resolved.file)) {
          record(index, symbolKey(resolved), { entry, entryIndex, path })
        }
        this.#indexNamespace(info, resolved, path, entry, entryIndex, index, visited, depth + 1)
      }
    }
  }

  #owns(info: PackageInfo, file: string): boolean {
    return this.#host.packages.packageOf(file)?.dir === info.dir
  }
}

function publicIdentity(found: PublicExport): IdentityInfo {
  const path = found.path.join('.')
  return {
    identity: `${found.entry.specifier}#${path}`,
    displayName: path,
    owner: 'package',
    specifier: found.entry.specifier,
    exportPath: found.path,
    public: true,
    relativePath: undefined,
  }
}

/** The declaration named by a dotted path in a file (`NS.Inner` walks namespace members, exported or not). */
function declarationAt(file: SourceFile, path: readonly string[]): SymbolResolution | undefined {
  let declarations = file.facts.declarations.get(path[0] ?? '')
  for (const segment of path.slice(1)) {
    const namespace = declarations?.find(declaration => declaration.kind === 'namespace')
    declarations = namespace ? namespaceFacts(namespace).declarations.get(segment) : undefined
  }
  const declaration = declarations && pickDeclaration(declarations, 'any')
  return declaration && declarations ? { kind: 'declaration', declaration, declarations } : undefined
}

function record(index: Map<string, IndexedExport>, key: string, candidate: IndexedExport): void {
  const current = index.get(key)
  if (current === undefined || compareExports(candidate, current) < 0) {
    index.set(key, candidate)
  }
}

function compareExports(a: IndexedExport, b: IndexedExport): number {
  if (a.entryIndex !== b.entryIndex) {
    return a.entryIndex - b.entryIndex
  }
  if (a.path.length !== b.path.length) {
    return a.path.length - b.path.length
  }
  const defaultA = a.path[a.path.length - 1] === 'default' ? 1 : 0
  const defaultB = b.path[b.path.length - 1] === 'default' ? 1 : 0
  if (defaultA !== defaultB) {
    return defaultA - defaultB
  }
  return compareStrings(a.path.join('.'), b.path.join('.'))
}
