/**
 * Conversion of oxc TypeScript type annotations into {@link TypeInfo} (§4.4).
 *
 * Type references are resolved through imports, barrels, namespaces and packages to canonical
 * identities; type aliases are expanded with their type arguments substituted; default type
 * arguments are filled from the declaration. Aliases supplied at runtime (manifest `provides`,
 * `options.externals`: `RequestId = string & {...}`) are expanded too, unless
 * {@link ResolveTypeOptions.externalAliases} keeps them as references (injection points).
 */
import type {
  Class,
  TSInterfaceDeclaration,
  TSTupleElement,
  TSType,
  TSTypeAliasDeclaration,
  TSTypeAnnotation,
  TSTypeParameter,
  TSTypeParameterDeclaration,
} from 'oxc-parser'
import type { Declaration } from './facts.ts'
import type { ProjectHost } from './host.ts'
import type { IdentityResolver } from './identity.ts'
import type { Span } from './location.ts'
import type { ScopeRef, SymbolResolution, SymbolResolver } from './symbols.ts'
import type { OpaqueReason, TupleElement, TypeInfo } from './types.ts'

import { GLOBAL_IDENTITY_PREFIX } from './identity.ts'
import { declarationKey } from './symbols.ts'
import {
  arrayType,
  intersectionType,
  literalType,
  opaqueType,
  primitiveType,
  promiseType,
  referenceType,
  tupleType,
  typeParameterType,
  unionType,
} from './types.ts'

/** Bindings of type parameter names in scope (an unbound parameter maps to a `typeParameter` type). */
export type TypeScope = ReadonlyMap<string, TypeInfo>

/** A type parameter of a declaration, resolved in the declaration's scope. */
export interface TypeParameterInfo {
  readonly name: string
  readonly constraint: TypeInfo | undefined
  readonly default: TypeInfo | undefined
}

/** One `extends` / `implements` clause of a class or interface. */
export interface HeritageClause {
  readonly relation: 'extends' | 'implements'
  /** What the heritage expression resolves to. */
  readonly symbol: SymbolResolution
  /**
   * The referenced type with its type arguments, expressed with the declaration's own type
   * parameters left unbound (substitute them with `substituteType`). Opaque when the clause
   * cannot be analysed (`extends Mixin(Base)`).
   */
  readonly type: TypeInfo
  readonly span: Span
}

/** Options of {@link TypeResolver.resolveType}. */
export interface ResolveTypeOptions {
  /**
   * Aliases supplied at runtime (declared in a manifest `provides` or in `options.externals`):
   * `'expand'` (default) like any alias (`RequestId` → `string & {...}`: what a value of that type
   * is), `'keep'` as a reference to the alias identity (`@znight/http#RequestId`: the token an
   * injection point binds to).
   */
  readonly externalAliases?: 'expand' | 'keep'
  /** Called with the identity of every alias supplied at runtime that was expanded. */
  readonly onExternalAlias?: (identity: string) => void
}

interface Context {
  readonly scope: ScopeRef
  readonly types: TypeScope
  /** Aliases being expanded (cycle guard). */
  readonly aliases: ReadonlySet<string>
  /** Aliases found to be recursive during this conversion (shared by nested contexts). */
  readonly recursive: Set<string>
  readonly depth: number
  /** Handling of the aliases supplied at runtime (shared by nested contexts). */
  readonly externals: ResolveTypeOptions
}

type GenericDeclarationNode = Class | TSInterfaceDeclaration | TSTypeAliasDeclaration

const MAX_DEPTH = 64
const EMPTY_SCOPE: TypeScope = new Map()
const NO_OPTIONS: ResolveTypeOptions = {}

/**
 * Adds type parameters (as unbound parameters) to a scope, e.g. those of a generic method:
 * `withTypeParameters(project.typeScopeOf(classDeclaration), method.value.typeParameters)`.
 */
export function withTypeParameters(
  scope: TypeScope,
  parameters: TSTypeParameterDeclaration | readonly TSTypeParameter[] | null | undefined,
): TypeScope {
  let list: readonly TSTypeParameter[] = []
  if (parameters) {
    list = 'params' in parameters ? parameters.params : parameters
  }
  if (list.length === 0) {
    return scope
  }
  const extended = new Map(scope)
  for (const parameter of list) {
    extended.set(parameter.name.name, typeParameterType(parameter.name.name))
  }
  return extended
}

/** Converts type annotations to {@link TypeInfo}. Stateless apart from the shared resolvers. */
export class TypeResolver {
  readonly #host: ProjectHost
  readonly #symbols: SymbolResolver
  readonly #identities: IdentityResolver

  constructor(host: ProjectHost, symbols: SymbolResolver, identities: IdentityResolver) {
    this.#host = host
    this.#symbols = symbols
    this.#identities = identities
  }

  /**
   * Converts a type annotation. A missing annotation gives an opaque type with reason
   * `missing-annotation`.
   *
   * @param scope file (and enclosing namespace) where the annotation appears
   * @param types type parameters in scope (e.g. {@link typeScopeOf} of the enclosing class)
   */
  resolveType(
    scope: ScopeRef,
    node: TSType | TSTypeAnnotation | null | undefined,
    types: TypeScope = EMPTY_SCOPE,
    options: ResolveTypeOptions = {},
  ): TypeInfo {
    if (!node) {
      return opaqueType('', 'missing-annotation')
    }
    const type = node.type === 'TSTypeAnnotation' ? node.typeAnnotation : node
    return this.#convert(type, {
      scope,
      types,
      aliases: new Set(),
      recursive: new Set(),
      depth: 0,
      externals: options,
    })
  }

  /** Type parameters of a class, interface or type alias (constraints/defaults resolved). */
  typeParametersOf(declaration: Declaration): TypeParameterInfo[] {
    const parameters = this.#typeParameterNodes(declaration)
    const file = this.#host.getFile(declaration.file)
    if (!file || parameters.length === 0) {
      return []
    }
    const scope: ScopeRef = { file, namespace: declaration.namespace }
    const context: Context = {
      scope,
      types: withTypeParameters(EMPTY_SCOPE, parameters),
      aliases: new Set(),
      recursive: new Set(),
      depth: 0,
      externals: NO_OPTIONS,
    }
    return parameters.map(parameter => ({
      name: parameter.name.name,
      constraint: parameter.constraint ? this.#convert(parameter.constraint, context) : undefined,
      default: parameter.default ? this.#convert(parameter.default, context) : undefined,
    }))
  }

  /** Scope binding the declaration's own type parameters as unbound parameters. */
  typeScopeOf(declaration: Declaration): TypeScope {
    const parameters = this.#typeParameterNodes(declaration)
    if (parameters.length === 0) {
      return EMPTY_SCOPE
    }
    return withTypeParameters(EMPTY_SCOPE, parameters)
  }

  /**
   * Binds the type parameters of a generic declaration to type arguments, filling missing
   * arguments with the declared defaults (which may refer to earlier parameters) or `unknown`.
   */
  bindTypeArguments(declaration: Declaration, typeArgs: readonly TypeInfo[]): Map<string, TypeInfo> {
    return this.#bind(declaration, typeArgs, 0)
  }

  /** `extends`/`implements` clauses of a class or interface declaration. */
  heritageOf(declaration: Declaration): HeritageClause[] {
    const file = this.#host.getFile(declaration.file)
    if (!file || (declaration.kind !== 'class' && declaration.kind !== 'interface')) {
      return []
    }
    const scope: ScopeRef = { file, namespace: declaration.namespace }
    const context: Context = {
      scope,
      types: this.typeScopeOf(declaration),
      aliases: new Set(),
      recursive: new Set(),
      depth: 0,
      externals: NO_OPTIONS,
    }
    const clauses: HeritageClause[] = []
    if (declaration.kind === 'class') {
      const node = declaration.node as Class
      if (node.superClass) {
        const symbol = this.#symbols.resolveEntity(scope, node.superClass, 'value')
        const type =
          symbol.kind === 'unresolved' && symbol.reason === 'unsupported-expression'
            ? opaqueType(file.textOf(node.superClass), 'unsupported')
            : this.#fromSymbol(symbol, node.superTypeArguments?.params ?? [], file.textOf(node.superClass), context)
        clauses.push({
          relation: 'extends',
          symbol,
          type,
          span: { start: node.superClass.start, end: node.superClass.end },
        })
      }
      for (const clause of node.implements ?? []) {
        const symbol = this.#symbols.resolveEntity(scope, clause.expression, 'type')
        clauses.push({
          relation: 'implements',
          symbol,
          type: this.#fromSymbol(symbol, clause.typeArguments?.params ?? [], file.textOf(clause.expression), context),
          span: { start: clause.start, end: clause.end },
        })
      }
    } else {
      const node = declaration.node as TSInterfaceDeclaration
      for (const clause of node.extends) {
        const symbol = this.#symbols.resolveEntity(scope, clause.expression, 'type')
        clauses.push({
          relation: 'extends',
          symbol,
          type: this.#fromSymbol(symbol, clause.typeArguments?.params ?? [], file.textOf(clause.expression), context),
          span: { start: clause.start, end: clause.end },
        })
      }
    }
    return clauses
  }

  #convert(node: TSType, context: Context): TypeInfo {
    if (context.depth > MAX_DEPTH) {
      return this.#opaque(node, context, 'recursive-alias')
    }
    switch (node.type) {
      case 'TSAnyKeyword':
        return primitiveType('any')
      case 'TSUnknownKeyword':
        return primitiveType('unknown')
      case 'TSNeverKeyword':
        return primitiveType('never')
      case 'TSStringKeyword':
        return primitiveType('string')
      case 'TSNumberKeyword':
        return primitiveType('number')
      case 'TSBooleanKeyword':
        return primitiveType('boolean')
      case 'TSBigIntKeyword':
        return primitiveType('bigint')
      case 'TSSymbolKeyword':
        return primitiveType('symbol')
      case 'TSNullKeyword':
        return primitiveType('null')
      case 'TSUndefinedKeyword':
        return primitiveType('undefined')
      case 'TSVoidKeyword':
        return primitiveType('void')
      case 'TSObjectKeyword':
        return primitiveType('object')
      case 'TSLiteralType':
        return this.#literal(node, context)
      case 'TSTemplateLiteralType':
        return node.types.length === 0 && node.quasis.length === 1
          ? literalType(node.quasis[0]?.value.cooked ?? '')
          : this.#opaque(node, context, 'template-literal')
      case 'TSArrayType':
        return arrayType(this.#convert(node.elementType, context))
      case 'TSTypeOperator':
        return node.operator === 'readonly'
          ? this.#convert(node.typeAnnotation, context)
          : this.#opaque(node, context, 'type-operator')
      case 'TSTupleType':
        return tupleType(node.elementTypes.map(element => this.#tupleElement(element, context, false)))
      case 'TSUnionType':
        return unionType(node.types.map(member => this.#convert(member, context)))
      case 'TSIntersectionType':
        return intersectionType(node.types.map(member => this.#convert(member, context)))
      case 'TSParenthesizedType':
        return this.#convert(node.typeAnnotation, context)
      case 'TSNamedTupleMember':
        return this.#tupleElement(node, context, false).type
      case 'TSTypeReference': {
        const name = node.typeName
        if (name.type === 'Identifier') {
          const bound = context.types.get(name.name)
          if (bound) {
            return bound
          }
        }
        if (name.type === 'ThisExpression') {
          return this.#opaque(node, context, 'this')
        }
        const symbol = this.#symbols.resolveEntity(context.scope, name, 'type')
        return this.#fromSymbol(symbol, node.typeArguments?.params ?? [], context.scope.file.textOf(node), context)
      }
      case 'TSThisType':
        return this.#opaque(node, context, 'this')
      case 'TSTypeQuery':
        return this.#opaque(node, context, 'typeof')
      case 'TSImportType':
        return this.#opaque(node, context, 'import-type')
      case 'TSFunctionType':
        return this.#opaque(node, context, 'function')
      case 'TSConstructorType':
        return this.#opaque(node, context, 'constructor')
      case 'TSTypeLiteral':
        return this.#opaque(node, context, 'object-literal')
      case 'TSMappedType':
        return this.#opaque(node, context, 'mapped')
      case 'TSConditionalType':
        return this.#opaque(node, context, 'conditional')
      case 'TSIndexedAccessType':
        return this.#opaque(node, context, 'indexed-access')
      case 'TSInferType':
        return this.#opaque(node, context, 'infer')
      case 'TSTypePredicate':
        return this.#opaque(node, context, 'predicate')
      case 'TSIntrinsicKeyword':
        return this.#opaque(node, context, 'intrinsic')
      default:
        return this.#opaque(node, context, 'unsupported')
    }
  }

  #literal(node: Extract<TSType, { type: 'TSLiteralType' }>, context: Context): TypeInfo {
    const literal = node.literal
    switch (literal.type) {
      case 'Literal':
        if ('bigint' in literal && typeof literal.bigint === 'string') {
          return literalType(BigInt(literal.bigint))
        }
        if (
          typeof literal.value === 'string' ||
          typeof literal.value === 'number' ||
          typeof literal.value === 'boolean'
        ) {
          return literalType(literal.value)
        }
        return this.#opaque(node, context, 'unsupported')
      case 'UnaryExpression': {
        const argument = literal.argument
        if (literal.operator === '-' && argument.type === 'Literal') {
          if ('bigint' in argument && typeof argument.bigint === 'string') {
            return literalType(-BigInt(argument.bigint))
          }
          if (typeof argument.value === 'number') {
            return literalType(-argument.value)
          }
        }
        return this.#opaque(node, context, 'unsupported')
      }
      case 'TemplateLiteral':
        return literal.expressions.length === 0 && literal.quasis.length === 1
          ? literalType(literal.quasis[0]?.value.cooked ?? '')
          : this.#opaque(node, context, 'template-literal')
      default:
        return this.#opaque(node, context, 'unsupported')
    }
  }

  #tupleElement(element: TSTupleElement, context: Context, optional: boolean): TupleElement {
    switch (element.type) {
      case 'TSOptionalType':
        return { type: this.#convert(element.typeAnnotation, context), optional: true, rest: false }
      case 'TSRestType':
        return { type: this.#convert(element.typeAnnotation, context), optional: false, rest: true }
      case 'TSNamedTupleMember': {
        const inner = this.#tupleElement(element.elementType, context, element.optional)
        return { ...inner, optional: inner.optional || element.optional }
      }
      default:
        return { type: this.#convert(element, context), optional, rest: false }
    }
  }

  #fromSymbol(symbol: SymbolResolution, argNodes: readonly TSType[], text: string, context: Context): TypeInfo {
    const args = (): TypeInfo[] => argNodes.map(arg => this.#convert(arg, context))
    switch (symbol.kind) {
      case 'global': {
        const typeArgs = args()
        if ((symbol.name === 'Array' || symbol.name === 'ReadonlyArray') && typeArgs.length === 1) {
          return arrayType(typeArgs[0] as TypeInfo)
        }
        if (symbol.name === 'Promise' && typeArgs.length === 1) {
          return promiseType(typeArgs[0] as TypeInfo)
        }
        return referenceType(`${GLOBAL_IDENTITY_PREFIX}${symbol.name}`, symbol.name, typeArgs)
      }
      case 'external': {
        const info = this.#identities.identityOf(symbol)
        return info ? referenceType(info.identity, info.displayName, args()) : opaqueType(text, 'not-a-type')
      }
      case 'declaration': {
        const declaration = symbol.declaration
        switch (declaration.kind) {
          case 'type': {
            // A type alias supplied at runtime (manifest `provides`, `options.externals`, e.g.
            // `RequestId = string & {...}`): an injection point keeps its identity (its token).
            const info = this.#identities.identityOfDeclaration(declaration)
            if (this.#isExternal(info.identity, declaration.file)) {
              if (context.externals.externalAliases === 'keep') {
                const bindings = this.#bind(declaration, args(), context.depth + 1)
                return referenceType(info.identity, info.displayName, [...bindings.values()])
              }
              context.externals.onExternalAlias?.(info.identity)
            }
            return this.#expandAlias(declaration, args(), text, context)
          }
          case 'class':
          case 'interface':
          case 'enum': {
            const info = this.#identities.identityOfDeclaration(declaration)
            const bindings = this.#bind(declaration, args(), context.depth + 1)
            return referenceType(info.identity, info.displayName, [...bindings.values()])
          }
          default:
            return opaqueType(text, 'not-a-type')
        }
      }
      case 'unresolved':
        return opaqueType(text, 'unresolved')
      default:
        return opaqueType(text, 'not-a-type')
    }
  }

  /** `true` when `identity` is declared in `options.externals` or in the manifest `provides` of its package. */
  #isExternal(identity: string, file: string): boolean {
    if (this.#host.options.externals.includes(identity)) {
      return true
    }
    const owner = this.#host.packages.ownerOf(file)
    return (
      owner.kind === 'package' &&
      this.#host.manifestOf(owner.package)?.provides.some(entry => entry.identity === identity) === true
    )
  }

  #expandAlias(declaration: Declaration, typeArgs: readonly TypeInfo[], text: string, context: Context): TypeInfo {
    const key = declarationKey(declaration)
    const file = this.#host.getFile(declaration.file)
    if (!file || context.aliases.has(key) || context.depth >= MAX_DEPTH) {
      context.recursive.add(key)
      return opaqueType(text, 'recursive-alias')
    }
    const node = declaration.node as TSTypeAliasDeclaration
    const bindings = this.#bind(declaration, typeArgs, context.depth + 1)
    const expanded = this.#convert(node.typeAnnotation, {
      scope: { file, namespace: declaration.namespace },
      types: bindings,
      aliases: new Set([...context.aliases, key]),
      recursive: context.recursive,
      depth: context.depth + 1,
      externals: context.externals,
    })
    // A recursive alias (`type Json = string | Json[]`) cannot be expanded: it is opaque as a whole.
    return context.recursive.has(key) ? opaqueType(text, 'recursive-alias') : expanded
  }

  #bind(declaration: Declaration, typeArgs: readonly TypeInfo[], depth: number): Map<string, TypeInfo> {
    const parameters = this.#typeParameterNodes(declaration)
    const bindings = new Map<string, TypeInfo>()
    if (parameters.length === 0) {
      return bindings
    }
    const file = this.#host.getFile(declaration.file)
    for (const [index, parameter] of parameters.entries()) {
      let type = typeArgs[index]
      if (type === undefined) {
        type =
          parameter.default && file && depth < MAX_DEPTH
            ? this.#convert(parameter.default, {
                scope: { file, namespace: declaration.namespace },
                types: new Map(bindings),
                aliases: new Set(),
                recursive: new Set(),
                depth: depth + 1,
                externals: NO_OPTIONS,
              })
            : primitiveType('unknown')
      }
      bindings.set(parameter.name.name, type)
    }
    return bindings
  }

  #typeParameterNodes(declaration: Declaration): readonly TSTypeParameter[] {
    if (declaration.kind !== 'class' && declaration.kind !== 'interface' && declaration.kind !== 'type') {
      return []
    }
    const node = declaration.node as GenericDeclarationNode
    return node.typeParameters?.params ?? []
  }

  #opaque(node: TSType, context: Context, reason: OpaqueReason): TypeInfo {
    return opaqueType(context.scope.file.textOf(node), reason)
  }
}
