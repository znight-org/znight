/**
 * `TypeHelpers.shape()` (C1 of RFC 0002): a structural view of type annotations, computed from the
 * declarations (sources and `.d.ts` alike) instead of the resolved `TypeInfo`, which expands
 * aliases and keeps object literal types opaque.
 *
 * - Interfaces, classes, type aliases and enums are **named** shapes, computed once per compile and
 *   options (key: identity + serialized type arguments); recursion goes through them.
 * - Aliases keep their provenance: a reference to a schema alias (`z.output<typeof S>`) is matched
 *   before expansion, and an alias whose structure is a schema (or a kept reference) is transparent.
 * - Utility types, `keyof`, indexed access and mapped types over literal keys (enums and aliases of
 *   literal unions included) are applied structurally, and an enum member type (`Kind.Cat`) is its
 *   literal; anything else is `opaque`, and reported as a {@link ShapeIssue}.
 * - Files are read through the project, so they are part of `watchFiles`.
 */
import type {
  Class,
  Expression,
  MethodDefinition,
  PropertyDefinition,
  PropertyKey,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSMappedType,
  TSSignature,
  TSTupleElement,
  TSType,
  TSTypeAliasDeclaration,
  TSTypeName,
  TSTypeParameter,
} from 'oxc-parser'
import type {
  DocComment,
  NamedShape,
  Shape,
  ShapeIssue,
  ShapeOpaqueReason,
  ShapeOptions,
  ShapeProperty,
  ShapeResult,
  ShapeTarget,
} from '../extensions/api.ts'
import type { Declaration, Location, Project, ScopeRef, Span, SymbolResolution, TypeInfo } from '../project/index.ts'
import type { ObjectShape } from './shape.ts'

import { annotationOf } from '../analysis/annotations.ts'
import { docAt, startWithDecorators } from '../analysis/jsdoc.ts'
import { compareStrings } from '../project/compare.ts'
import { GLOBAL_IDENTITY_PREFIX, ValueRef } from '../project/index.ts'
import {
  array,
  intersection,
  keyword,
  literal,
  mergeObjects,
  object,
  orderedUnion,
  overrideProperties,
  serializeShape,
  union,
  withoutUndefined,
} from './shape.ts'

const MAX_DEPTH = 64
/**
 * Named shapes computed inside one another. References to named shapes are computed later (a
 * worklist), so only structural needs nest (`extends`, `Partial<T>`, intersections...).
 */
const MAX_NESTED_COMPUTATIONS = 64
/** Growing instantiations of one generic declaration (`type Grow<T> = { next: Grow<T[]> }`). */
const MAX_GROWING_INSTANTIATIONS = 3
/** Named shapes per compile and options (safety net). */
const MAX_NAMED = 20_000
const MAX_ALIAS_HOPS = 8

/** Global (lib) types serialised as bytes or streams. */
const BINARY_GLOBALS = new Set([
  'ArrayBuffer',
  'ArrayBufferLike',
  'ArrayBufferView',
  'BigInt64Array',
  'BigUint64Array',
  'Blob',
  'Buffer',
  'DataView',
  'File',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'ReadableStream',
  'SharedArrayBuffer',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
])

/** Builtin module exports serialised as bytes or streams. */
const BINARY_EXTERNALS = new Set([
  'buffer#Blob',
  'buffer#Buffer',
  'buffer#File',
  'node:buffer#Blob',
  'node:buffer#Buffer',
  'node:buffer#File',
  'node:stream#Readable',
  'node:stream/web#ReadableStream',
  'stream#Readable',
  'stream/web#ReadableStream',
])

/** Global types `JSON.stringify` does not serialise as declared. */
const NON_JSON_GLOBALS = new Set([
  'AbortController',
  'AbortSignal',
  'AggregateError',
  'AsyncGenerator',
  'AsyncIterable',
  'AsyncIterableIterator',
  'AsyncIterator',
  'Error',
  'EvalError',
  'FormData',
  'Generator',
  'Headers',
  'Iterable',
  'IterableIterator',
  'Iterator',
  'Map',
  'Promise',
  'PromiseLike',
  'RangeError',
  'ReadonlyMap',
  'ReadonlySet',
  'ReferenceError',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'SyntaxError',
  'TransformStream',
  'TypeError',
  'URIError',
  'URLSearchParams',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WritableStream',
])

const FUNCTION_GLOBALS = new Set(['Function', 'CallableFunction', 'NewableFunction'])

/** What a conversion belongs to: the root of a call, or a named shape (`named` of its issues). */
interface Sink {
  /** Key of the named shape (`undefined` for the root). */
  readonly named: string | undefined
}

/**
 * The issue of each opaque (and bigint) shape object. Issues are found by walking the final shapes,
 * so that a result only reports the parts it contains (`Pick<Book, 'id'>` does not report the
 * other properties of `Book`, nor list `Book` among its named shapes).
 */
const ISSUES = new WeakMap<Shape, ShapeIssue>()

/** Where an issue is: the conversion it belongs to, its path, and the file of its node. */
interface IssueContext {
  readonly scope: ScopeRef | undefined
  readonly sink: Sink
  readonly path: string
}

/** A type parameter without binding (generic methods): opaque where it is used. */
const UNBOUND: Shape = Object.freeze({ kind: 'opaque', text: '', reason: 'type-parameter' })

interface Context {
  readonly scope: ScopeRef
  /** Type parameters in scope: bound to a shape, or {@link UNBOUND}. */
  readonly params: ReadonlyMap<string, Shape>
  readonly sink: Sink
  /** Path in the type, for issues. */
  readonly path: string
  readonly depth: number
}

interface NamedEntry {
  named: NamedShape
  readonly sink: Sink
  /** Computed later (worklist), now, or done. */
  state: 'pending' | 'computing' | 'done'
  /** The class shape comes from a `toJSON()` method (inherited as a whole). */
  toJson: boolean
  readonly declaration: Declaration
  readonly file: ScopeRef['file']
  /** Path prefix of its issues (`Page<Book>`). */
  readonly display: string
  /** The named shape whose computation created this one (growth detection). */
  readonly parent: NamedEntry | undefined
  /** Named shapes its structure and type arguments reference (once computed). */
  refs: readonly string[]
  /** Issues of its structure (named references excluded), sorted (once computed). */
  issues: readonly ShapeIssue[]
}

/** Named shapes and normalised options of one options key. */
/** Named shapes reachable from a named shape (itself included), sorted, with their issues. */
interface Closure {
  readonly keys: readonly string[]
  readonly named: ReadonlyMap<string, NamedShape>
  readonly issues: readonly ShapeIssue[]
}

interface Cache {
  readonly named: Map<string, NamedEntry>
  /** Named shapes created but not computed yet. */
  readonly pending: NamedEntry[]
  readonly closures: Map<string, Closure>
  readonly schemaAliases: ReadonlyMap<string, 'input' | 'output'>
  readonly schemaMembers: ReadonlyMap<string, 'input' | 'output'>
  readonly keep: ReadonlySet<string>
  readonly jsdoc: boolean
}

/** Values referenced by `typeof X` shapes (schema aliases applied to a type parameter). */
const TYPEOF_REFS = new WeakMap<Shape, ValueRef>()

/** Resolves shapes for one compile (named shapes are memoized per options). */
export class ShapeResolver {
  readonly #project: Project
  readonly #caches = new Map<string, Cache>()
  /** Named shapes being computed inside one another. */
  #nesting = 0
  /** The named shape being computed. */
  #current: NamedEntry | undefined
  /** Identities of the declarations met (`identityOfDeclaration` is called for every reference). */
  readonly #identities = new WeakMap<Declaration, { readonly identity: string; readonly displayName: string }>()
  #cache: Cache | undefined

  constructor(project: Project) {
    this.#project = project
  }

  shape(target: ShapeTarget, options: ShapeOptions = {}): ShapeResult {
    const cache = this.#cacheOf(options)
    const previous = this.#cache
    this.#cache = cache
    try {
      const sink: Sink = { named: undefined }
      const root = this.#target(target, sink)
      // the named shapes reached, and the ones they reach, computed iteratively (no deep recursion)
      for (let index = 0; index < cache.pending.length; index++) {
        this.#compute(cache.pending[index] as NamedEntry)
      }
      cache.pending.length = 0
      return this.#result(root, cache)
    } finally {
      this.#cache = previous
    }
  }

  // ------------------------------------------------------------------ targets

  #target(target: ShapeTarget, sink: Sink): Shape {
    if (typeof target !== 'object' || target === null) {
      throw new TypeError('[znight] types.shape(): invalid target')
    }
    if ('type' in target) {
      return this.#fromTypeInfo(target.type, sink, '', 0)
    }
    let site: ReturnType<typeof annotationOf>
    let index = 0
    let returnOf = false
    if ('returnOf' in target) {
      site = annotationOf(target.returnOf)
      returnOf = true
    } else if ('parameter' in target) {
      site = annotationOf(target.parameter)
    } else if ('property' in target) {
      site = annotationOf(target.property)
    } else if ('decorator' in target) {
      site = annotationOf(target.decorator)
      index = target.typeArgument
    } else {
      throw new TypeError('[znight] types.shape(): unknown target')
    }
    const node = site?.nodes[index]
    if (!site || !node) {
      const shape = this.#opaque('', 'missing-annotation')
      this.#issue({ scope: undefined, sink, path: '' }, shape, undefined)
      return shape
    }
    const params = new Map<string, Shape>()
    for (const name of site.typeParameters) {
      const bound = site.bindings.get(name)
      params.set(name, bound === undefined ? UNBOUND : this.#fromTypeInfo(bound, sink, '', 0))
    }
    const context: Context = { scope: site.scope, params, sink, path: '', depth: 0 }
    if (returnOf) {
      const inner = this.#promiseArgument(node, context)
      if (inner) {
        return this.#convert(inner, context)
      }
    }
    return this.#convert(node, context)
  }

  /** `Promise<T>` (the global) → `T`. */
  #promiseArgument(node: TSType, context: Context): TSType | undefined {
    if (node.type !== 'TSTypeReference' || node.typeArguments?.params.length !== 1) {
      return undefined
    }
    if (node.typeName.type === 'Identifier' && context.params.has(node.typeName.name)) {
      return undefined
    }
    const symbol = this.#project.symbols.resolveEntity(context.scope, node.typeName, 'type')
    return symbol.kind === 'global' && symbol.name === 'Promise' ? node.typeArguments.params[0] : undefined
  }

  // ------------------------------------------------------------------ result

  #result(root: Shape, cache: Cache): ShapeResult {
    const found = walkShapes([root])
    const roots = found.refs
    for (const key of roots) {
      this.#closure(key, cache)
    }
    const closures = [...new Set(roots.flatMap(key => cache.closures.get(key) ?? []))]
    const rootIssues = found.issues
    // the common case: one closure contains every root (`Page<Book>` reaches `Book`); its map and
    // issues are shared by every result reaching it
    const covering = closures.find(closure => roots.every(key => closure.named.has(key)))
    if (covering) {
      return {
        root,
        named: covering.named,
        issues: rootIssues.length === 0 ? covering.issues : [...rootIssues, ...covering.issues],
      }
    }
    const keys = [...new Set(closures.flatMap(closure => closure.keys))].sort(compareStrings)
    // root issues (`named: undefined`) sort first, then the issues of each named shape (sorted by key)
    const issues = [...rootIssues, ...keys.flatMap(key => cache.named.get(key)?.issues ?? [])]
    return { root, named: namedMap(keys, cache), issues }
  }

  /**
   * The named shapes reachable from `key` (itself included), memoized per strongly connected
   * component of the reference graph (Tarjan), so that assembling a result never walks a large
   * model twice.
   */
  #closure(start: string, cache: Cache): void {
    if (cache.closures.has(start)) {
      return
    }
    let counter = 0
    const index = new Map<string, number>()
    const low = new Map<string, number>()
    const stack: string[] = []
    const onStack = new Set<string>()
    const refsOf = (key: string): Iterable<string> => cache.named.get(key)?.refs ?? []
    const visit = (key: string): void => {
      index.set(key, counter)
      low.set(key, counter)
      counter++
      stack.push(key)
      onStack.add(key)
      for (const next of refsOf(key)) {
        if (cache.closures.has(next)) {
          continue
        }
        if (!index.has(next)) {
          visit(next)
          low.set(key, Math.min(low.get(key) as number, low.get(next) as number))
        } else if (onStack.has(next)) {
          low.set(key, Math.min(low.get(key) as number, index.get(next) as number))
        }
      }
      if (low.get(key) !== index.get(key)) {
        return
      }
      const members: string[] = []
      let member: string | undefined
      do {
        member = stack.pop() as string
        onStack.delete(member)
        members.push(member)
      } while (member !== key)
      const reachable = new Set(members)
      for (const current of members) {
        for (const next of refsOf(current)) {
          for (const found of cache.closures.get(next)?.keys ?? []) {
            reachable.add(found)
          }
        }
      }
      const keys = [...reachable].filter(found => cache.named.has(found)).sort(compareStrings)
      const closure: Closure = {
        keys,
        named: namedMap(keys, cache),
        issues: keys.flatMap(found => cache.named.get(found)?.issues ?? []),
      }
      for (const current of members) {
        cache.closures.set(current, closure)
      }
    }
    visit(start)
  }

  #cacheOf(options: ShapeOptions): Cache {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('[znight] types.shape(): options must be an object')
    }
    const schemaAliases = recordEntries(options.schemaAliases, 'schemaAliases')
    const schemaMembers = recordEntries(options.schemaMembers, 'schemaMembers')
    const keep = [...new Set(options.keep ?? [])].sort(compareStrings)
    if (!keep.every(identity => typeof identity === 'string')) {
      throw new TypeError('[znight] types.shape(): keep must be an array of identities')
    }
    const jsdoc = options.jsdoc !== false
    const key = JSON.stringify([schemaAliases, schemaMembers, keep, jsdoc])
    let cache = this.#caches.get(key)
    if (!cache) {
      cache = {
        named: new Map(),
        pending: [],
        closures: new Map(),
        schemaAliases: new Map(schemaAliases),
        schemaMembers: new Map(schemaMembers),
        keep: new Set(keep),
        jsdoc,
      }
      this.#caches.set(key, cache)
    }
    return cache
  }

  get #options(): Cache {
    return this.#cache as Cache
  }

  // ------------------------------------------------------------------ AST

  #convert(node: TSType, context: Context): Shape {
    if (context.depth > MAX_DEPTH) {
      return this.#opaqueAt(node, context, 'recursive')
    }
    const nested: Context = { ...context, depth: context.depth + 1 }
    switch (node.type) {
      case 'TSStringKeyword':
        return keyword('string')
      case 'TSNumberKeyword':
        return keyword('number')
      case 'TSBooleanKeyword':
        return keyword('boolean')
      case 'TSNullKeyword':
        return keyword('null')
      case 'TSUndefinedKeyword':
      case 'TSVoidKeyword':
        return keyword('undefined')
      case 'TSAnyKeyword':
      case 'TSUnknownKeyword':
        return keyword('unknown')
      case 'TSNeverKeyword':
        return keyword('never')
      case 'TSObjectKeyword':
        return object([], keyword('unknown'))
      case 'TSBigIntKeyword':
        return this.#bigint(node, context)
      case 'TSSymbolKeyword':
        return this.#opaqueAt(node, context, 'symbol')
      case 'TSLiteralType':
        return this.#literal(node, context)
      case 'TSTemplateLiteralType':
        return node.types.length === 0 && node.quasis.length === 1
          ? literal(node.quasis[0]?.value.cooked ?? '')
          : keyword('string')
      case 'TSArrayType':
        return array(this.#convert(node.elementType, at(nested, '[]')))
      case 'TSTypeOperator':
        if (node.operator === 'readonly') {
          return this.#convert(node.typeAnnotation, nested)
        }
        if (node.operator === 'keyof') {
          return this.#keyof(this.#convert(node.typeAnnotation, nested), node, context)
        }
        return this.#opaqueAt(node, context, 'symbol')
      case 'TSTupleType':
        return this.#tuple(node.elementTypes, nested)
      case 'TSNamedTupleMember':
        return this.#tuple([node], nested)
      case 'TSUnionType':
        return union(node.types.map(member => this.#convert(member, nested)))
      case 'TSIntersectionType':
        return intersection(
          node.types.map(member => this.#convert(member, nested)),
          shape => this.#toObject(shape),
        )
      case 'TSParenthesizedType':
        return this.#convert(node.typeAnnotation, context)
      case 'TSTypeReference':
        return this.#reference(node, nested)
      case 'TSTypeLiteral':
        return this.#members(node.members, nested)
      case 'TSMappedType':
        return this.#mapped(node, nested)
      case 'TSIndexedAccessType':
        return this.#indexed(
          this.#convert(node.objectType, nested),
          this.#convert(node.indexType, nested),
          node,
          context,
        )
      case 'TSTypeQuery':
        return this.#typeQuery(node, context)
      case 'TSFunctionType':
      case 'TSConstructorType':
        return this.#opaqueAt(node, context, 'function')
      case 'TSConditionalType':
        return this.#opaqueAt(node, context, 'conditional')
      case 'TSThisType':
        return this.#opaqueAt(node, context, 'this')
      default:
        return this.#opaqueAt(node, context, 'unsupported')
    }
  }

  #literal(node: Extract<TSType, { type: 'TSLiteralType' }>, context: Context): Shape {
    const value = node.literal
    switch (value.type) {
      case 'Literal':
        if ('bigint' in value && typeof value.bigint === 'string') {
          return this.#bigint(node, context)
        }
        if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') {
          return literal(value.value)
        }
        return this.#opaqueAt(node, context, 'unsupported')
      case 'UnaryExpression':
        if (value.operator === '-' && value.argument.type === 'Literal') {
          if ('bigint' in value.argument && typeof value.argument.bigint === 'string') {
            return this.#bigint(node, context)
          }
          if (typeof value.argument.value === 'number') {
            return literal(-value.argument.value)
          }
        }
        return this.#opaqueAt(node, context, 'unsupported')
      case 'TemplateLiteral':
        return value.expressions.length === 0 && value.quasis.length === 1
          ? literal(value.quasis[0]?.value.cooked ?? '')
          : keyword('string')
      default:
        return this.#opaqueAt(node, context, 'unsupported')
    }
  }

  #tuple(elements: readonly TSTupleElement[], context: Context): Shape {
    const items: Shape[] = []
    let rest: Shape | undefined
    let minItems = 0
    let optionalSeen = false
    for (const [index, element] of elements.entries()) {
      let current: TSTupleElement = element
      let optional = false
      if (current.type === 'TSNamedTupleMember') {
        optional = current.optional
        current = current.elementType
      }
      const child = at(context, `[${index}]`)
      if (current.type === 'TSOptionalType') {
        items.push(this.#convert(current.typeAnnotation, child))
        optionalSeen = true
      } else if (current.type === 'TSRestType') {
        const restShape = this.#convert(current.typeAnnotation, child)
        rest = restShape.kind === 'array' ? restShape.items : restShape
      } else {
        items.push(this.#convert(current as TSType, child))
        if (optional) {
          optionalSeen = true
        } else if (!optionalSeen) {
          minItems = items.length
        }
      }
    }
    return rest === undefined ? { kind: 'tuple', items, minItems } : { kind: 'tuple', items, rest, minItems }
  }

  #reference(node: Extract<TSType, { type: 'TSTypeReference' }>, context: Context): Shape {
    const name = node.typeName
    if (name.type === 'Identifier') {
      const bound = context.params.get(name.name)
      if (bound !== undefined) {
        return bound === UNBOUND ? this.#opaqueAt(node, context, 'type-parameter') : bound
      }
    }
    if (name.type === 'ThisExpression') {
      return this.#opaqueAt(node, context, 'this')
    }
    const symbol = this.#project.symbols.resolveEntity(context.scope, name, 'type')
    if (symbol.kind === 'unresolved' && name.type === 'TSQualifiedName') {
      const member = this.#enumMember(name, context)
      if (member) {
        return member
      }
    }
    return this.#fromSymbol(symbol, node.typeArguments?.params ?? [], node, context)
  }

  /**
   * `Kind.Cat` (an enum member type, `ns.Kind.Cat` included): the literal value of the member,
   * `undefined` when the left side is not an enum declaring it.
   */
  #enumMember(name: Extract<TSTypeName, { type: 'TSQualifiedName' }>, context: Context): Shape | undefined {
    const owner = this.#project.symbols.resolveEntity(context.scope, name.left, 'any')
    const declaration =
      owner.kind === 'declaration' ? owner.declarations.find(candidate => candidate.kind === 'enum') : undefined
    const members = declaration ? this.#enumValues(declaration) : undefined
    const value = members && Object.hasOwn(members, name.right.name) ? members[name.right.name] : undefined
    return typeof value === 'string' || typeof value === 'number' ? literal(value) : undefined
  }

  #fromSymbol(symbol: SymbolResolution, argNodes: readonly TSType[], node: Span, context: Context): Shape {
    const options = this.#options
    switch (symbol.kind) {
      case 'global':
        return this.#global(symbol.name, argNodes, node, context)
      case 'external': {
        const identity = this.#project.identityOf(symbol)?.identity
        if (identity !== undefined && options.keep.has(identity)) {
          return this.#kept(
            identity,
            symbol.path.join('.'),
            argNodes.map(arg => this.#convert(arg, context)),
            argNodes.length,
          )
        }
        if (identity !== undefined && BINARY_EXTERNALS.has(identity)) {
          return keyword('binary')
        }
        return this.#opaqueAt(node, context, 'unresolved')
      }
      case 'declaration': {
        const declaration = symbol.declaration
        const identity = this.#identityOf(declaration)
        if (declaration.kind === 'type') {
          const io = options.schemaAliases.get(identity.identity)
          const ref = io && argNodes[0] ? this.#schemaRef(argNodes[0], context, 0) : undefined
          if (io && ref) {
            return { kind: 'schema', ref, io }
          }
        }
        if (
          declaration.kind !== 'type' &&
          declaration.kind !== 'interface' &&
          declaration.kind !== 'class' &&
          declaration.kind !== 'enum'
        ) {
          return this.#opaqueAt(node, context, 'unresolved')
        }
        // `typeof S` of `Out<typeof S>` (`type Out<S> = z.output<S>`) is reported only if it stays data
        const args = argNodes.map((arg, index) => this.#convert(arg, at(context, `<${index}>`)))
        return options.keep.has(identity.identity)
          ? this.#kept(identity.identity, identity.displayName, this.#bind(declaration, args, context), argNodes.length)
          : this.#named(declaration, args, context)
      }
      default:
        return this.#opaqueAt(node, context, 'unresolved')
    }
  }

  #identityOf(declaration: Declaration): { readonly identity: string; readonly displayName: string } {
    let found = this.#identities.get(declaration)
    if (!found) {
      const info = this.#project.identities.identityOfDeclaration(declaration)
      found = { identity: info.identity, displayName: info.displayName }
      this.#identities.set(declaration, found)
    }
    return found
  }

  #kept(identity: string, name: string, typeArgs: readonly Shape[], explicit: number): Shape {
    return { kind: 'reference', identity, name, typeArgs, explicitTypeArgs: explicit }
  }

  /** Lib types: arrays, dates, bytes, utility types... */
  #global(name: string, argNodes: readonly TSType[], node: Span, context: Context): Shape {
    const identity = `${GLOBAL_IDENTITY_PREFIX}${name}`
    const args = (): Shape[] => argNodes.map((arg, index) => this.#convert(arg, at(context, `<${index}>`)))
    if (this.#options.keep.has(identity)) {
      return this.#kept(identity, name, args(), argNodes.length)
    }
    const first = (): Shape => (argNodes[0] ? this.#convert(argNodes[0], context) : keyword('unknown'))
    const second = (): Shape => (argNodes[1] ? this.#convert(argNodes[1], context) : keyword('unknown'))
    switch (name) {
      case 'Array':
      case 'ReadonlyArray':
        return array(argNodes[0] ? this.#convert(argNodes[0], at(context, '[]')) : keyword('unknown'))
      case 'Date':
        return keyword('date')
      case 'URL':
        return keyword('url')
      case 'String':
        return keyword('string')
      case 'Number':
        return keyword('number')
      case 'Boolean':
        return keyword('boolean')
      case 'BigInt':
        return this.#bigint(node, context)
      case 'Object':
        return keyword('unknown')
      case 'Symbol':
        return this.#opaqueAt(node, context, 'symbol')
      case 'Partial':
        return this.#mapObject(first(), node, context, current => ({ ...current, optional: true }))
      case 'Required':
        return this.#mapObject(first(), node, context, current => ({ ...current, optional: false }))
      case 'Readonly':
        return this.#mapObject(first(), node, context, current => ({ ...current, readonly: true }))
      case 'Pick':
      case 'Omit': {
        const keys = literalKeys(this.#unionMembers(second()))
        if (keys === undefined) {
          return this.#opaqueAt(node, context, 'unsupported')
        }
        const pick = name === 'Pick'
        return this.#filterObject(first(), node, context, property => keys.has(property.name) === pick)
      }
      case 'Record':
        return this.#record(first(), second(), node, context)
      case 'NonNullable':
        return this.#filterMembers(first(), member => member.kind !== 'null' && member.kind !== 'undefined')
      case 'Exclude':
      case 'Extract': {
        const matches = unionMatcher(this.#unionMembers(second()))
        const extract = name === 'Extract'
        return this.#filterMembers(first(), member => matches(member) === extract)
      }
      case 'Awaited': {
        const inner = argNodes[0] ? this.#promiseArgument(argNodes[0], context) : undefined
        return inner ? this.#convert(inner, context) : first()
      }
      default:
        if (BINARY_GLOBALS.has(name)) {
          return keyword('binary')
        }
        return this.#opaqueAt(node, context, globalReason(name))
    }
  }

  /** `S` of `z.output<typeof S>`: `typeof S`, a type parameter bound to it, or an alias of it. */
  #schemaRef(node: TSType, context: Context, hops: number): ValueRef | undefined {
    if (node.type === 'TSTypeQuery') {
      return node.exprName.type === 'TSImportType' ? undefined : this.#valueRef(node.exprName, context)
    }
    if (node.type !== 'TSTypeReference' || hops > MAX_ALIAS_HOPS) {
      return undefined
    }
    if (node.typeName.type === 'Identifier') {
      const bound = context.params.get(node.typeName.name)
      if (bound !== undefined) {
        return TYPEOF_REFS.get(bound)
      }
    }
    const symbol = this.#project.symbols.resolveEntity(context.scope, node.typeName, 'type')
    if (symbol.kind !== 'declaration' || symbol.declaration.kind !== 'type') {
      return undefined
    }
    const declaration = symbol.declaration
    const file = this.#project.getFile(declaration.file)
    const alias = declaration.node as TSTypeAliasDeclaration
    if (!file || (alias.typeParameters?.params.length ?? 0) > 0) {
      return undefined
    }
    return this.#schemaRef(
      alias.typeAnnotation,
      { ...context, scope: { file, namespace: declaration.namespace }, params: new Map() },
      hops + 1,
    )
  }

  #valueRef(name: TSTypeName, context: Context): ValueRef | undefined {
    if (name.type === 'ThisExpression') {
      return undefined
    }
    const symbol = this.#project.symbols.resolveEntity(context.scope, name, 'value')
    if (symbol.kind === 'unresolved' || symbol.kind === 'global') {
      return undefined
    }
    const info = this.#project.identityOf(symbol)
    const text = context.scope.file.textOf(name)
    return new ValueRef(info?.identity, info?.displayName ?? text, text, symbol, context.scope.file.location(name))
  }

  /** `typeof X`: ArkType `typeof S.infer` with {@link ShapeOptions.schemaMembers}, else opaque (it may feed a schema alias). */
  #typeQuery(node: Extract<TSType, { type: 'TSTypeQuery' }>, context: Context): Shape {
    const name = node.exprName
    if (name.type === 'TSQualifiedName') {
      const io = this.#options.schemaMembers.get(name.right.name)
      const ref = io ? this.#valueRef(name.left, context) : undefined
      if (io && ref) {
        return { kind: 'schema', ref, io }
      }
    }
    const shape = this.#opaque(context.scope.file.textOf(node), 'typeof')
    const ref = name.type === 'TSImportType' ? undefined : this.#valueRef(name, context)
    if (ref) {
      TYPEOF_REFS.set(shape, ref)
    }
    this.#issue(context, shape, node)
    return shape
  }

  // ------------------------------------------------------------- named

  #named(declaration: Declaration, args: readonly Shape[], context: Context): Shape {
    const cache = this.#options
    const identity = this.#identityOf(declaration)
    const typeArgs = this.#bind(declaration, args, context)
    const key =
      typeArgs.length === 0 ? identity.identity : `${identity.identity}<${typeArgs.map(serializeShape).join(', ')}>`
    let entry = cache.named.get(key)
    if (!entry) {
      const file = this.#project.getFile(declaration.file)
      const kind = declarationKind(declaration)
      if (!file || kind === undefined) {
        const shape = this.#opaque(identity.displayName, 'unresolved')
        this.#issue(context, shape, undefined)
        return shape
      }
      if (cache.named.size >= MAX_NAMED || this.#growing(identity.identity, typeArgs)) {
        const shape = this.#opaque(identity.displayName, 'recursive')
        this.#issue(context, shape, undefined)
        return shape
      }
      const display =
        typeArgs.length === 0
          ? identity.displayName
          : `${identity.displayName}<${typeArgs.map(arg => displayShape(arg, cache)).join(', ')}>`
      entry = {
        named: {
          key,
          identity: identity.identity,
          name: identity.displayName,
          declaration: kind,
          typeArgs,
          shape: keyword('unknown'),
          doc: undefined,
          location: file.location(declaration.span),
        },
        sink: { named: key },
        refs: [],
        issues: [],
        state: 'pending',
        toJson: false,
        declaration,
        file,
        display,
        parent: this.#current,
      }
      cache.named.set(key, entry)
      cache.pending.push(entry)
      if (kind === 'alias' && mayBeTransparent(declaration)) {
        this.#compute(entry)
      }
    }
    // An alias of a schema or of a kept reference is transparent (`type CreateBook = z.output<typeof CreateBook>`).
    if (entry.state === 'done' && entry.named.declaration === 'alias') {
      const shape = entry.named.shape
      if (shape.kind === 'schema' || shape.kind === 'reference') {
        return shape
      }
    }
    return { kind: 'named', key }
  }

  /**
   * `true` when instantiating `identity` with `typeArgs` grows an instantiation of the same
   * declaration among the ones whose computation led here (`Grow<string[]>` from `Grow<string>`)
   * for the {@link MAX_GROWING_INSTANTIATIONS}th time.
   */
  #growing(identity: string, typeArgs: readonly Shape[]): boolean {
    if (typeArgs.length === 0) {
      return false
    }
    let growth = 0
    for (let ancestor = this.#current; ancestor; ancestor = ancestor.parent) {
      if (ancestor.named.identity !== identity) {
        continue
      }
      const previous = ancestor.named.typeArgs
      if (typeArgs.some((arg, index) => previous[index] !== undefined && containsStrictly(arg, previous[index]))) {
        growth++
        if (growth >= MAX_GROWING_INSTANTIATIONS) {
          return true
        }
      }
    }
    return false
  }

  /** Computes a named shape now (pending ones only; nested computations are bounded). */
  #compute(entry: NamedEntry): void {
    if (entry.state !== 'pending' || this.#nesting >= MAX_NESTED_COMPUTATIONS) {
      return
    }
    const cache = this.#options
    const { declaration, file } = entry
    entry.state = 'computing'
    const previous = this.#current
    this.#current = entry
    this.#nesting++
    try {
      const params = new Map<string, Shape>()
      for (const [index, parameter] of typeParameterNodes(declaration).entries()) {
        params.set(parameter.name.name, entry.named.typeArgs[index] ?? keyword('unknown'))
      }
      const inner: Context = {
        scope: { file, namespace: declaration.namespace },
        params,
        sink: entry.sink,
        path: entry.display,
        depth: 0,
      }
      const shape = this.#declarationShape(declaration, entry.named.declaration, inner, entry)
      entry.named = {
        ...entry.named,
        shape,
        doc: cache.jsdoc ? this.#declarationDoc(declaration, file) : undefined,
      }
      const found = walkShapes([shape, ...entry.named.typeArgs])
      entry.refs = found.refs
      entry.issues = found.issues
    } finally {
      this.#nesting--
      this.#current = previous
      entry.state = 'done'
    }
  }

  /** Type arguments with defaults filled (converted in the declaration scope) or `unknown`. */
  #bind(declaration: Declaration, args: readonly Shape[], context: Context): Shape[] {
    const parameters = typeParameterNodes(declaration)
    if (parameters.length === 0) {
      return []
    }
    const file = this.#project.getFile(declaration.file)
    const bound = new Map<string, Shape>()
    const result: Shape[] = []
    for (const [index, parameter] of parameters.entries()) {
      let shape = args[index]
      if (shape === undefined) {
        shape =
          parameter.default && file
            ? this.#convert(parameter.default, {
                scope: { file, namespace: declaration.namespace },
                params: new Map(bound),
                sink: context.sink,
                path: context.path,
                depth: context.depth + 1,
              })
            : keyword('unknown')
      }
      bound.set(parameter.name.name, shape)
      result.push(shape)
    }
    return result
  }

  #declarationShape(
    declaration: Declaration,
    kind: NamedShape['declaration'],
    context: Context,
    entry: NamedEntry,
  ): Shape {
    switch (kind) {
      case 'alias':
        return this.#convert((declaration.node as TSTypeAliasDeclaration).typeAnnotation, context)
      case 'interface':
        return this.#interface(declaration, context)
      case 'class':
        return this.#class(declaration, context, entry)
      case 'enum':
        return this.#enum(declaration, context)
    }
  }

  #declarationDoc(declaration: Declaration, file: ScopeRef['file']): DocComment | undefined {
    const node = declaration.node as unknown as Span & { readonly decorators?: readonly Span[] }
    return docAt(file, startWithDecorators(node, node.decorators))
  }

  #interface(declaration: Declaration, context: Context): Shape {
    const symbol = this.#project.lookupIdentity(this.#identityOf(declaration).identity)
    const declarations =
      symbol.kind === 'declaration' ? symbol.declarations.filter(candidate => candidate.kind === 'interface') : []
    const merged = declarations.length > 0 ? declarations : [declaration]
    const bases: ObjectShape[] = []
    const own: ObjectShape[] = []
    for (const current of merged) {
      const file = this.#project.getFile(current.file)
      if (!file) {
        continue
      }
      const scoped: Context = { ...context, scope: { file, namespace: current.namespace } }
      const node = current.node as TSInterfaceDeclaration
      for (const heritage of node.extends) {
        const symbolOf = this.#project.symbols.resolveEntity(scoped.scope, heritage.expression, 'type')
        const base = this.#fromSymbol(symbolOf, heritage.typeArguments?.params ?? [], heritage, scoped)
        const structure = this.#toObject(base)
        if (structure) {
          bases.push(structure)
        } else if (base.kind !== 'opaque') {
          // a base being computed is an `extends` cycle
          const cycle = base.kind === 'named' && this.#options.named.get(base.key)?.state === 'computing'
          this.#issue(scoped, this.#opaque(file.textOf(heritage), cycle ? 'recursive' : 'unsupported'), heritage)
        }
      }
      const members = this.#members(node.body.body, scoped)
      if (members.kind === 'object') {
        own.push(members)
      } else {
        return members
      }
    }
    const toObject = (shape: Shape): ObjectShape | undefined => this.#toObject(shape)
    const base = mergeObjects(bases, toObject)
    const mine = mergeObjects(own, toObject)
    const additional = mine.additional ?? base.additional
    return object(overrideProperties(base.properties, mine.properties), additional)
  }

  /** Members of an interface body or object literal type. */
  #members(members: readonly TSSignature[], context: Context): Shape {
    const properties: ShapeProperty[] = []
    let additional: Shape | undefined
    for (const member of members) {
      switch (member.type) {
        case 'TSPropertySignature': {
          const name = propertyName(member.key, member.computed)
          if (name === undefined) {
            continue
          }
          const annotation = member.typeAnnotation?.typeAnnotation
          properties.push(
            this.#property(name, annotation, member.optional, member.readonly, member, member.key, context),
          )
          break
        }
        case 'TSIndexSignature': {
          const keyType = member.parameters[0]?.typeAnnotation.typeAnnotation
          if (keyType?.type === 'TSStringKeyword' || keyType?.type === 'TSNumberKeyword') {
            const value = this.#convert(member.typeAnnotation.typeAnnotation, at(context, '[string]'))
            additional = additional === undefined ? value : union([additional, value])
          }
          break
        }
        case 'TSCallSignatureDeclaration':
        case 'TSConstructSignatureDeclaration':
          return this.#opaqueAt(member, context, 'function')
        default:
          // methods and accessors are not serialised data
          break
      }
    }
    return object(properties, additional)
  }

  #property(
    name: string,
    annotation: TSType | undefined,
    optional: boolean,
    readonly: boolean,
    node: Span & { readonly decorators?: readonly Span[] | null },
    key: Span,
    context: Context,
  ): ShapeProperty {
    const child = at(context, name)
    const converted = annotation ? this.#convert(annotation, child) : this.#opaqueAt(node, child, 'missing-annotation')
    const { shape, undefinable } = withoutUndefined(converted)
    return {
      name,
      shape,
      optional: optional || undefinable,
      readonly,
      doc: this.#options.jsdoc ? docAt(context.scope.file, startWithDecorators(node, node.decorators)) : undefined,
      location: context.scope.file.location(key),
    }
  }

  #class(declaration: Declaration, context: Context, entry: NamedEntry): Shape {
    const node = declaration.node as Class
    // `toJSON()` decides what JSON.stringify produces: the fields do not matter then
    const toJson = node.body.body.find(
      (member): member is MethodDefinition =>
        (member.type === 'MethodDefinition' || member.type === 'TSAbstractMethodDefinition') &&
        !member.static &&
        member.kind === 'method' &&
        propertyName(member.key, member.computed) === 'toJSON',
    )
    if (toJson) {
      entry.toJson = true
      const returnType = toJson.value.returnType?.typeAnnotation
      return returnType ? this.#convert(returnType, context) : this.#opaqueAt(toJson.key, context, 'to-json')
    }
    let base: ObjectShape | undefined
    if (node.superClass) {
      const symbol = this.#project.symbols.resolveEntity(context.scope, node.superClass, 'value')
      const shape =
        symbol.kind === 'declaration' && symbol.declaration.kind === 'class'
          ? this.#fromSymbol(symbol, node.superTypeArguments?.params ?? [], node.superClass, context)
          : this.#opaqueAt(node.superClass, context, 'unresolved')
      if (shape.kind === 'named') {
        const parent = this.#options.named.get(shape.key)
        if (parent?.state === 'pending') {
          this.#compute(parent)
        }
        if (parent?.toJson) {
          entry.toJson = true
          return parent.named.shape
        }
      }
      base = this.#toObject(shape)
    }
    // Parameter properties first, then fields: the order of declaration files (`tsc` lists parameter
    // properties first), so that a class gives the same shape from its sources and its `.d.ts`.
    const ctor = node.body.body.find(
      (member): member is MethodDefinition => member.type === 'MethodDefinition' && member.kind === 'constructor',
    )
    const properties: ShapeProperty[] = ctor ? this.#parameterProperties(ctor, context) : []
    for (const member of node.body.body) {
      if (member.type !== 'PropertyDefinition' && member.type !== 'TSAbstractPropertyDefinition') {
        continue // methods, accessors (auto-accessors included) live on the prototype
      }
      // TypeScript `private` fields are internals, and their types are erased from declaration files
      if (member.static || member.accessibility === 'private') {
        continue
      }
      const name = propertyName(member.key, member.computed)
      if (name === undefined) {
        continue
      }
      const annotation = member.typeAnnotation?.typeAnnotation
      if (annotation === undefined && member.value) {
        properties.push(this.#inferredProperty(name, member, context))
        continue
      }
      properties.push(
        this.#property(
          name,
          annotation,
          member.optional === true,
          member.readonly === true,
          member,
          member.key,
          context,
        ),
      )
    }
    return object(overrideProperties(base?.properties ?? [], properties), base?.additional)
  }

  /** `constructor(readonly id: string, private tags: string[])`: own instance fields. */
  #parameterProperties(member: MethodDefinition, context: Context): ShapeProperty[] {
    const found: ShapeProperty[] = []
    for (const param of member.value.params) {
      if (param.type !== 'TSParameterProperty' || param.accessibility === 'private') {
        continue
      }
      const pattern = param.parameter.type === 'AssignmentPattern' ? param.parameter.left : param.parameter
      if (pattern.type !== 'Identifier') {
        continue
      }
      const annotation = pattern.typeAnnotation?.typeAnnotation
      found.push(
        this.#property(
          pattern.name,
          annotation,
          (pattern as { optional?: boolean }).optional === true,
          param.readonly,
          param,
          pattern,
          context,
        ),
      )
    }
    return found
  }

  /** A field without annotation: the type of a literal initializer, or `new X()`. */
  #inferredProperty(name: string, member: PropertyDefinition, context: Context): ShapeProperty {
    const value = unwrapExpression(member.value as Expression)
    let shape: Shape | undefined
    if (value.type === 'Literal') {
      if (typeof value.value === 'string') shape = keyword('string')
      else if (typeof value.value === 'number') shape = keyword('number')
      else if (typeof value.value === 'boolean') shape = keyword('boolean')
      else if (value.value === null) shape = keyword('null')
    } else if (value.type === 'TemplateLiteral') {
      shape = keyword('string')
    } else if (value.type === 'NewExpression' && value.callee.type === 'Identifier') {
      const symbol = this.#project.symbols.resolveEntity(context.scope, value.callee, 'value')
      if (symbol.kind === 'global' || (symbol.kind === 'declaration' && symbol.declaration.kind === 'class')) {
        shape = this.#fromSymbol(symbol, value.typeArguments?.params ?? [], value, at(context, name))
      }
    }
    return {
      name,
      shape: shape ?? this.#opaqueAt(member, at(context, name), 'missing-annotation'),
      optional: member.optional === true,
      readonly: member.readonly === true,
      doc: this.#options.jsdoc ? docAt(context.scope.file, startWithDecorators(member, member.decorators)) : undefined,
      location: context.scope.file.location(member.key),
    }
  }

  #enum(declaration: Declaration, context: Context): Shape {
    const members = this.#enumValues(declaration)
    if (members === undefined) {
      return this.#opaqueAt((declaration.node as TSEnumDeclaration).id, context, 'unsupported')
    }
    return orderedUnion(
      Object.values(members).flatMap(value =>
        typeof value === 'string' || typeof value === 'number' ? [literal(value)] : [],
      ),
    )
  }

  /** The members of an enum declaration, evaluated in its scope (`undefined` when not evaluable). */
  #enumValues(declaration: Declaration): Readonly<Record<string, unknown>> | undefined {
    const file = this.#project.getFile(declaration.file)
    if (!file) {
      return undefined
    }
    const reference = {
      type: 'Identifier',
      name: declaration.localName,
      start: declaration.span.start,
      end: declaration.span.end,
    } as unknown as Expression
    const evaluation = this.#project.evaluate({ file, namespace: declaration.namespace }, reference, { refs: 'none' })
    return evaluation.kind === 'value' && typeof evaluation.value === 'object' && evaluation.value !== null
      ? (evaluation.value as Readonly<Record<string, unknown>>)
      : undefined
  }

  // ------------------------------------------------------ structural ops

  /** The object structure of a shape (named shapes dereferenced), `undefined` when it is not an object. */
  #toObject(shape: Shape, depth = 0): ObjectShape | undefined {
    if (shape.kind === 'object') {
      return shape
    }
    if (shape.kind === 'named' && depth < MAX_ALIAS_HOPS) {
      const entry = this.#options.named.get(shape.key)
      if (entry?.state === 'pending') {
        this.#compute(entry)
      }
      return entry?.state === 'done' ? this.#toObject(entry.named.shape, depth + 1) : undefined
    }
    return undefined
  }

  /** Applies `map` to every property of an object (or of each object of a union). */
  #mapObject(shape: Shape, node: Span, context: Context, map: (property: ShapeProperty) => ShapeProperty): Shape {
    if (shape.kind === 'union') {
      return union(shape.members.map(member => this.#mapObject(member, node, context, map)))
    }
    const structure = this.#toObject(shape)
    if (structure) {
      return object(structure.properties.map(map), structure.additional)
    }
    return shape
  }

  #filterObject(shape: Shape, node: Span, context: Context, keep: (property: ShapeProperty) => boolean): Shape {
    if (shape.kind === 'union') {
      return union(shape.members.map(member => this.#filterObject(member, node, context, keep)))
    }
    const structure = this.#toObject(shape)
    if (!structure) {
      return shape.kind === 'opaque' ? shape : this.#opaqueAt(node, context, 'unsupported')
    }
    return object(structure.properties.filter(keep), structure.additional)
  }

  /**
   * The members of a union, with named enums and aliases of unions, literals or primitives
   * dereferenced (`Genre`, `type Keys = 'a' | 'b'`), flattened and de-duplicated: what key types
   * (`Record<Genre, T>`, `{ [K in Keys]: T }`, `Pick`, `T[K]`) and distributive utility types
   * (`Exclude`, `Extract`, `NonNullable`) iterate over.
   */
  #unionMembers(shape: Shape): Shape[] {
    const found = new Map<string, Shape>()
    const visit = (current: Shape, hops: number): void => {
      if (current.kind === 'union') {
        for (const member of current.members) {
          visit(member, hops)
        }
        return
      }
      const entry = current.kind === 'named' && hops < MAX_ALIAS_HOPS ? this.#options.named.get(current.key) : undefined
      if (entry && (entry.named.declaration === 'enum' || entry.named.declaration === 'alias')) {
        if (entry.state === 'pending') {
          this.#compute(entry)
        }
        if (entry.state === 'done' && isDistributable(entry.named.shape)) {
          visit(entry.named.shape, hops + 1)
          return
        }
      }
      const key = serializeShape(current)
      if (!found.has(key)) {
        found.set(key, current)
      }
    }
    visit(shape, 0)
    return [...found.values()]
  }

  /** The members of a union kept by `keep` (see `#unionMembers`); the shape itself when every member is kept. */
  #filterMembers(shape: Shape, keep: (member: Shape) => boolean): Shape {
    const members = this.#unionMembers(shape)
    const kept = members.filter(keep)
    return kept.length === members.length ? shape : union(kept)
  }

  #record(keys: Shape, value: Shape, node: Span, context: Context): Shape {
    const properties: ShapeProperty[] = []
    let additional: Shape | undefined
    for (const member of this.#unionMembers(keys)) {
      if (member.kind === 'never') {
        continue
      }
      if (member.kind === 'literal' && typeof member.value !== 'boolean') {
        properties.push({
          name: String(member.value),
          shape: value,
          optional: false,
          readonly: false,
          doc: undefined,
          location: undefined,
        })
      } else if (member.kind === 'string' || member.kind === 'number') {
        additional = value
      } else {
        return this.#opaqueAt(node, context, 'unsupported')
      }
    }
    return object(properties, additional)
  }

  #keyof(shape: Shape, node: Span, context: Context): Shape {
    const structure = this.#toObject(shape)
    if (!structure) {
      return this.#opaqueAt(node, context, 'type-operator')
    }
    const names = structure.properties.map(property => literal(property.name))
    return union(structure.additional === undefined ? names : [...names, keyword('string')])
  }

  #indexed(objectShape: Shape, index: Shape, node: Span, context: Context): Shape {
    if (index.kind === 'union' || index.kind === 'named') {
      const members = this.#unionMembers(index)
      if (members.length !== 1 || members[0] !== index) {
        return union(members.map(member => this.#indexed(objectShape, member, node, context)))
      }
    }
    if (objectShape.kind === 'array' && index.kind === 'number') {
      return objectShape.items
    }
    if (objectShape.kind === 'tuple') {
      if (index.kind === 'number') {
        return union(objectShape.rest === undefined ? objectShape.items : [...objectShape.items, objectShape.rest])
      }
      if (index.kind === 'literal' && typeof index.value === 'number') {
        const item = objectShape.items[index.value]
        if (item) {
          return item
        }
      }
    }
    const structure = this.#toObject(objectShape)
    if (structure) {
      if (index.kind === 'literal' && typeof index.value !== 'boolean') {
        const property = structure.properties.find(candidate => candidate.name === String(index.value))
        if (property) {
          return property.optional ? union([property.shape, keyword('undefined')]) : property.shape
        }
        if (structure.additional) {
          return structure.additional
        }
      }
      if ((index.kind === 'string' || index.kind === 'number') && structure.additional) {
        return structure.additional
      }
    }
    return this.#opaqueAt(node, context, 'indexed-access')
  }

  /** `{ [K in Keys]?: V }` over literal keys (or `string`), with `+`/`-` modifiers; homomorphic over `keyof T`. */
  #mapped(node: TSMappedType, context: Context): Shape {
    if (node.nameType) {
      return this.#opaqueAt(node, context, 'mapped')
    }
    const constraintNode = node.constraint
    let source: ObjectShape | undefined
    if (constraintNode.type === 'TSTypeOperator' && constraintNode.operator === 'keyof') {
      source = this.#toObject(this.#convert(constraintNode.typeAnnotation, context))
    }
    let members = this.#unionMembers(this.#convert(constraintNode, context))
    if (source) {
      const order = new Map(source.properties.map((property, index) => [property.name, index]))
      const rank = (member: Shape): number =>
        member.kind === 'literal' ? (order.get(String(member.value)) ?? order.size) : order.size + 1
      members = [...members].sort((a, b) => rank(a) - rank(b))
    }
    const properties: ShapeProperty[] = []
    let additional: Shape | undefined
    const keyName = node.key.name
    for (const member of members) {
      const params = new Map(context.params)
      params.set(keyName, member)
      const inner: Context = { ...context, params }
      const valueShape = node.typeAnnotation ? this.#convert(node.typeAnnotation, inner) : keyword('unknown')
      if (member.kind === 'literal' && typeof member.value !== 'boolean') {
        const name = String(member.value)
        const original = source?.properties.find(property => property.name === name)
        const { shape, undefinable } = withoutUndefined(valueShape)
        properties.push({
          name,
          shape,
          optional:
            node.optional !== '-' &&
            (node.optional === true || node.optional === '+' || original?.optional === true || undefinable),
          readonly:
            node.readonly === '-'
              ? false
              : node.readonly === true || node.readonly === '+' || (original?.readonly ?? false),
          doc: original?.doc,
          location: original?.location,
        })
      } else if (member.kind === 'string' || member.kind === 'number') {
        additional = valueShape
      } else if (member.kind !== 'never') {
        return this.#opaqueAt(node, context, 'mapped')
      }
    }
    return object(properties, additional)
  }

  // ------------------------------------------------------------- TypeInfo

  #fromTypeInfo(type: TypeInfo, sink: Sink, path: string, depth: number): Shape {
    const nested = (inner: TypeInfo, child = path): Shape => this.#fromTypeInfo(inner, sink, child, depth + 1)
    const context = { scope: undefined, sink, path }
    if (depth > MAX_DEPTH) {
      const shape = this.#opaque('', 'recursive')
      this.#issue(context, shape, undefined)
      return shape
    }
    switch (type.kind) {
      case 'primitive':
        switch (type.name) {
          case 'string':
          case 'number':
          case 'boolean':
          case 'null':
          case 'never':
            return keyword(type.name)
          case 'undefined':
          case 'void':
            return keyword('undefined')
          case 'any':
          case 'unknown':
            return keyword('unknown')
          case 'object':
            return object([], keyword('unknown'))
          case 'bigint':
            return this.#bigint(undefined, context)
          default: {
            const shape = this.#opaque(type.name, 'symbol')
            this.#issue(context, shape, undefined)
            return shape
          }
        }
      case 'literal':
        if (typeof type.value === 'bigint') {
          return this.#bigint(undefined, context, `${type.value}n`)
        }
        return literal(type.value)
      case 'array':
        return array(nested(type.element, join(path, '[]')))
      case 'tuple': {
        const items: Shape[] = []
        let rest: Shape | undefined
        let minItems = 0
        for (const [index, element] of type.elements.entries()) {
          const shape = nested(element.type, join(path, `[${index}]`))
          if (element.rest) {
            rest = shape.kind === 'array' ? shape.items : shape
          } else {
            items.push(shape)
            if (!element.optional && minItems === items.length - 1) {
              minItems = items.length
            }
          }
        }
        return rest === undefined ? { kind: 'tuple', items, minItems } : { kind: 'tuple', items, rest, minItems }
      }
      case 'union':
        return union(type.types.map(member => nested(member)))
      case 'intersection':
        return intersection(
          type.types.map(member => nested(member)),
          shape => this.#toObject(shape),
        )
      case 'promise': {
        const shape = this.#opaque('Promise', 'non-json')
        this.#issue(context, shape, undefined)
        return shape
      }
      case 'typeParameter': {
        const shape = this.#opaque(type.name, 'type-parameter')
        this.#issue(context, shape, undefined)
        return shape
      }
      case 'opaque': {
        const shape = this.#opaque(type.text, opaqueReasonOf(type.reason))
        this.#issue(context, shape, undefined)
        return shape
      }
      case 'reference':
        return this.#referenceInfo(type, sink, path, depth)
    }
  }

  #referenceInfo(type: Extract<TypeInfo, { kind: 'reference' }>, sink: Sink, path: string, depth: number): Shape {
    const args = type.typeArgs.map((arg, index) => this.#fromTypeInfo(arg, sink, join(path, `<${index}>`), depth + 1))
    const context = { scope: undefined, sink, path }
    if (this.#options.keep.has(type.identity)) {
      return this.#kept(type.identity, type.name, args, args.length)
    }
    if (type.identity.startsWith(GLOBAL_IDENTITY_PREFIX)) {
      const name = type.identity.slice(GLOBAL_IDENTITY_PREFIX.length)
      switch (name) {
        case 'Date':
          return keyword('date')
        case 'URL':
          return keyword('url')
        default: {
          if (BINARY_GLOBALS.has(name)) {
            return keyword('binary')
          }
          const shape = this.#opaque(name, globalReason(name))
          this.#issue(context, shape, undefined)
          return shape
        }
      }
    }
    if (BINARY_EXTERNALS.has(type.identity)) {
      return keyword('binary')
    }
    const symbol = this.#project.lookupIdentity(type.identity)
    const declaration =
      symbol.kind === 'declaration'
        ? symbol.declarations.find(candidate => declarationKind(candidate) !== undefined)
        : undefined
    if (!declaration) {
      const shape = this.#opaque(type.name, 'unresolved')
      this.#issue(context, shape, undefined)
      return shape
    }
    const file = this.#project.getFile(declaration.file)
    if (!file) {
      const shape = this.#opaque(type.name, 'unresolved')
      this.#issue(context, shape, undefined)
      return shape
    }
    return this.#named(declaration, args, {
      scope: { file, namespace: declaration.namespace },
      params: new Map(),
      sink,
      path,
      depth,
    })
  }

  // ------------------------------------------------------------- issues

  /** A `bigint` shape (its own object: it carries an issue). */
  #bigint(node: Span | undefined, context: IssueContext, text = 'bigint'): Shape {
    const shape: Shape = { kind: 'bigint' }
    this.#issueReason(context, shape, 'bigint', node && context.scope ? context.scope.file.textOf(node) : text, node)
    return shape
  }

  #opaque(text: string, reason: ShapeOpaqueReason): Shape {
    return { kind: 'opaque', text: text.replace(/\s+/g, ' ').trim(), reason }
  }

  #opaqueAt(node: Span, context: Context, reason: ShapeOpaqueReason): Shape {
    const shape = this.#opaque(context.scope.file.textOf(node), reason)
    this.#issue(context, shape, node)
    return shape
  }

  #issue(context: IssueContext, shape: Shape, node: Span | undefined): void {
    if (shape.kind === 'opaque') {
      this.#issueReason(context, shape, shape.reason, shape.text, node)
    }
  }

  #issueReason(
    context: IssueContext,
    shape: Shape,
    reason: ShapeIssue['reason'],
    text: string,
    node: Span | undefined,
  ): void {
    const location: Location | undefined = node && context.scope ? context.scope.file.location(node) : undefined
    ISSUES.set(shape, { reason, path: context.path, named: context.sink.named, text, location })
  }
}

// --------------------------------------------------------------- helpers

function at(context: Context, segment: string): Context {
  return { ...context, path: join(context.path, segment) }
}

function join(path: string, segment: string): string {
  if (segment.startsWith('[') || segment.startsWith('<')) {
    return `${path}${segment}`
  }
  const name = /^[A-Za-z_$][\w$]*$/.test(segment) ? segment : JSON.stringify(segment)
  if (path === '') {
    return name
  }
  return name.startsWith('"') ? `${path}[${name}]` : `${path}.${name}`
}

/** Sorted issues of a named shape (memoized: an entry is immutable once computed). */
/**
 * Named shapes referenced by shapes (sorted) and the issues of their opaque and bigint parts
 * (sorted), named shapes being references (their own structure is not walked).
 */
function walkShapes(shapes: readonly Shape[]): { readonly refs: string[]; readonly issues: ShapeIssue[] } {
  const refs = new Set<string>()
  const issues = new Set<ShapeIssue>()
  const seen = new Set<Shape>()
  const visit = (shape: Shape): void => {
    if (seen.has(shape)) {
      return
    }
    seen.add(shape)
    const issue = ISSUES.get(shape)
    if (issue) {
      issues.add(issue)
    }
    switch (shape.kind) {
      case 'named':
        refs.add(shape.key)
        return
      case 'array':
        visit(shape.items)
        return
      case 'tuple':
        shape.items.forEach(visit)
        if (shape.rest) {
          visit(shape.rest)
        }
        return
      case 'object':
        for (const property of shape.properties) {
          visit(property.shape)
        }
        if (shape.additional) {
          visit(shape.additional)
        }
        return
      case 'union':
      case 'intersection':
        shape.members.forEach(visit)
        return
      case 'reference':
        shape.typeArgs.forEach(visit)
        return
      default:
        return
    }
  }
  shapes.forEach(visit)
  return { refs: [...refs].sort(compareStrings), issues: sortIssues([...issues]) }
}

/** The named shapes of sorted keys. */
function namedMap(keys: readonly string[], cache: Cache): ReadonlyMap<string, NamedShape> {
  const named = new Map<string, NamedShape>()
  for (const key of keys) {
    const entry = cache.named.get(key)
    if (entry) {
      named.set(key, entry.named)
    }
  }
  return named
}

/** An alias whose body is a reference or a `typeof` may be a schema or a kept reference (transparent). */
function mayBeTransparent(declaration: Declaration): boolean {
  let body = (declaration.node as TSTypeAliasDeclaration).typeAnnotation
  while (body.type === 'TSParenthesizedType') {
    body = body.typeAnnotation
  }
  return body.type === 'TSTypeReference' || body.type === 'TSTypeQuery'
}

/** `true` when `target` is a strict sub-shape of `shape` (`string` in `string[]`). */
function containsStrictly(shape: Shape, target: Shape): boolean {
  const key = serializeShape(target)
  const visit = (current: Shape, root: boolean): boolean => {
    if (!root && serializeShape(current) === key) {
      return true
    }
    switch (current.kind) {
      case 'array':
        return visit(current.items, false)
      case 'tuple':
        return (
          current.items.some(item => visit(item, false)) || (current.rest !== undefined && visit(current.rest, false))
        )
      case 'object':
        return (
          current.properties.some(property => visit(property.shape, false)) ||
          (current.additional !== undefined && visit(current.additional, false))
        )
      case 'union':
      case 'intersection':
        return current.members.some(member => visit(member, false))
      case 'reference':
        return current.typeArgs.some(arg => visit(arg, false))
      default:
        return false
    }
  }
  return visit(shape, true)
}

/** Why a global type other than the known ones has no shape. */
function globalReason(name: string): ShapeOpaqueReason {
  if (FUNCTION_GLOBALS.has(name)) {
    return 'function'
  }
  return NON_JSON_GLOBALS.has(name) ? 'non-json' : 'unsupported'
}

function declarationKind(declaration: Declaration): NamedShape['declaration'] | undefined {
  switch (declaration.kind) {
    case 'type':
      return 'alias'
    case 'interface':
    case 'class':
    case 'enum':
      return declaration.kind
    default:
      return undefined
  }
}

function typeParameterNodes(declaration: Declaration): readonly TSTypeParameter[] {
  if (declaration.kind !== 'class' && declaration.kind !== 'interface' && declaration.kind !== 'type') {
    return []
  }
  const node = declaration.node as Class | TSInterfaceDeclaration | TSTypeAliasDeclaration
  return node.typeParameters?.params ?? []
}

function propertyName(key: PropertyKey, computed: boolean): string | undefined {
  if (key.type === 'PrivateIdentifier') {
    return undefined
  }
  if (key.type === 'Identifier' && !computed) {
    return key.name
  }
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value)
  }
  return undefined
}

/** Names of union members that are string/number literals (`Pick`/`Omit` keys), `undefined` otherwise. */
function literalKeys(members: readonly Shape[]): Set<string> | undefined {
  const keys = new Set<string>()
  for (const member of members) {
    if (member.kind === 'literal' && typeof member.value !== 'boolean') {
      keys.add(String(member.value))
    } else if (member.kind !== 'never') {
      return undefined
    }
  }
  return keys
}

/**
 * A named shape whose structure `#unionMembers` distributes over: a union, a literal or a
 * primitive (not an object, which keeps its name).
 */
function isDistributable(shape: Shape): boolean {
  switch (shape.kind) {
    case 'union':
    case 'literal':
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'undefined':
    case 'never':
    case 'named':
      return true
    default:
      return false
  }
}

/**
 * Whether a member is assignable to `U` of `Exclude<T, U>` / `Extract<T, U>` (structural equality,
 * literals of a primitive).
 */
function unionMatcher(filters: readonly Shape[]): (member: Shape) => boolean {
  const keys = new Set(filters.map(serializeShape))
  const kinds = new Set(filters.map(member => member.kind))
  return member =>
    keys.has(serializeShape(member)) ||
    kinds.has('unknown') ||
    (member.kind === 'literal' && kinds.has(typeof member.value as Shape['kind']))
}

function displayShape(shape: Shape, cache: Cache): string {
  switch (shape.kind) {
    case 'literal':
      return JSON.stringify(shape.value)
    case 'array':
      return `${displayShape(shape.items, cache)}[]`
    case 'named': {
      const entry = cache.named.get(shape.key)
      return entry ? entry.named.name : shape.key
    }
    case 'union':
      return shape.members.map(member => displayShape(member, cache)).join(' | ')
    case 'intersection':
      return shape.members.map(member => displayShape(member, cache)).join(' & ')
    case 'object':
      return '{...}'
    case 'tuple':
      return `[${shape.items.map(member => displayShape(member, cache)).join(', ')}]`
    case 'schema':
      return `typeof ${shape.ref.text}`
    case 'reference':
      return shape.name
    case 'opaque':
      return shape.text
    default:
      return shape.kind
  }
}

function opaqueReasonOf(reason: Extract<TypeInfo, { kind: 'opaque' }>['reason']): ShapeOpaqueReason {
  switch (reason) {
    case 'function':
    case 'constructor':
      return 'function'
    case 'mapped':
    case 'conditional':
    case 'typeof':
    case 'indexed-access':
    case 'this':
    case 'missing-annotation':
      return reason
    case 'type-operator':
      return 'type-operator'
    case 'recursive-alias':
      return 'recursive'
    case 'unresolved':
    case 'not-a-type':
      return 'unresolved'
    default:
      return 'unsupported'
  }
}

function recordEntries(
  record: Readonly<Record<string, 'input' | 'output'>> | undefined,
  what: string,
): [string, 'input' | 'output'][] {
  if (record === undefined) {
    return []
  }
  if (typeof record !== 'object' || record === null) {
    throw new TypeError(`[znight] types.shape(): ${what} must be an object`)
  }
  const entries = Object.entries(record).sort(([a], [b]) => compareStrings(a, b))
  for (const [key, io] of entries) {
    if (io !== 'input' && io !== 'output') {
      throw new TypeError(`[znight] types.shape(): ${what}['${key}'] must be 'input' or 'output'`)
    }
  }
  return entries
}

/** Issues sorted (named shape, path, text, position) and de-duplicated. */
function sortIssues(issues: readonly ShapeIssue[]): ShapeIssue[] {
  return dedupeIssues(
    [...issues].sort(
      (a, b) =>
        compareStrings(a.named ?? '', b.named ?? '') ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.text, b.text) ||
        compareStrings(a.reason, b.reason) ||
        (a.location?.start ?? 0) - (b.location?.start ?? 0),
    ),
  )
}

function dedupeIssues(issues: readonly ShapeIssue[]): ShapeIssue[] {
  const seen = new Set<string>()
  return issues.filter(issue => {
    const key = `${issue.named ?? ''}\u0000${issue.path}\u0000${issue.reason}\u0000${issue.text}\u0000${issue.location?.start ?? ''}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression'
  ) {
    current = current.expression
  }
  return current
}
