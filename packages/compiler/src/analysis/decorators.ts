/**
 * Decorator recognition (§4.6): a decorator is identified by the canonical identity of its callee,
 * so renamed imports, barrels, `export *` and namespace imports (`@zn.Injectable()`) all work.
 *
 * - {@link DecoratorCatalog}: the identities the compiler owns (core, extensions, manifest
 *   interceptor decorators) and their argument specifications;
 * - {@link DecoratorReader}: reads the decorators of a class / member / parameter, validates their
 *   target and call form, evaluates their arguments and warns about composite decorators.
 */
import type { Decorator, Expression, Function as FunctionNode, VariableDeclarator } from 'oxc-parser'
import type { CompilerExtension, DecoratorInfo, DecoratorSpec, DecoratorTarget } from '../extensions/api.ts'
import type {
  Declaration,
  InterceptorDeclaration,
  Location,
  Project,
  ScopeRef,
  SymbolResolution,
} from '../project/index.ts'
import type { Reporter } from './arguments.ts'
import type { ManifestIndex } from './manifests.ts'

import { ErrorCode } from '@znight/core'

import { declarationKey, displayNameOf, relativePath } from '../project/index.ts'
import { evaluateArguments, rawArgument } from './arguments.ts'
import { walk } from './ast.ts'
import {
  CORE_DECORATOR_SPECS,
  CORE_OWNER,
  INTERCEPTOR_DECORATOR_SPEC,
  MANIFEST_OWNER,
  TARGET_NAMES,
} from './core-decorators.ts'

/** A decorator owned by the compiler. */
export interface CatalogEntry {
  readonly identity: string
  /** `'core'`, `'manifest'` or an extension name. */
  readonly owner: string
  readonly spec: DecoratorSpec
  /** Manifest interceptor decorators: the interceptor they apply. */
  readonly interceptor: InterceptorDeclaration | undefined
}

/** Known decorator identities. */
export class DecoratorCatalog {
  readonly #entries = new Map<string, CatalogEntry>()
  readonly #manifests: ManifestIndex
  readonly #interceptors = new Map<string, CatalogEntry | null>()

  /**
   * @param extensions loaded extensions; a decorator claimed twice (or a core decorator claimed by
   *   an extension) is ZNIGHT018 and the first owner keeps it
   */
  constructor(manifests: ManifestIndex, extensions: readonly CompilerExtension[], report: Reporter) {
    this.#manifests = manifests
    for (const [identity, spec] of CORE_DECORATOR_SPECS) {
      this.#entries.set(identity, { identity, owner: CORE_OWNER, spec, interceptor: undefined })
    }
    for (const extension of extensions) {
      for (const identity of Object.keys(extension.decorators).sort()) {
        const spec = extension.decorators[identity] as DecoratorSpec
        const existing = this.#entries.get(identity)
        if (existing) {
          report({
            code: ErrorCode.VersionMismatch,
            severity: 'error',
            message: `Compiler extension '${extension.name}' declares the decorator ${identity}, already owned by ${existing.owner === CORE_OWNER ? '@znight/core' : `extension '${existing.owner}'`}`,
            hints: ['Two compiler extensions cannot own the same decorator: remove one of them'],
          })
          continue
        }
        this.#entries.set(identity, { identity, owner: extension.name, spec, interceptor: undefined })
      }
    }
  }

  /**
   * Entry of a decorator identity. Interceptor decorators are looked up in the manifest of the
   * package declaring them (`declaringFile`).
   */
  get(identity: string, declaringFile: string | undefined): CatalogEntry | undefined {
    const entry = this.#entries.get(identity)
    if (entry) {
      return entry
    }
    let cached = this.#interceptors.get(identity)
    if (cached === undefined) {
      const interceptor = identity.startsWith('globalThis#')
        ? undefined
        : this.#manifests.interceptorOf(identity, declaringFile)
      cached = interceptor ? { identity, owner: MANIFEST_OWNER, spec: INTERCEPTOR_DECORATOR_SPEC, interceptor } : null
      this.#interceptors.set(identity, cached)
    }
    return cached ?? undefined
  }

  /** `true` for identities owned by the compiler or exported by a `@znight/*` package. */
  isZnight(identity: string): boolean {
    return this.#entries.has(identity) || this.#interceptors.get(identity) != null || identity.startsWith('@znight/')
  }
}

/** Reads decorators: identity, call form, target, arguments. */
export class DecoratorReader {
  readonly #project: Project
  readonly #catalog: DecoratorCatalog
  readonly #report: Reporter
  /** Composite / alias decorator detection, per declaration key: the wrapped Znight decorator, or `null`. */
  readonly #composites = new Map<string, WrappedDecorator | null>()

  constructor(project: Project, catalog: DecoratorCatalog, report: Reporter) {
    this.#project = project
    this.#catalog = catalog
    this.#report = report
  }

  get catalog(): DecoratorCatalog {
    return this.#catalog
  }

  /** Reads the decorators of a node (in source order). */
  read(scope: ScopeRef, decorators: readonly Decorator[] | undefined, target: DecoratorTarget): DecoratorInfo[] {
    if (!decorators || decorators.length === 0) {
      return []
    }
    return decorators.map(decorator => this.#read(scope, decorator, target))
  }

  #read(scope: ScopeRef, decorator: Decorator, target: DecoratorTarget): DecoratorInfo {
    const file = scope.file
    const location = file.location(decorator)
    const expression = decorator.expression
    const called = expression.type === 'CallExpression'
    const callee = called ? expression.callee : expression
    const resolved = isEntityName(callee)
      ? this.#project.resolveIdentifier(scope, callee, 'value')
      : { symbol: undefined, identity: undefined }
    const identity = resolved.identity?.identity
    const declaringFile = resolved.symbol?.kind === 'declaration' ? resolved.symbol.declaration.file : undefined
    const entry = identity === undefined ? undefined : this.#catalog.get(identity, declaringFile)
    const name = identity === undefined ? file.textOf(callee) : displayNameOf(identity)

    if (!entry) {
      if (resolved.symbol) {
        this.#checkComposite(resolved.symbol, name, location)
      }
      return {
        identity,
        name,
        owner: undefined,
        args: called ? expression.arguments.map(argument => rawArgument(scope, argument)) : [],
        called,
        target,
        location,
        node: decorator,
      }
    }

    if (!called) {
      this.#report({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message: `@${name} must be called: @${name}()`,
        location,
        hints: [`Write @${name}(${entry.spec.params.length > 0 ? '...' : ''})`],
      })
    }
    if (!entry.spec.targets.includes(target)) {
      this.#report({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message: `@${name} cannot be applied to ${TARGET_NAMES[target]} (allowed on ${entry.spec.targets.map(allowed => TARGET_NAMES[allowed]).join(', ')})`,
        location,
      })
    }
    const args = called
      ? evaluateArguments(this.#project, scope, expression.arguments, entry.spec, name, this.#report)
      : []
    return { identity, name, owner: entry.owner, args, called, target, location, node: decorator }
  }

  /**
   * ZNIGHT005 warning for a decorator the compiler cannot see through (§4.6): a local function whose
   * body calls a Znight decorator (composite decorator), or a `const` alias of one
   * (`export const Service = Injectable`): the class it decorates is silently not analysed otherwise.
   */
  #checkComposite(symbol: SymbolResolution, name: string, location: Location): void {
    if (symbol.kind !== 'declaration') {
      return
    }
    const declaration = symbol.declaration
    const inner = this.#wrapped(declaration, 0)
    if (inner === undefined) {
      return
    }
    const file = this.#project.getFile(declaration.file)
    this.#report({
      code: ErrorCode.InvalidDecorator,
      severity: 'warning',
      message: inner.alias
        ? `@${name} is an alias of the Znight decorator @${inner.name}: aliases are not visible to the compiler, the decorator is ignored`
        : `@${name} is a composite decorator: the Znight decorator @${inner.name} it applies is not visible to the compiler`,
      location,
      hints: inner.alias
        ? [
            `Apply @${inner.name}(...) directly, or re-export it under another name: \`export { ${inner.name} as ${name} } from '${inner.module}'\``,
          ]
        : [`Apply @${inner.name}(...) directly instead of through @${name}`],
      ...(file
        ? {
            related: [
              {
                message: `${name} is declared in ${relativePath(this.#project.root, declaration.file)}`,
                location: file.location(declaration.span),
              },
            ],
          }
        : {}),
    })
  }

  /**
   * The Znight decorator a declaration wraps: a `const` aliasing it (followed through other `const`
   * aliases, any file), or a function of a scanned file whose body calls it. Memoized per declaration.
   */
  #wrapped(declaration: Declaration, depth: number): WrappedDecorator | undefined {
    const key = declarationKey(declaration)
    let wrapped = this.#composites.get(key)
    if (wrapped === undefined) {
      wrapped =
        this.#aliased(declaration, depth) ??
        (this.#project.isScanned(declaration.file) ? this.#innerDecorator(declaration) : undefined) ??
        null
      this.#composites.set(key, wrapped)
    }
    return wrapped ?? undefined
  }

  /** `const Service = Injectable` (or `zn.Injectable`, `Injectable as typeof Injectable`...). */
  #aliased(declaration: Declaration, depth: number): WrappedDecorator | undefined {
    if (declaration.kind !== 'const' || depth > MAX_ALIAS_DEPTH) {
      return undefined
    }
    const init = unwrapExpression((declaration.node as VariableDeclarator).init ?? undefined)
    const file = this.#project.getFile(declaration.file)
    if (init === undefined || !isEntityName(init) || !file) {
      return undefined
    }
    const resolved = this.#project.resolveIdentifier({ file, namespace: declaration.namespace }, init, 'value')
    const identity = resolved.identity?.identity
    if (identity !== undefined && this.#catalog.isZnight(identity)) {
      return { name: displayNameOf(identity), alias: true, module: resolved.identity?.specifier ?? '...' }
    }
    if (
      resolved.symbol.kind === 'declaration' &&
      declarationKey(resolved.symbol.declaration) !== declarationKey(declaration)
    ) {
      // `const B = A` with `A` an alias or a composite decorator: `B` is the same
      return this.#wrapped(resolved.symbol.declaration, depth + 1)
    }
    return undefined
  }

  #innerDecorator(declaration: Declaration): WrappedDecorator | undefined {
    const body = functionBody(declaration)
    const file = this.#project.getFile(declaration.file)
    if (!body || !file) {
      return undefined
    }
    const scope: ScopeRef = { file, namespace: declaration.namespace }
    let found: string | undefined
    walk(body, node => {
      if (found !== undefined) {
        return false
      }
      if (node.type === 'CallExpression' && isEntityName(node.callee)) {
        const identity = this.#project.resolveIdentifier(scope, node.callee, 'value').identity?.identity
        if (identity !== undefined && this.#catalog.isZnight(identity)) {
          found = displayNameOf(identity)
          return false
        }
      }
      return true
    })
    return found === undefined ? undefined : { name: found, alias: false, module: '' }
  }
}

/** A Znight decorator applied through another declaration. */
interface WrappedDecorator {
  /** Display name of the Znight decorator (`Injectable`). */
  readonly name: string
  /** `const Service = Injectable` (alias) rather than a function calling it (composite). */
  readonly alias: boolean
  /** Aliases: the module exporting the Znight decorator (`@znight/core`), for the re-export hint. */
  readonly module: string
}

/** Maximum chain of `const` aliases followed (`const A = Injectable; const B = A`). */
const MAX_ALIAS_DEPTH = 8

/** Strips parentheses and type-only wrappers (`(x)`, `x as T`, `x satisfies T`, `x!`, `<T>x`). */
function unwrapExpression(expression: Expression | undefined): Expression | undefined {
  let current = expression
  while (
    current &&
    (current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression
  }
  return current
}

/** Body of a function declaration or of a `const` initialized with a function. */
function functionBody(declaration: Declaration): FunctionNode['body'] | Expression | undefined {
  if (declaration.kind === 'function') {
    return (declaration.node as FunctionNode).body ?? undefined
  }
  if (declaration.kind === 'const' || declaration.kind === 'let' || declaration.kind === 'var') {
    const init = (declaration.node as VariableDeclarator).init
    if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
      return init.body ?? undefined
    }
  }
  return undefined
}

/** Identifier or non-computed member chain (`Injectable`, `zn.Injectable`). */
export function isEntityName(expression: Expression): boolean {
  if (expression.type === 'Identifier') {
    return true
  }
  if (expression.type === 'MemberExpression' && !expression.computed && expression.property.type === 'Identifier') {
    return isEntityName(expression.object)
  }
  return false
}
