/**
 * Code generation nodes (§6.5) and the generation context contract.
 *
 * Extensions never produce source text: they return a tree of {@link GenNode}s built with the
 * builders of {@link GenerateContext}. The code generator prints the tree with the single literal
 * emitter of §3.3 and owns every import of the generated module (identifiers are de-duplicated by
 * identity order), so an extension cannot break the module syntax.
 *
 * The node constructors ({@link createGenBuilders}) are pure and implemented here; the import
 * functions (`importValue`, `importType`, `importFrom`) and `tokenOf` need the module being generated
 * and are provided by the code generator.
 */
import type { DependencyRef, Token } from '@znight/core'
import type { LiteralValue } from '../codegen/literal.ts'
import type { ApplicationGraph, ProviderNode } from '../graph/types.ts'
import type { ResolvedOptions } from '../options.ts'
import type { Diagnostic, StaticPrimitive, ValueRef } from '../project/index.ts'
import type { ArgInfo, BindingHandle, ClassInfo, ClassRef, TypeHelpers } from './api.ts'

import { isSafeIdentifier } from '../codegen/syntax.ts'
import { ValueRef as ValueRefClass } from '../project/static-value.ts'

export type { LiteralValue } from '../codegen/literal.ts'

export { isSafeIdentifier } from '../codegen/syntax.ts'

/**
 * A literal value (primitives, plain objects and arrays, `RegExp`, `Date`). Nested
 * {@link ValueRef}s are imported by the emitter.
 */
export interface GenLiteral {
  readonly kind: 'gen:literal'
  readonly value: LiteralValue
}

/** `{ ["key"]: value, ... }` (keys are always emitted as computed string keys). */
export interface GenObject {
  readonly kind: 'gen:object'
  readonly entries: readonly (readonly [string, GenNode])[]
}

/** `[a, b, ...]`. */
export interface GenArray {
  readonly kind: 'gen:array'
  readonly items: readonly GenNode[]
}

/**
 * A binding of another module, imported by the generated module. Produced by `importValue`,
 * `importType`, `importFrom` (and {@link GenBuilders.ref} for {@link ValueRef}s).
 */
export interface GenImport {
  readonly kind: 'gen:import'
  /** What to import: a value reference, a canonical identity, or an explicit module export. */
  readonly target:
    | { readonly kind: 'ref'; readonly ref: ValueRef }
    | { readonly kind: 'identity'; readonly identity: string }
    | { readonly kind: 'module'; readonly module: string; readonly name: string }
  /** Imported with `import type` and usable in type positions only. */
  readonly typeOnly: boolean
}

/** A parameter of the enclosing {@link GenArrow}. */
export interface GenParam {
  readonly kind: 'gen:param'
  readonly name: string
}

/** `object.property` (or `object["property"]` when not an identifier). */
export interface GenMember {
  readonly kind: 'gen:member'
  readonly object: GenNode
  readonly property: string
}

/** `callee(args)` or `new callee(args)`. */
export interface GenCall {
  readonly kind: 'gen:call'
  readonly callee: GenNode
  readonly args: readonly GenNode[]
  readonly new: boolean
}

/** `(params) => body`. Parameters may carry a type node (`(c: UserController, ctx: HttpContext) => ...`). */
export interface GenArrow {
  readonly kind: 'gen:arrow'
  readonly params: readonly { readonly name: string; readonly type: GenNode | undefined }[]
  readonly body: GenNode
  readonly async: boolean
}

/**
 * A block, as the body of a {@link GenArrow}: `{` then one statement per line, then `}`. `locals` are
 * the names of the bindings its statements declare: they are reserved like arrow parameters (an
 * import or a constant never takes one of these names).
 */
export interface GenBlock {
  readonly kind: 'gen:block'
  readonly locals: readonly string[]
  readonly statements: readonly GenNode[]
}

/**
 * Code from a tagged template: `parts` come from the template literal written by the extension
 * author (never from user input), every interpolation is a node (strings become string literals).
 */
export interface GenCode {
  readonly kind: 'gen:code'
  readonly parts: readonly string[]
  readonly values: readonly GenNode[]
}

/**
 * A reference to a module-level `const` declared with {@link GenerateContext.constant} (printed
 * before `__ZNIGHT_METADATA__`).
 */
export interface GenConstant {
  readonly kind: 'gen:constant'
  /** Preferred identifier (the printed name may get a `$1` suffix). */
  readonly name: string
  /** Unique id in the module being generated. */
  readonly id: number
}

/** A node of generated code. */
export type GenNode =
  | GenLiteral
  | GenObject
  | GenArray
  | GenImport
  | GenParam
  | GenMember
  | GenCall
  | GenArrow
  | GenBlock
  | GenCode
  | GenConstant

/** What builders accept where a node is expected: primitives are wrapped with `lit`. */
export type GenInput = GenNode | StaticPrimitive

/** Pure node constructors. */
export interface GenBuilders {
  /**
   * A literal (objects/arrays, `RegExp` and `Date` allowed). Nested {@link ValueRef}s are imported.
   * Functions, symbols, cycles and other objects are rejected.
   */
  lit(value: LiteralValue): GenNode
  /** Object literal; entries keep their order. */
  obj(entries: Readonly<Record<string, GenInput>> | readonly (readonly [string, GenInput])[]): GenNode
  arr(items: readonly GenInput[]): GenNode
  /** Reference to an exported binding found in a decorator argument (imported by the generated module). */
  ref(value: ValueRef | ArgInfo): GenNode
  /** `object.a.b`. */
  member(object: GenNode, ...path: readonly string[]): GenNode
  call(callee: GenNode, args?: readonly GenInput[]): GenNode
  /** `new callee(args)`. */
  construct(callee: GenNode, args?: readonly GenInput[]): GenNode
  /**
   * Arrow function. `params` are identifiers (optionally typed: `[['c', ctx.importType(cls)]]`);
   * `body` receives one {@link GenParam} per parameter.
   */
  arrow(
    params: readonly (string | readonly [string, GenNode | undefined])[],
    body: (...params: GenParam[]) => GenInput,
    options?: { readonly async?: boolean },
  ): GenNode
  /**
   * A block body for {@link arrow}, printed one statement per line. `locals` are the identifiers of
   * the `const`s the statements declare (reserved like arrow parameters, so that no import or
   * constant takes their name); `statements` receives one {@link GenParam} per local:
   * `block(['a'], a => [code`const ${a} = ${value}`, code`return ${a}`])`.
   */
  block(locals: readonly string[], statements: (...locals: GenParam[]) => readonly GenInput[]): GenNode
  /** Tagged template: ``code`${a} ?? ${b}` ``. Interpolations are escaped (strings become literals). */
  code(strings: TemplateStringsArray, ...values: readonly GenInput[]): GenNode
}

/**
 * Context of `CompilerExtension.generate` (implemented by the code generator).
 *
 * Contract:
 * - every node returned must come from these builders;
 * - `importValue` / `importType` accept a {@link ValueRef}, an {@link ArgInfo} holding a reference,
 *   a {@link ClassInfo}, a {@link ClassRef} or a canonical identity, and import it through its
 *   import route (§4.2) — a failure is reported as ZNIGHT005 naming the extension;
 * - `importFrom(module, name)` imports an export of a package (helpers such as `coerce`): the
 *   module must be a bare specifier;
 * - `tokenOf` returns the provider token of a class or identity (aliases resolved), `undefined`
 *   when it is not bound to a provider or an external.
 */
export interface GenerateContext<TData = unknown> extends GenBuilders {
  readonly extension: string
  readonly options: ResolvedOptions
  readonly types: TypeHelpers
  readonly graph: ApplicationGraph
  /** Data stored by the extension during analysis, in call order. */
  readonly stored: readonly TData[]
  binding(handle: BindingHandle): DependencyRef | undefined
  /** The provider with this token (`undefined` when there is none, e.g. pruned). */
  provider(token: Token): ProviderNode | undefined
  importValue(target: ValueRef | ArgInfo | ClassInfo | ClassRef | string): GenNode
  importType(target: ValueRef | ArgInfo | ClassInfo | ClassRef | string): GenNode
  importFrom(module: string, name: string, options?: { readonly type?: boolean }): GenNode
  tokenOf(target: ClassInfo | ClassRef | string): Token | undefined
  /**
   * Declares a module-level `const` printed before `__ZNIGHT_METADATA__` and returns a reference to
   * it: `const <name>: <type> = <value>`. Use it for values referenced several times (a provider
   * factory and the extension section). `name` must be an identifier; it is de-duplicated against
   * the other bindings of the module (`DatabaseConfig$fields`, `DatabaseConfig$fields$1`).
   * Declaring the same `name` again returns the same reference (the first value wins).
   */
  constant(name: string, value: GenInput, options?: { readonly type?: GenNode }): GenNode
  report(diagnostic: Diagnostic): void
}

/** Nodes created by builders (forged objects are rejected by the code generator). */
const BUILT = new WeakSet<object>()

/** `true` for a node created by the builders (or a generation context), never for a forged object. */
export function isBuiltNode(value: unknown): value is GenNode {
  return typeof value === 'object' && value !== null && BUILT.has(value)
}

/** `true` for any object produced by the builders. */
export function isGenNode(value: unknown): value is GenNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    (value as { kind: string }).kind.startsWith('gen:')
  )
}

/** Creates the pure node constructors shared by every generation context. */
export function createGenBuilders(): GenBuilders {
  const input = (value: GenInput): GenNode => {
    if (isGenNode(value)) {
      return value
    }
    if (typeof value === 'object' && value !== null) {
      throw new TypeError('[znight] code builders only accept nodes and primitives')
    }
    return lit(value)
  }
  const lit = (value: LiteralValue): GenNode => {
    checkLiteral(value, new Set())
    return freeze({ kind: 'gen:literal', value })
  }
  const call = (callee: GenNode, args: readonly GenInput[] = [], isNew = false): GenNode =>
    freeze({ kind: 'gen:call', callee: input(callee), args: Object.freeze(args.map(input)), new: isNew })
  return {
    lit,
    obj(entries) {
      const list = Array.isArray(entries)
        ? (entries as readonly (readonly [string, GenInput])[])
        : Object.entries(entries as Readonly<Record<string, GenInput>>)
      const seen = new Set<string>()
      const normalized = list.map(([key, value]): readonly [string, GenNode] => {
        if (typeof key !== 'string') {
          throw new TypeError('[znight] object keys must be strings')
        }
        if (seen.has(key)) {
          throw new TypeError(`[znight] duplicate object key ${JSON.stringify(key)}`)
        }
        seen.add(key)
        return Object.freeze([key, input(value)] as const)
      })
      return freeze({ kind: 'gen:object', entries: Object.freeze(normalized) })
    },
    arr(items) {
      return freeze({ kind: 'gen:array', items: Object.freeze(items.map(input)) })
    },
    ref(value) {
      const ref = value instanceof ValueRefClass ? value : value.ref
      if (!ref) {
        throw new TypeError(`[znight] '${(value as ArgInfo).text}' is not a reference to an exported binding`)
      }
      return freeze({ kind: 'gen:import', target: { kind: 'ref', ref }, typeOnly: false })
    },
    member(object, ...path) {
      let node = input(object)
      for (const property of path) {
        if (typeof property !== 'string' || property === '') {
          throw new TypeError('[znight] member names must be non-empty strings')
        }
        node = freeze({ kind: 'gen:member', object: node, property })
      }
      return node
    },
    call(callee, args) {
      return call(callee, args)
    },
    construct(callee, args) {
      return call(callee, args, true)
    },
    arrow(params, body, options) {
      const normalized = params.map(param => {
        const [name, type] = typeof param === 'string' ? [param, undefined] : param
        if (!isSafeIdentifier(name)) {
          throw new TypeError(`[znight] invalid parameter name ${JSON.stringify(name)}`)
        }
        return Object.freeze({ name, type: type === undefined ? undefined : input(type) })
      })
      const names = new Set(normalized.map(param => param.name))
      if (names.size !== normalized.length) {
        throw new TypeError('[znight] duplicate arrow function parameter')
      }
      const nodes = normalized.map(param => freeze<GenParam>({ kind: 'gen:param', name: param.name }))
      return freeze({
        kind: 'gen:arrow',
        params: Object.freeze(normalized),
        body: input(body(...nodes)),
        async: options?.async === true,
      })
    },
    block(locals, statements) {
      for (const name of locals) {
        if (!isSafeIdentifier(name)) {
          throw new TypeError(`[znight] invalid local name ${JSON.stringify(name)}`)
        }
      }
      if (new Set(locals).size !== locals.length) {
        throw new TypeError('[znight] duplicate block local')
      }
      const nodes = locals.map(name => freeze<GenParam>({ kind: 'gen:param', name }))
      return freeze({
        kind: 'gen:block',
        locals: Object.freeze([...locals]),
        statements: Object.freeze(statements(...nodes).map(input)),
      })
    },
    code(strings, ...values) {
      if (!Array.isArray(strings) || !Array.isArray((strings as TemplateStringsArray).raw)) {
        throw new TypeError('[znight] code`...` must be used as a tagged template')
      }
      if (strings.length !== values.length + 1) {
        throw new TypeError('[znight] malformed code`...` template')
      }
      return freeze({ kind: 'gen:code', parts: Object.freeze([...strings]), values: Object.freeze(values.map(input)) })
    },
  }
}

/** Freezes a node and records it as built (the code generator only prints built nodes). */
export function freeze<T extends GenNode>(node: T): T {
  BUILT.add(node)
  return Object.freeze(node)
}

/** Rejects values the literal emitter cannot print (functions, symbols, cycles, non-plain objects). */
function checkLiteral(value: unknown, stack: Set<unknown>): void {
  switch (typeof value) {
    case 'function':
      throw new TypeError('[znight] functions cannot be emitted as literals, use a node builder')
    case 'symbol':
      throw new TypeError('[znight] symbols cannot be emitted as literals')
    case 'object': {
      if (value === null || value instanceof ValueRefClass || value instanceof RegExp || value instanceof Date) {
        return
      }
      if (stack.has(value)) {
        throw new TypeError('[znight] cyclic values cannot be emitted as literals')
      }
      if (isGenNode(value)) {
        throw new TypeError('[znight] lit() takes plain values; use obj()/arr() to nest nodes')
      }
      const prototype = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('[znight] only plain objects, arrays, RegExp and Date can be emitted as literals')
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('[znight] objects with symbol keys cannot be emitted as literals')
      }
      stack.add(value)
      for (const item of Array.isArray(value) ? value : Object.values(value)) {
        checkLiteral(item, stack)
      }
      stack.delete(value)
      return
    }
    default:
      return
  }
}
