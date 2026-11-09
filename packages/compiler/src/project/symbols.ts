/**
 * Symbol resolution: from a name used in a file to the declaration it refers to, following
 * imports, re-exports (`export { a } from`, `export *`, `export * as ns`), namespace imports,
 * `export =` and namespace declarations, across files and packages.
 *
 * Results are memoized for the lifetime of the resolver (one compile).
 */
import type { Expression, TSTypeName } from 'oxc-parser'
import type { Declaration, DeclarationKind, ExportEntry, ImportBinding } from './facts.ts'
import type { ProjectHost } from './host.ts'
import type { SourceFile } from './source-file.ts'

import { compareStrings } from './compare.ts'
import { namespaceFacts } from './facts.ts'
import { isBareSpecifier, isJavaScriptPath } from './paths.ts'

/** Which declaration space a name is looked up in (declaration merging: `const X` + `type X`). */
export type Meaning = 'value' | 'type' | 'any'

/** A declaration (class, interface, type alias, enum, function, variable or namespace). */
export interface DeclarationSymbol {
  readonly kind: 'declaration'
  /** The declaration selected for the requested meaning. */
  readonly declaration: Declaration
  /** Every declaration merged under that name in the same scope (source order). */
  readonly declarations: readonly Declaration[]
}

/** The namespace object of a module (`import * as ns`, `export * as ns`). */
export interface ModuleSymbol {
  readonly kind: 'module'
  readonly file: string
}

/** `export default <expression>` (an expression that is not a named declaration). */
export interface ExpressionSymbol {
  readonly kind: 'expression'
  readonly file: string
  readonly expression: Expression
}

/**
 * An export of a module the compiler cannot analyse: a Node.js builtin (`node:events`) or an
 * untyped/CommonJS package. `path` is the export path (`['Pool']`, `[]` for the module itself).
 */
export interface ExternalSymbol {
  readonly kind: 'external'
  /** Bare specifier (`pg`, `node:events`). */
  readonly specifier: string
  readonly path: readonly string[]
  readonly reason: 'builtin' | 'untyped'
}

/** A name that is neither declared nor imported: a global (`Promise`, `Date`) or a typo. */
export interface GlobalSymbol {
  readonly kind: 'global'
  readonly name: string
}

/** Why a resolution failed. */
export type UnresolvedReason =
  | 'module-not-found'
  | 'unsupported-module'
  | 'export-not-found'
  | 'ambiguous-export'
  | 'circular'
  | 'not-a-namespace'
  | 'unsupported-expression'

/** A failed resolution, with a human readable message. */
export interface UnresolvedSymbol {
  readonly kind: 'unresolved'
  readonly reason: UnresolvedReason
  readonly message: string
}

/** Result of every lookup of {@link SymbolResolver}. */
export type SymbolResolution =
  | DeclarationSymbol
  | ModuleSymbol
  | ExpressionSymbol
  | ExternalSymbol
  | GlobalSymbol
  | UnresolvedSymbol

/** A lexical scope: a file, optionally inside a namespace declaration of that file. */
export interface ScopeRef {
  readonly file: SourceFile
  readonly namespace?: Declaration | undefined
}

/** A name to resolve: `'Foo'`, `'ns.Foo'`, or an identifier / member expression / qualified type name. */
export type EntityName = string | Expression | TSTypeName

const TYPE_PRIORITY: readonly DeclarationKind[] = ['class', 'interface', 'type', 'enum', 'namespace']
const VALUE_PRIORITY: readonly DeclarationKind[] = ['class', 'enum', 'function', 'const', 'let', 'var', 'namespace']
const ANY_PRIORITY: readonly DeclarationKind[] = [
  'class',
  'enum',
  'interface',
  'type',
  'function',
  'const',
  'let',
  'var',
  'namespace',
]
const PRIORITIES: Readonly<Record<Meaning, readonly DeclarationKind[]>> = {
  type: TYPE_PRIORITY,
  value: VALUE_PRIORITY,
  any: ANY_PRIORITY,
}

/** Picks the declaration matching `meaning` among merged declarations. */
export function pickDeclaration(declarations: readonly Declaration[], meaning: Meaning): Declaration | undefined {
  const priority = PRIORITIES[meaning]
  for (const kind of priority) {
    const found = declarations.find(declaration => declaration.kind === kind)
    if (found) {
      return found
    }
  }
  return declarations[0]
}

/** Stable key of a declaration: `<file>#<name>`. */
export function declarationKey(declaration: Declaration): string {
  return `${declaration.file}#${declaration.name}`
}

/** Stable key of a symbol (two symbols with the same key are the same entity). */
export function symbolKey(symbol: SymbolResolution): string {
  switch (symbol.kind) {
    case 'declaration':
      return declarationKey(symbol.declaration)
    case 'module':
      return `module:${symbol.file}`
    case 'expression':
      return `${symbol.file}#default`
    case 'external':
      return `external:${symbol.specifier}#${symbol.path.join('.')}`
    case 'global':
      return `global:${symbol.name}`
    case 'unresolved':
      return `unresolved:${symbol.reason}:${symbol.message}`
  }
}

function unresolved(reason: UnresolvedReason, message: string): UnresolvedSymbol {
  return { kind: 'unresolved', reason, message }
}

function declarationSymbol(declarations: readonly Declaration[], meaning: Meaning): DeclarationSymbol {
  const declaration = pickDeclaration(declarations, meaning) as Declaration
  return { kind: 'declaration', declaration, declarations }
}

function addAll(target: Set<string> | undefined, values: Iterable<string>): void {
  if (target) {
    for (const value of values) {
      target.add(value)
    }
  }
}

type ModuleTarget = { readonly kind: 'file'; readonly file: SourceFile } | ExternalSymbol | UnresolvedSymbol

/**
 * Resolves names to declarations. Every method accepts an optional `track` set that receives the
 * paths of the files read during the lookup (used for invalidation by the evaluator).
 */
export class SymbolResolver {
  readonly #host: ProjectHost
  readonly #exportMemo = new Map<string, { readonly result: SymbolResolution; readonly files: readonly string[] }>()
  readonly #exportNamesMemo = new Map<
    string,
    { readonly names: readonly string[]; readonly files: readonly string[] }
  >()
  /** Guarded lookups in progress (re-exports, `export =` assignments, export names), with their depth. */
  readonly #inProgress = new Map<string, number>()
  /** Shallowest in-progress lookup a cycle was cut back to, since the innermost guarded lookup started. */
  #cutDepth = Number.POSITIVE_INFINITY

  constructor(host: ProjectHost) {
    this.#host = host
  }

  /**
   * Runs a lookup that can be re-entered through a cycle. Re-entering a lookup in progress returns
   * `cut()`. `complete` is `true` when no cycle was cut back to a lookup started before this one:
   * a cycle cut back to the lookup itself does not change its result (re-entering it again cannot
   * find anything new), so the head of a cycle can be memoized, only the lookups inside the cycle
   * cannot.
   */
  #guarded<T>(key: string, cut: () => T, run: () => T): { readonly value: T; readonly complete: boolean } {
    const inProgress = this.#inProgress.get(key)
    if (inProgress !== undefined) {
      this.#cutDepth = Math.min(this.#cutDepth, inProgress)
      return { value: cut(), complete: false }
    }
    const depth = this.#inProgress.size
    const outer = this.#cutDepth
    this.#cutDepth = Number.POSITIVE_INFINITY
    this.#inProgress.set(key, depth)
    try {
      const value = run()
      return { value, complete: this.#cutDepth >= depth }
    } finally {
      this.#inProgress.delete(key)
      this.#cutDepth = Math.min(outer, this.#cutDepth)
    }
  }

  /** Resolves a top-level name of `file` (local declaration, import or global). */
  resolveName(file: SourceFile, name: string, meaning: Meaning = 'any', track?: Set<string>): SymbolResolution {
    return this.resolveInScope({ file }, name, meaning, track)
  }

  /** Resolves a name in a scope: enclosing namespaces first, then the module (declarations, imports). */
  resolveInScope(scope: ScopeRef, name: string, meaning: Meaning = 'any', track?: Set<string>): SymbolResolution {
    track?.add(scope.file.path)
    let namespace = scope.namespace
    while (namespace) {
      const declarations = namespaceFacts(namespace).declarations.get(name)
      if (declarations) {
        return declarationSymbol(declarations, meaning)
      }
      namespace = namespace.namespace
    }
    const facts = scope.file.facts
    const declarations = facts.declarations.get(name)
    if (declarations) {
      return declarationSymbol(declarations, meaning)
    }
    const binding = facts.imports.get(name)
    if (binding) {
      return this.resolveImport(scope.file, binding, meaning, track)
    }
    return { kind: 'global', name }
  }

  /** Resolves what an import binding refers to. */
  resolveImport(
    file: SourceFile,
    binding: ImportBinding,
    meaning: Meaning = 'any',
    track?: Set<string>,
  ): SymbolResolution {
    const target = this.#moduleTarget(file, binding.specifier, binding.specifierSpan, track)
    if (target.kind === 'external') {
      return binding.kind === 'namespace' || binding.kind === 'require'
        ? target
        : { ...target, path: [binding.imported] }
    }
    if (target.kind === 'unresolved') {
      return target
    }
    if (binding.kind === 'namespace' || binding.kind === 'require') {
      return this.#moduleObject(target.file, meaning, track)
    }
    return this.resolveExport(target.file.path, binding.imported, meaning, track)
  }

  /** Resolves an export of a module, following re-exports and `export *`. */
  resolveExport(path: string, name: string, meaning: Meaning = 'any', track?: Set<string>): SymbolResolution {
    const key = `${meaning}\0${path}\0${name}`
    const memo = this.#exportMemo.get(key)
    if (memo) {
      addAll(track, memo.files)
      return memo.result
    }
    const files = new Set<string>()
    const { value: result, complete } = this.#guarded(
      `${path}\0${name}`,
      () => unresolved('circular', `Circular re-export of '${name}'`),
      () => this.#resolveExport(path, name, meaning, files),
    )
    // A lookup inside a cycle cut further up may be incomplete: memoize only complete results.
    if (complete) {
      this.#exportMemo.set(key, { result, files: [...files] })
    }
    addAll(track, files)
    return result
  }

  /** Resolves `symbol.member` (namespace import, namespace declaration, `export =` namespace, external). */
  resolveMember(
    symbol: SymbolResolution,
    member: string,
    meaning: Meaning = 'any',
    track?: Set<string>,
  ): SymbolResolution {
    switch (symbol.kind) {
      case 'module':
        return this.resolveExport(symbol.file, member, meaning, track)
      case 'external':
        return { ...symbol, path: [...symbol.path, member] }
      case 'declaration': {
        for (const declaration of symbol.declarations) {
          if (declaration.kind !== 'namespace') {
            continue
          }
          const entry = namespaceFacts(declaration).exports.get(member)
          const file = this.#host.getFile(declaration.file)
          if (entry && file) {
            return this.#resolveEntry(file, declaration, entry, meaning, track)
          }
        }
        const name = symbol.declaration.name
        return symbol.declarations.some(declaration => declaration.kind === 'namespace')
          ? unresolved('export-not-found', `Namespace '${name}' has no exported member '${member}'`)
          : unresolved(
              'not-a-namespace',
              `'${name}' is a ${symbol.declaration.kind}, its member '${member}' cannot be resolved statically`,
            )
      }
      case 'unresolved':
        return symbol
      default:
        return unresolved('not-a-namespace', `Cannot resolve member '${member}' of a ${symbol.kind}`)
    }
  }

  /**
   * Resolves an entity name: `Foo`, `ns.Foo`, `pg.Pool`, `NS.Inner.Deep` (string, identifier,
   * static member expression or qualified type name).
   *
   * Member access on a default import maps to the module's export (`import pg from 'pg'; pg.Pool`
   * → the `Pool` export of `pg`) when the default export is not itself a namespace containing it.
   */
  resolveEntity(scope: ScopeRef, name: EntityName, meaning: Meaning = 'any', track?: Set<string>): SymbolResolution {
    if (typeof name === 'string') {
      const parts = name.split('.')
      let dotted: Dotted = parts[0] ?? ''
      for (const part of parts.slice(1)) {
        dotted = { object: dotted, property: part }
      }
      return this.#resolveDotted(scope, dotted, meaning, track)
    }
    const dotted = toDotted(name)
    if (dotted === undefined) {
      return unresolved('unsupported-expression', 'Only identifiers and static member accesses can be resolved')
    }
    return this.#resolveDotted(scope, dotted, meaning, track)
  }

  /**
   * Every export name of a module (own exports, names re-exported by `export *` except `default`,
   * members of an `export =` namespace), sorted. Names exported ambiguously are included.
   */
  exportNames(path: string, track?: Set<string>): readonly string[] {
    const memo = this.#exportNamesMemo.get(path)
    if (memo) {
      addAll(track, memo.files)
      return memo.names
    }
    const files = new Set<string>()
    const { value: sorted, complete } = this.#guarded(
      `names\0${path}`,
      (): readonly string[] => [],
      () => {
        const names = new Set<string>()
        this.#collectExportNames(path, names, new Set(), files)
        return [...names].sort(compareStrings)
      },
    )
    // Names collected inside a cycle cut further up may be incomplete: memoize only complete results.
    if (complete) {
      this.#exportNamesMemo.set(path, { names: sorted, files: [...files] })
    }
    addAll(track, files)
    return sorted
  }

  #collectExportNames(path: string, names: Set<string>, visiting: Set<string>, track: Set<string> | undefined): void {
    if (visiting.has(path)) {
      return
    }
    visiting.add(path)
    const file = this.#host.getFile(path)
    if (!file) {
      return
    }
    track?.add(path)
    const facts = file.facts
    for (const name of facts.exports.keys()) {
      names.add(name)
    }
    if (facts.exportAssignment) {
      names.add('default')
      const target = this.#resolveAssignment(file, 'any', track)
      for (const member of this.#memberNames(target, track)) {
        names.add(member)
      }
    }
    for (const star of facts.starExports) {
      const target = this.#moduleTarget(file, star.specifier, star.specifierSpan, track)
      if (target.kind === 'file') {
        const starNames = new Set<string>()
        this.#collectExportNames(target.file.path, starNames, visiting, track)
        starNames.delete('default')
        for (const name of starNames) {
          names.add(name)
        }
      }
    }
  }

  /** Member names of a namespace-like symbol (module or namespace declaration). */
  #memberNames(symbol: SymbolResolution, track: Set<string> | undefined): readonly string[] {
    if (symbol.kind === 'module') {
      return this.exportNames(symbol.file, track)
    }
    if (symbol.kind === 'declaration') {
      return symbol.declarations
        .filter(declaration => declaration.kind === 'namespace')
        .flatMap(declaration => [...namespaceFacts(declaration).exports.keys()])
    }
    return []
  }

  /** Member names of a namespace-like symbol, for index building. */
  membersOf(symbol: SymbolResolution, track?: Set<string>): readonly string[] {
    return [...new Set(this.#memberNames(symbol, track))].sort(compareStrings)
  }

  #resolveExport(path: string, name: string, meaning: Meaning, track: Set<string>): SymbolResolution {
    const file = this.#host.getFile(path)
    if (!file) {
      return unresolved('unsupported-module', `Cannot analyse module ${path}`)
    }
    const own = this.#ownExport(file, name, meaning, track)
    if (own) {
      return own
    }
    if (name !== 'default') {
      const matches = this.#starExports(file, name, meaning, track)
      if (matches.length === 1) {
        return matches[0] as SymbolResolution
      }
      if (matches.length > 1) {
        return unresolved('ambiguous-export', `'${name}' is exported by several 'export *' of ${path}`)
      }
    }
    return unresolved('export-not-found', `Module ${path} has no exported member '${name}'`)
  }

  /**
   * The export `name` of `file` itself (an export entry, or a member of its `export =` target), or
   * `undefined` when it is only looked up in its `export *`.
   */
  #ownExport(file: SourceFile, name: string, meaning: Meaning, track: Set<string>): SymbolResolution | undefined {
    track.add(file.path)
    const facts = file.facts
    const entry = facts.exports.get(name)
    if (entry) {
      return this.#resolveEntry(file, undefined, entry, meaning, track)
    }
    if (facts.exportAssignment) {
      const target = this.#resolveAssignment(file, 'any', track)
      if (name === 'default' || (target.kind === 'unresolved' && target.reason === 'circular')) {
        return target
      }
      const member = this.resolveMember(target, name, meaning, track)
      if (member.kind !== 'unresolved') {
        return member
      }
    }
    return undefined
  }

  /**
   * The distinct exports `name` reached through the `export *` of `file`: a breadth-first walk of
   * the star-export graph that stops at the modules exporting `name` themselves. Each module is
   * visited once, so `export *` cycles and diamonds cost one visit per module (a depth-first walk
   * enumerates every path).
   */
  #starExports(file: SourceFile, name: string, meaning: Meaning, track: Set<string>): SymbolResolution[] {
    const matches: SymbolResolution[] = []
    const visited = new Set([file.path])
    const queue = [file]
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index] as SourceFile
      for (const star of current.facts.starExports) {
        const target = this.#moduleTarget(current, star.specifier, star.specifierSpan, track)
        if (target.kind !== 'file' || visited.has(target.file.path)) {
          continue
        }
        visited.add(target.file.path)
        const result = this.#ownExport(target.file, name, meaning, track)
        if (!result) {
          queue.push(target.file)
        } else if (
          !(result.kind === 'unresolved' && (result.reason === 'export-not-found' || result.reason === 'circular')) &&
          !matches.some(match => symbolKey(match) === symbolKey(result))
        ) {
          matches.push(result)
        }
      }
    }
    return matches
  }

  #resolveEntry(
    file: SourceFile,
    namespace: Declaration | undefined,
    entry: ExportEntry,
    meaning: Meaning,
    track: Set<string> | undefined,
  ): SymbolResolution {
    switch (entry.kind) {
      case 'local':
        return this.resolveInScope({ file, namespace }, entry.local, meaning, track)
      case 'expression':
        return { kind: 'expression', file: file.path, expression: entry.expression }
      case 'reexport': {
        const target = this.#moduleTarget(file, entry.specifier, entry.specifierSpan, track)
        if (target.kind === 'external') {
          return { ...target, path: [entry.imported] }
        }
        if (target.kind === 'unresolved') {
          return target
        }
        return this.resolveExport(target.file.path, entry.imported, meaning, track)
      }
      case 'namespace': {
        const target = this.#moduleTarget(file, entry.specifier, entry.specifierSpan, track)
        if (target.kind !== 'file') {
          return target
        }
        return this.#moduleObject(target.file, meaning, track)
      }
    }
  }

  /** What the module object of `file` is: its `export =` target, or the module itself. */
  #moduleObject(file: SourceFile, meaning: Meaning, track: Set<string> | undefined): SymbolResolution {
    return file.facts.exportAssignment
      ? this.#resolveAssignment(file, meaning, track)
      : { kind: 'module', file: file.path }
  }

  /**
   * Resolves the `export =` expression of `file`. `export = x` where `x` is (directly or through other
   * modules) an import of `file` itself is a cycle that never reaches {@link resolveExport}: it is cut
   * here, like circular re-exports.
   */
  #resolveAssignment(file: SourceFile, meaning: Meaning, track: Set<string> | undefined): SymbolResolution {
    const assignment = file.facts.exportAssignment
    if (!assignment) {
      return unresolved('export-not-found', `Module ${file.path} has no 'export =' assignment`)
    }
    return this.#guarded(
      `assign\0${file.path}`,
      () => unresolved('circular', `Circular 'export =' assignment of ${file.path}`),
      () => this.resolveEntity({ file }, assignment.expression, meaning, track),
    ).value
  }

  #resolveDotted(scope: ScopeRef, node: Dotted, meaning: Meaning, track: Set<string> | undefined): SymbolResolution {
    if (typeof node === 'string') {
      return this.resolveInScope(scope, node, meaning, track)
    }
    const { object, property } = node
    if (typeof object === 'string') {
      const binding = this.#defaultImport(scope, object)
      if (binding) {
        return this.#defaultImportMember(scope.file, binding, property, meaning, track)
      }
    }
    const base = this.#resolveDotted(scope, object, 'any', track)
    return this.resolveMember(base, property, meaning, track)
  }

  /** The default (or `import x = require()`) import bound to `name`, unless shadowed. */
  #defaultImport(scope: ScopeRef, name: string): ImportBinding | undefined {
    let namespace = scope.namespace
    while (namespace) {
      if (namespaceFacts(namespace).declarations.has(name)) {
        return undefined
      }
      namespace = namespace.namespace
    }
    if (scope.file.facts.declarations.has(name)) {
      return undefined
    }
    const binding = scope.file.facts.imports.get(name)
    return binding && (binding.kind === 'default' || binding.kind === 'require') ? binding : undefined
  }

  #defaultImportMember(
    file: SourceFile,
    binding: ImportBinding,
    member: string,
    meaning: Meaning,
    track: Set<string> | undefined,
  ): SymbolResolution {
    const target = this.#moduleTarget(file, binding.specifier, binding.specifierSpan, track)
    if (target.kind === 'external') {
      return { ...target, path: [member] }
    }
    if (target.kind === 'unresolved') {
      return target
    }
    const defaultSymbol = this.resolveImport(file, binding, 'any', track)
    if (defaultSymbol.kind === 'module' || defaultSymbol.kind === 'declaration') {
      const viaDefault = this.resolveMember(defaultSymbol, member, meaning, track)
      if (viaDefault.kind !== 'unresolved') {
        return viaDefault
      }
    }
    const named = this.resolveExport(target.file.path, member, meaning, track)
    if (named.kind !== 'unresolved') {
      return named
    }
    return this.resolveMember(defaultSymbol, member, meaning, track)
  }

  /** Resolves a module specifier to an analysable file, an external module or a failure. */
  #moduleTarget(
    file: SourceFile,
    specifier: string,
    span: { start: number; end: number },
    track: Set<string> | undefined,
  ): ModuleTarget {
    const resolution = this.#host.resolveModule(file.path, specifier, span)
    if (resolution.kind === 'builtin') {
      return { kind: 'external', specifier: resolution.specifier, path: [], reason: 'builtin' }
    }
    if (resolution.kind === 'not-found') {
      return unresolved('module-not-found', `Cannot resolve module '${specifier}' from ${file.path}`)
    }
    const target = this.#host.getFile(resolution.path)
    const analysable =
      target !== undefined &&
      (target.facts.hasModuleSyntax || target.isDeclarationFile || !isJavaScriptPath(target.path))
    if (!target || !analysable) {
      return isBareSpecifier(specifier)
        ? { kind: 'external', specifier, path: [], reason: 'untyped' }
        : unresolved('unsupported-module', `Module '${specifier}' (${resolution.path}) cannot be analysed`)
    }
    track?.add(target.path)
    return { kind: 'file', file: target }
  }
}

type Dotted = string | { readonly object: Dotted; readonly property: string }

/** Converts an identifier / static member expression / qualified name into a dotted structure. */
function toDotted(node: Expression | TSTypeName): Dotted | undefined {
  switch (node.type) {
    case 'Identifier':
      return node.name
    case 'MemberExpression': {
      if (node.optional) {
        return undefined
      }
      let property: string | undefined
      if (!node.computed && node.property.type === 'Identifier') {
        property = node.property.name
      } else if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
        property = node.property.value
      }
      const object = toDotted(node.object)
      return property === undefined || object === undefined ? undefined : { object, property }
    }
    case 'TSQualifiedName': {
      const object = toDotted(node.left)
      return object === undefined ? undefined : { object, property: node.right.name }
    }
    case 'TSNonNullExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      return toDotted(node.expression)
    default:
      return undefined
  }
}
