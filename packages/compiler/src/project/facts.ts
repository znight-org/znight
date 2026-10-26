/**
 * Per-file facts: imports, exports and top-level declarations extracted from the oxc AST.
 *
 * Facts are purely syntactic (no resolution) and are cached with the parse result: they only change
 * when the file content changes. Namespace members (`namespace NS { ... }`, `declare namespace`) are
 * collected lazily with {@link namespaceFacts}.
 */
import type {
  Declaration as AstDeclaration,
  BindingPattern,
  Class,
  Directive,
  Expression,
  Function as FunctionNode,
  ModuleExportName,
  Statement,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSModuleDeclaration,
  TSTypeAliasDeclaration,
  VariableDeclarator,
} from 'oxc-parser'
import type { Span } from './location.ts'

import { spanOf } from './parse.ts'

/** Kind of a declaration. `const`/`let`/`var` are variables. */
export type DeclarationKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'const'
  | 'let'
  | 'var'
  | 'namespace'

/** AST node of a declaration (`VariableDeclarator` for variables). */
export type DeclarationNode =
  | Class
  | TSInterfaceDeclaration
  | TSTypeAliasDeclaration
  | TSEnumDeclaration
  | FunctionNode
  | VariableDeclarator
  | TSModuleDeclaration

/** A named declaration of a module or namespace scope. */
export interface Declaration {
  /** Absolute POSIX path of the declaring file. */
  readonly file: string
  /**
   * Name of the declaration within its file: the local name (`UserService`), a dotted path for
   * namespace members (`NS.Inner`), or `default` for an anonymous `export default class {}`.
   */
  readonly name: string
  /** Simple local name (last segment of {@link name}). */
  readonly localName: string
  readonly kind: DeclarationKind
  readonly node: DeclarationNode
  /** Span of the declared identifier (or of the declaration when anonymous). */
  readonly span: Span
  /** Declared with `declare` or located in a declaration file / ambient namespace. */
  readonly ambient: boolean
  /** `export default class {}` / `export default function () {}` without a name. */
  readonly anonymous: boolean
  /** Variable bound by a destructuring pattern (`const { a } = obj`): it has no own initializer. */
  readonly destructured: boolean
  /** Enclosing namespace declaration, for namespace members. */
  readonly namespace: Declaration | undefined
}

/** How an import binds its local name. `require` is `import x = require('m')`. */
export type ImportKind = 'named' | 'default' | 'namespace' | 'require'

/** One local binding created by an import statement. */
export interface ImportBinding {
  readonly local: string
  readonly kind: ImportKind
  /** Imported export name: the name for `named`, `default` for `default`, `*` otherwise. */
  readonly imported: string
  readonly specifier: string
  /** `import type { X }` / `import { type X }`. */
  readonly typeOnly: boolean
  /** Span of the local identifier. */
  readonly span: Span
  /** Span of the module specifier string literal (quotes included). */
  readonly specifierSpan: Span
}

/** A module specifier appearing in an import, re-export or `import x = require()` statement. */
export interface ModuleRequest {
  readonly specifier: string
  readonly span: Span
  readonly typeOnly: boolean
}

interface ExportBase {
  /** Name under which the binding is exported (`default` for default exports). */
  readonly exported: string
  readonly typeOnly: boolean
  /** Span of the exported name, or of the export statement when the name is implicit. */
  readonly span: Span
}

/** `export class X`, `export { a as b }`, `export default X` (X a local binding or import). */
export interface LocalExport extends ExportBase {
  readonly kind: 'local'
  /** Local binding name (a declaration or an import of the same scope). */
  readonly local: string
}

/** `export default <expression>` where the expression is not an identifier or named declaration. */
export interface ExpressionExport extends ExportBase {
  readonly kind: 'expression'
  readonly expression: Expression
}

/** `export { a as b } from 'm'`, `export { default } from 'm'`. */
export interface ReExport extends ExportBase {
  readonly kind: 'reexport'
  readonly imported: string
  readonly specifier: string
  readonly specifierSpan: Span
}

/** `export * as ns from 'm'`. */
export interface NamespaceReExport extends ExportBase {
  readonly kind: 'namespace'
  readonly specifier: string
  readonly specifierSpan: Span
}

/** An export of a module or namespace scope. */
export type ExportEntry = LocalExport | ExpressionExport | ReExport | NamespaceReExport

/** `export * from 'm'`. */
export interface StarExport {
  readonly specifier: string
  readonly specifierSpan: Span
  readonly typeOnly: boolean
  readonly span: Span
}

/** `export = expression` (CommonJS-style declaration files). */
export interface ExportAssignment {
  readonly expression: Expression
  readonly span: Span
}

/** Declarations and exports of a scope (a module or a namespace body). */
export interface ScopeFacts {
  /** Declarations by local name, in source order (several when merged: overloads, interfaces...). */
  readonly declarations: ReadonlyMap<string, readonly Declaration[]>
  /** Exports by exported name. When a name is exported twice (a TypeScript error) the first wins. */
  readonly exports: ReadonlyMap<string, ExportEntry>
  readonly starExports: readonly StarExport[]
}

/** Facts of a whole file. */
export interface FileFacts extends ScopeFacts {
  /** Import bindings by local name. */
  readonly imports: ReadonlyMap<string, ImportBinding>
  /** Every module specifier of imports, re-exports and `export *`, in source order. */
  readonly moduleRequests: readonly ModuleRequest[]
  readonly exportAssignment: ExportAssignment | undefined
  /** The file contains `import`/`export` statements (otherwise it is a script or CommonJS). */
  readonly hasModuleSyntax: boolean
}

/** Name of an `export { a as "b" }` / `import { "a" as b }` specifier. */
export function moduleExportName(node: ModuleExportName): string {
  return node.type === 'Literal' ? String(node.value) : node.name
}

interface ScopeContext {
  readonly file: string
  readonly prefix: string
  readonly ambient: boolean
  readonly namespace: Declaration | undefined
}

class ScopeCollector {
  readonly declarations = new Map<string, Declaration[]>()
  readonly exports = new Map<string, ExportEntry>()
  readonly starExports: StarExport[] = []
  readonly #context: ScopeContext

  constructor(context: ScopeContext) {
    this.#context = context
  }

  declare(
    localName: string,
    kind: DeclarationKind,
    node: DeclarationNode,
    span: Span,
    options: { ambient?: boolean; anonymous?: boolean; destructured?: boolean } = {},
  ): void {
    const context = this.#context
    const declaration: Declaration = {
      file: context.file,
      name: context.prefix + localName,
      localName,
      kind,
      node,
      span,
      ambient: context.ambient || options.ambient === true,
      anonymous: options.anonymous === true,
      destructured: options.destructured === true,
      namespace: context.namespace,
    }
    const existing = this.declarations.get(localName)
    if (existing) {
      existing.push(declaration)
    } else {
      this.declarations.set(localName, [declaration])
    }
  }

  export(entry: ExportEntry): void {
    if (!this.exports.has(entry.exported)) {
      this.exports.set(entry.exported, entry)
    }
  }

  /** Records the declarations of a declaration statement and returns the declared local names. */
  declaration(node: AstDeclaration): string[] {
    const ambient = 'declare' in node && node.declare === true
    switch (node.type) {
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) {
          this.declare(node.id.name, 'class', node, spanOf(node.id), { ambient })
          return [node.id.name]
        }
        return []
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'TSDeclareFunction':
      case 'TSEmptyBodyFunctionExpression':
        if (node.id) {
          this.declare(node.id.name, 'function', node, spanOf(node.id), { ambient })
          return [node.id.name]
        }
        return []
      case 'TSInterfaceDeclaration':
        this.declare(node.id.name, 'interface', node, spanOf(node.id), { ambient })
        return [node.id.name]
      case 'TSTypeAliasDeclaration':
        this.declare(node.id.name, 'type', node, spanOf(node.id), { ambient })
        return [node.id.name]
      case 'TSEnumDeclaration':
        this.declare(node.id.name, 'enum', node, spanOf(node.id), { ambient })
        return [node.id.name]
      case 'TSModuleDeclaration':
        // `declare module 'x' {}` (ambient external module) and `declare global {}` are not
        // declarations of this scope. Dotted namespaces (`namespace A.B {}`) are not supported.
        if (node.kind !== 'global' && node.id.type === 'Identifier') {
          this.declare(node.id.name, 'namespace', node, spanOf(node.id), { ambient })
          return [node.id.name]
        }
        return []
      case 'VariableDeclaration': {
        const kind: DeclarationKind = node.kind === 'let' || node.kind === 'var' ? node.kind : 'const'
        const names: string[] = []
        for (const declarator of node.declarations) {
          if (declarator.id.type === 'Identifier') {
            this.declare(declarator.id.name, kind, declarator, spanOf(declarator.id), { ambient })
            names.push(declarator.id.name)
          } else {
            for (const identifier of bindingIdentifiers(declarator.id)) {
              this.declare(identifier.name, kind, declarator, spanOf(identifier), { ambient, destructured: true })
              names.push(identifier.name)
            }
          }
        }
        return names
      }
      default:
        // `import x = NS.y` aliases are not tracked.
        return []
    }
  }

  /** Processes the statements of a scope that are common to modules and namespaces. */
  statement(statement: Statement | Directive, imports: ImportSink | undefined): void {
    switch (statement.type) {
      case 'ExportNamedDeclaration': {
        const typeOnly = statement.exportKind === 'type'
        if (statement.declaration) {
          const declarationTypeOnly =
            typeOnly ||
            statement.declaration.type === 'TSInterfaceDeclaration' ||
            statement.declaration.type === 'TSTypeAliasDeclaration'
          for (const name of this.declaration(statement.declaration)) {
            const declared = this.declarations.get(name)
            const last = declared?.[declared.length - 1]
            this.export({
              kind: 'local',
              exported: name,
              local: name,
              typeOnly: declarationTypeOnly,
              span: last ? last.span : spanOf(statement),
            })
          }
          return
        }
        if (statement.source) {
          const specifier = statement.source.value
          imports?.request(specifier, spanOf(statement.source), typeOnly)
          for (const specifierNode of statement.specifiers) {
            this.export({
              kind: 'reexport',
              exported: moduleExportName(specifierNode.exported),
              imported: moduleExportName(specifierNode.local),
              specifier,
              specifierSpan: spanOf(statement.source),
              typeOnly: typeOnly || specifierNode.exportKind === 'type',
              span: spanOf(specifierNode.exported),
            })
          }
          return
        }
        for (const specifierNode of statement.specifiers) {
          this.export({
            kind: 'local',
            exported: moduleExportName(specifierNode.exported),
            local: moduleExportName(specifierNode.local),
            typeOnly: typeOnly || specifierNode.exportKind === 'type',
            span: spanOf(specifierNode.exported),
          })
        }
        return
      }
      case 'ExportDefaultDeclaration': {
        const declaration = statement.declaration
        if (
          declaration.type === 'ClassDeclaration' ||
          declaration.type === 'FunctionDeclaration' ||
          declaration.type === 'TSDeclareFunction' ||
          declaration.type === 'TSInterfaceDeclaration'
        ) {
          const [name] = this.declaration(declaration)
          if (name !== undefined) {
            this.export({
              kind: 'local',
              exported: 'default',
              local: name,
              typeOnly: declaration.type === 'TSInterfaceDeclaration',
              span: spanOf(statement),
            })
            return
          }
          // Anonymous class or function: declared under the name `default`.
          const kind: DeclarationKind = declaration.type === 'ClassDeclaration' ? 'class' : 'function'
          this.declare('default', kind, declaration, spanOf(declaration), {
            anonymous: true,
            ambient: 'declare' in declaration && declaration.declare === true,
          })
          this.export({
            kind: 'local',
            exported: 'default',
            local: 'default',
            typeOnly: false,
            span: spanOf(statement),
          })
          return
        }
        if (declaration.type === 'Identifier') {
          this.export({
            kind: 'local',
            exported: 'default',
            local: declaration.name,
            typeOnly: false,
            span: spanOf(declaration),
          })
          return
        }
        this.export({
          kind: 'expression',
          exported: 'default',
          expression: declaration as Expression,
          typeOnly: false,
          span: spanOf(declaration),
        })
        return
      }
      case 'ExportAllDeclaration': {
        const specifier = statement.source.value
        const typeOnly = statement.exportKind === 'type'
        imports?.request(specifier, spanOf(statement.source), typeOnly)
        if (statement.exported) {
          this.export({
            kind: 'namespace',
            exported: moduleExportName(statement.exported),
            specifier,
            specifierSpan: spanOf(statement.source),
            typeOnly,
            span: spanOf(statement.exported),
          })
        } else {
          this.starExports.push({
            specifier,
            specifierSpan: spanOf(statement.source),
            typeOnly,
            span: spanOf(statement),
          })
        }
        return
      }
      case 'ClassDeclaration':
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
      case 'TSModuleDeclaration':
      case 'VariableDeclaration':
        this.declaration(statement)
        return
      default:
        return
    }
  }

  /** In ambient namespaces without explicit exports, every declaration is exported (TypeScript rule). */
  exportAllDeclarations(): void {
    for (const [name, declarations] of this.declarations) {
      const first = declarations[0]
      if (first) {
        this.export({
          kind: 'local',
          exported: name,
          local: name,
          typeOnly: declarations.every(d => d.kind === 'interface' || d.kind === 'type'),
          span: first.span,
        })
      }
    }
  }

  facts(): ScopeFacts {
    return { declarations: this.declarations, exports: this.exports, starExports: this.starExports }
  }
}

interface ImportSink {
  request(specifier: string, span: Span, typeOnly: boolean): void
}

/** Identifiers bound by a destructuring pattern. */
function bindingIdentifiers(pattern: BindingPattern): { name: string; start: number; end: number }[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern]
    case 'AssignmentPattern':
      return bindingIdentifiers(pattern.left)
    case 'ArrayPattern':
      return pattern.elements.flatMap(element => {
        if (element === null) {
          return []
        }
        return element.type === 'RestElement' ? bindingIdentifiers(element.argument) : bindingIdentifiers(element)
      })
    case 'ObjectPattern':
      return pattern.properties.flatMap(property =>
        property.type === 'RestElement' ? bindingIdentifiers(property.argument) : bindingIdentifiers(property.value),
      )
    default:
      return []
  }
}

/**
 * Extracts the facts of a parsed file.
 *
 * @param file absolute POSIX path (stored on declarations)
 * @param body top-level statements of the program
 * @param ambient `true` for declaration files: every declaration is ambient
 */
export function collectFileFacts(file: string, body: readonly (Statement | Directive)[], ambient: boolean): FileFacts {
  const collector = new ScopeCollector({ file, prefix: '', ambient, namespace: undefined })
  const imports = new Map<string, ImportBinding>()
  const moduleRequests: ModuleRequest[] = []
  let exportAssignment: ExportAssignment | undefined
  let hasModuleSyntax = false
  const sink: ImportSink = {
    request(specifier, span, typeOnly) {
      moduleRequests.push({ specifier, span, typeOnly })
    },
  }
  const addImport = (binding: ImportBinding): void => {
    if (!imports.has(binding.local)) {
      imports.set(binding.local, binding)
    }
  }

  for (const statement of body) {
    switch (statement.type) {
      case 'ImportDeclaration': {
        hasModuleSyntax = true
        const specifier = statement.source.value
        const specifierSpan = spanOf(statement.source)
        const statementTypeOnly = statement.importKind === 'type'
        sink.request(specifier, specifierSpan, statementTypeOnly)
        for (const node of statement.specifiers) {
          if (node.type === 'ImportSpecifier') {
            const imported = moduleExportName(node.imported)
            addImport({
              local: node.local.name,
              kind: imported === 'default' ? 'default' : 'named',
              imported,
              specifier,
              typeOnly: statementTypeOnly || node.importKind === 'type',
              span: spanOf(node.local),
              specifierSpan,
            })
          } else if (node.type === 'ImportDefaultSpecifier') {
            addImport({
              local: node.local.name,
              kind: 'default',
              imported: 'default',
              specifier,
              typeOnly: statementTypeOnly,
              span: spanOf(node.local),
              specifierSpan,
            })
          } else {
            addImport({
              local: node.local.name,
              kind: 'namespace',
              imported: '*',
              specifier,
              typeOnly: statementTypeOnly,
              span: spanOf(node.local),
              specifierSpan,
            })
          }
        }
        break
      }
      case 'TSImportEqualsDeclaration': {
        const reference = statement.moduleReference
        if (reference.type === 'TSExternalModuleReference') {
          hasModuleSyntax = true
          const specifier = reference.expression.value
          const specifierSpan = spanOf(reference.expression)
          sink.request(specifier, specifierSpan, statement.importKind === 'type')
          addImport({
            local: statement.id.name,
            kind: 'require',
            imported: '*',
            specifier,
            typeOnly: statement.importKind === 'type',
            span: spanOf(statement.id),
            specifierSpan,
          })
        }
        break
      }
      case 'TSExportAssignment':
        hasModuleSyntax = true
        exportAssignment = { expression: statement.expression, span: spanOf(statement) }
        break
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
        hasModuleSyntax = true
        collector.statement(statement, sink)
        break
      default:
        collector.statement(statement, sink)
    }
  }
  return { ...collector.facts(), imports, moduleRequests, exportAssignment, hasModuleSyntax }
}

const namespaceCache = new WeakMap<TSModuleDeclaration, ScopeFacts>()

/**
 * Members of a namespace declaration. In an ambient namespace without any explicit export, every
 * member is exported. Results are cached per AST node (hence per parse).
 */
export function namespaceFacts(declaration: Declaration): ScopeFacts {
  if (declaration.kind !== 'namespace') {
    return { declarations: new Map(), exports: new Map(), starExports: [] }
  }
  const node = declaration.node as TSModuleDeclaration
  const cached = namespaceCache.get(node)
  if (cached) {
    return cached
  }
  const collector = new ScopeCollector({
    file: declaration.file,
    prefix: `${declaration.name}.`,
    ambient: declaration.ambient,
    namespace: declaration,
  })
  const body = node.body
  let explicitExports = false
  if (body && body.type === 'TSModuleBlock') {
    for (const statement of body.body) {
      if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
        explicitExports = true
      }
      collector.statement(statement, undefined)
    }
  }
  if (declaration.ambient && !explicitExports) {
    collector.exportAllDeclarations()
  }
  const facts = collector.facts()
  namespaceCache.set(node, facts)
  return facts
}
