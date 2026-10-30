/**
 * The module being generated: imports (resolved through import routes, §4.2), module-level
 * constants and the printer turning {@link GenNode} trees into {@link Doc}s.
 *
 * Nodes are validated as they are printed: only nodes created by the builders are accepted (a
 * forged object is an "invalid node" error attributed to the extension that returned it).
 */
import type { GenConstant, GenImport, GenNode } from '../extensions/generate.ts'
import type { Diagnostic, ImportRoute, ImportRouteResult, Project, ValueRef } from '../project/index.ts'
import type { Doc } from './doc.ts'

import { ErrorCode } from '@znight/core'

import { isBuiltNode } from '../extensions/generate.ts'
import { isBareSpecifier } from '../project/index.ts'
import { group, hardline, indent, join, line, list, render } from './doc.ts'
import { NamePool, ROOT_CONTEXT } from './imports.ts'
import { literalDoc } from './literal.ts'
import { isIdentifierName, quote, toIdentifier } from './syntax.ts'

/** Who produced a node: the core generator or a compiler extension (named in diagnostics). */
export interface Owner {
  /** Extension name, `undefined` for the core generator. */
  readonly extension: string | undefined
  /** `section of extension 'http'`, `factory of UserService`... */
  readonly activity: string
}

/** The core generator itself. */
export const CORE_OWNER: Owner = Object.freeze({ extension: undefined, activity: 'container metadata' })

/** A node the printer cannot print (forged object, malformed node). The message starts with a verb. */
export class InvalidNodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidNodeError'
  }
}

interface ConstantDeclaration {
  readonly context: string
  readonly name: Doc
  readonly type: Doc | undefined
  readonly value: Doc
}

/** State of one generated module. */
export class ModuleBuilder {
  readonly names: NamePool = new NamePool()
  readonly #project: Project
  readonly #report: (diagnostic: Diagnostic) => void
  readonly #constants = new Map<number, Doc>()
  readonly #constantKeys = new Map<string, GenConstant>()
  readonly #declarations: ConstantDeclaration[] = []
  readonly #routes = new Map<string, ImportRouteResult>()
  /** Context → constant contexts it references (reachability of constants and imports). */
  readonly #references = new Map<string, Set<string>>()
  #context: string = ROOT_CONTEXT
  #nextConstant = 1

  constructor(project: Project, report: (diagnostic: Diagnostic) => void) {
    this.#project = project
    this.#report = report
  }

  get project(): Project {
    return this.#project
  }

  // ----------------------------------------------------------------- imports

  /** Doc importing an entity by import route (`UserService`, `tokens.Holder`). */
  routeDoc(route: ImportRoute, options: { readonly typeOnly: boolean; readonly sortKey: string }): Doc {
    const hint = route.exportName === 'default' ? defaultHint(route, options.sortKey) : route.exportName
    const local = this.names.import(
      {
        specifier: route.specifier,
        exportName: route.exportName,
        typeOnly: options.typeOnly,
        sortKey: options.sortKey,
        hint,
      },
      this.#context,
    )
    return route.members.length === 0 ? local : [local, ...route.members.map(memberAccess)]
  }

  /**
   * Doc of a {@link GenImport} node. Route failures are reported (ZNIGHT005) with the owner and print
   * `undefined` (the module is not emitted when there are errors).
   */
  importDoc(node: GenImport, owner: Owner): Doc {
    const target = node.target
    switch (target.kind) {
      case 'ref':
        return this.refDoc(target.ref, owner, node.typeOnly)
      case 'identity': {
        const route = this.#route(`identity:${target.identity}`, () => this.#project.importRoute(target.identity))
        return this.#routed(route, target.identity, target.identity, owner, node.typeOnly)
      }
      case 'module': {
        const key = `module:${target.module}#${target.name}`
        const route = this.#route(key, () => this.#moduleRoute(target.module, target.name))
        return this.#routed(route, `${target.module}#${target.name}`, `'${target.name}'`, owner, node.typeOnly)
      }
    }
  }

  /** Doc importing a {@link ValueRef} (decorator argument references, interceptor options). */
  refDoc(ref: ValueRef, owner: Owner, typeOnly = false): Doc {
    const key = `ref:${ref.identity ?? ref.text}:${ref.location.file}:${ref.location.start}`
    const route = this.#route(key, () => this.#project.importRoute(ref.symbol))
    const sortKey = ref.identity ?? (route.ok ? `${route.route.specifier}#${route.route.exportName}` : ref.text)
    return this.#routed(route, sortKey, `'${ref.text}'`, owner, typeOnly)
  }

  #routed(route: ImportRouteResult, sortKey: string, what: string, owner: Owner, typeOnly: boolean): Doc {
    if (!route.ok) {
      this.#report({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message: `${describeOwner(owner)} cannot import ${what} in the generated module: ${route.error.message}`,
        ...(route.error.hints.length > 0 ? { hints: route.error.hints } : {}),
      })
      return 'undefined'
    }
    if (route.route.typeOnly && !typeOnly) {
      this.#report({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message: `${describeOwner(owner)} uses ${what} as a value, but it only exists as a type`,
        hints: ['Use importType() for types, or reference a class/value'],
      })
      return 'undefined'
    }
    return this.routeDoc(route.route, { typeOnly, sortKey })
  }

  #route(key: string, compute: () => ImportRouteResult): ImportRouteResult {
    let route = this.#routes.get(key)
    if (!route) {
      route = compute()
      this.#routes.set(key, route)
    }
    return route
  }

  #moduleRoute(module: string, name: string): ImportRouteResult {
    if (!isBareSpecifier(module)) {
      return {
        ok: false,
        error: {
          reason: 'unresolved',
          message: `'${module}' is not a package specifier (importFrom() only imports package exports)`,
          hints: [],
        },
      }
    }
    const resolution = this.#project.resolveModule(this.#project.options.outFile, module, undefined, 'runtime')
    if (resolution.kind === 'not-found') {
      return {
        ok: false,
        error: {
          reason: 'runtime-unresolvable',
          message: `'${module}' cannot be resolved from the generated module with the runtime conditions`,
          hints: [`Add '${module}' to the dependencies of the application`],
        },
      }
    }
    return { ok: true, route: { specifier: module, exportName: name, members: [], typeOnly: false } }
  }

  // --------------------------------------------------------------- constants

  /** Declares a module-level constant (same `key` → same reference). */
  constant(
    key: string,
    hint: string,
    build: (node: GenConstant) => { value: Doc; type: Doc | undefined },
  ): GenConstant {
    const existing = this.#constantKeys.get(key)
    if (existing) {
      return existing
    }
    const node: GenConstant = { kind: 'gen:constant', name: hint, id: this.#nextConstant++ }
    this.#constantKeys.set(key, node)
    const context = constantContext(node.id)
    const name = this.names.constant(hint, context)
    this.#constants.set(node.id, name)
    const previous = this.#context
    this.#context = context
    try {
      const { value, type } = build(node)
      this.#declarations.push({ context, name, type, value })
    } finally {
      this.#context = previous
    }
    return node
  }

  /** `const` declarations reachable from the metadata object, in registration order. */
  constantDeclarations(): Doc[] {
    return this.#declarations
      .filter(declaration => this.names.isEmitted(declaration.context))
      .map(declaration => [
        'const ',
        declaration.name,
        declaration.type === undefined ? '' : [': ', declaration.type],
        ' = ',
        declaration.value,
      ])
  }

  /** Contexts reachable from the root (constants referenced, directly or not, by the metadata). */
  #reachableContexts(): Set<string> {
    const reachable = new Set<string>([ROOT_CONTEXT])
    const pending = [ROOT_CONTEXT]
    while (pending.length > 0) {
      const context = pending.pop() as string
      for (const target of this.#references.get(context) ?? []) {
        if (!reachable.has(target)) {
          reachable.add(target)
          pending.push(target)
        }
      }
    }
    return reachable
  }

  // ---------------------------------------------------------------- printing

  /** Prints a node tree. */
  print(node: GenNode, owner: Owner): Doc {
    if (!isBuiltNode(node)) {
      throw new InvalidNodeError(
        `produced an invalid node (${describeForged(node)}): nodes must be created with the GenerateContext builders`,
      )
    }
    switch (node.kind) {
      case 'gen:literal':
        return literalDoc(node.value, ref => this.refDoc(ref, owner))
      case 'gen:object':
        return list(
          '{',
          '}',
          node.entries.map(([key, value]) => [`[${quote(key)}]: `, this.print(value, owner)]),
          { spaced: true },
        )
      case 'gen:array':
        return list(
          '[',
          ']',
          node.items.map(item => this.print(item, owner)),
        )
      case 'gen:import':
        return this.importDoc(node, owner)
      case 'gen:param':
        return node.name
      case 'gen:constant': {
        const name = this.#constants.get(node.id)
        let references = this.#references.get(this.#context)
        if (!references) {
          references = new Set()
          this.#references.set(this.#context, references)
        }
        references.add(constantContext(node.id))
        if (name === undefined) {
          throw new InvalidNodeError('used a constant declared for another generated module')
        }
        return name
      }
      case 'gen:member':
        return [this.#operand(node.object, owner), memberAccess(node.property)]
      case 'gen:call': {
        const args = list(
          '(',
          ')',
          node.args.map(arg => this.print(arg, owner)),
        )
        if (node.new) {
          const callee = isReference(node.callee)
            ? this.print(node.callee, owner)
            : ['(', this.print(node.callee, owner), ')']
          return ['new ', callee, args]
        }
        return [this.#operand(node.callee, owner), args]
      }
      case 'gen:arrow': {
        for (const param of node.params) {
          this.names.reserve(param.name)
        }
        const prefix = node.async ? 'async ' : ''
        const single = node.params.length === 1 ? node.params[0] : undefined
        const params: Doc =
          single && single.type === undefined
            ? single.name
            : [
                '(',
                join(
                  ', ',
                  node.params.map(param =>
                    param.type === undefined ? param.name : [param.name, ': ', this.print(param.type, owner)],
                  ),
                ),
                ')',
              ]
        return [prefix, params, arrowBody(this.print(node.body, owner), bodyKind(node.body))]
      }
      case 'gen:block': {
        for (const local of node.locals) {
          this.names.reserve(local)
        }
        if (node.statements.length === 0) {
          return '{}'
        }
        const statements = node.statements.map(statement => this.print(statement, owner))
        return ['{', indent([hardline, join(hardline, statements)]), hardline, '}']
      }
      case 'gen:code': {
        const parts: Doc[] = []
        node.parts.forEach((part, index) => {
          parts.push(part)
          const value = node.values[index]
          if (value !== undefined) {
            parts.push(this.print(value, owner))
          }
        })
        return parts
      }
      default:
        throw new InvalidNodeError('produced a node of an unknown kind')
    }
  }

  /** Printed object of a member access or a call: parenthesized unless it is a simple reference or call. */
  #operand(node: GenNode, owner: Owner): Doc {
    const printed = this.print(node, owner)
    if (isReference(node) || (isBuiltNode(node) && node.kind === 'gen:call')) {
      return printed
    }
    if (isBuiltNode(node) && node.kind === 'gen:literal' && typeof node.value === 'string') {
      return printed
    }
    return ['(', printed, ')']
  }

  // ------------------------------------------------------------------ module

  /** Renders the complete module: header, imports, constants, then `body`. */
  render(
    header: readonly string[],
    body: Doc,
  ): { readonly text: string; readonly marks: ReturnType<typeof render>['marks'] } {
    this.names.finalize(this.#reachableContexts())
    const statements = this.names.statements()
    const parts: Doc[] = []
    for (const comment of header) {
      parts.push(comment, hardline)
    }
    for (const statement of statements) {
      parts.push(statement, hardline)
    }
    const constants = this.constantDeclarations()
    if (constants.length > 0) {
      parts.push(hardline, join(hardline, constants), hardline)
    }
    parts.push(hardline, body, hardline)
    return render(parts)
  }
}

/**
 * ` => body`: an object body is parenthesized and stays on the arrow line, so does a block body
 * (`code` starting with `{`); another body moves to the next line (indented) when it does not fit.
 */
export function arrowBody(body: Doc, kind: 'object' | 'block' | 'expression'): Doc {
  switch (kind) {
    case 'object':
      return [' => (', body, ')']
    case 'block':
      return [' => ', body]
    default:
      return [' =>', group(indent([line, body]))]
  }
}

/** How an arrow body is printed: object literals are parenthesized, blocks stay on the line. */
export function bodyKind(node: GenNode): 'object' | 'block' | 'expression' {
  if (isObjectBody(node)) {
    return 'object'
  }
  if (node.kind === 'gen:block') {
    return 'block'
  }
  return node.kind === 'gen:code' && (node.parts[0] ?? '').trimStart().startsWith('{') ? 'block' : 'expression'
}

function constantContext(id: number): string {
  return `const:${id}`
}

/** `.name` or `['name']`. */
export function memberAccess(name: string): string {
  return isIdentifierName(name) ? `.${name}` : `[${quote(name)}]`
}

/** An identifier-like expression (import, parameter, constant and member chains of them). */
function isReference(node: GenNode): boolean {
  if (!isBuiltNode(node)) {
    return false
  }
  switch (node.kind) {
    case 'gen:import':
    case 'gen:param':
    case 'gen:constant':
      return true
    case 'gen:member':
      return isReference(node.object)
    default:
      return false
  }
}

function isObjectBody(node: GenNode): boolean {
  if (node.kind === 'gen:object') {
    return true
  }
  if (node.kind === 'gen:literal') {
    const value = node.value
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof RegExp)
  }
  return false
}

/** `extension 'http'` / `the code generator`. */
export function describeOwner(owner: Owner): string {
  return owner.extension === undefined
    ? `The code generator (${owner.activity})`
    : `Compiler extension '${owner.extension}' (${owner.activity})`
}

function describeForged(node: unknown): string {
  if (typeof node !== 'object' || node === null) {
    return `got ${node === null ? 'null' : typeof node}`
  }
  const kind = (node as { kind?: unknown }).kind
  return typeof kind === 'string' ? `a forged '${kind}' object` : 'a plain object'
}

/** Preferred local name of a default import. */
function defaultHint(route: ImportRoute, sortKey: string): string {
  const hash = sortKey.lastIndexOf('#')
  if (hash !== -1 && route.members.length === 0) {
    const name = sortKey.slice(hash + 1)
    if (name !== 'default' && name !== '' && !name.includes('.')) {
      return name
    }
  }
  const segments = route.specifier.split('/').filter(segment => segment !== '' && segment !== '.' && segment !== '..')
  const last = (segments[segments.length - 1] ?? 'module').replace(/\.[cm]?[jt]sx?$/, '')
  return toIdentifier(last.startsWith('@') ? last.slice(1) : last)
}
