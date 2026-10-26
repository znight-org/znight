/**
 * Class analysis (§4.5, §6.5): builds {@link ClassInfo} — decorators with evaluated arguments,
 * constructor resolved through the `extends` chain with type-argument substitution, methods,
 * properties, heritage closure and lifecycle hooks. Results are memoized for one compile.
 */
import type {
  AccessorProperty,
  Class,
  Function as FunctionNode,
  MethodDefinition,
  ParamPattern,
  PropertyDefinition,
  TSTypeAnnotation,
} from 'oxc-parser'
import type {
  ArgInfo,
  ClassInfo,
  ConstructorInfo,
  DecoratorTarget,
  LifecycleHookInfo,
  MethodInfo,
  ParameterInfo,
  PropertyInfo,
} from '../extensions/api.ts'
import type {
  Declaration,
  Project,
  ReferenceType,
  ScopeRef,
  SourceFile,
  SymbolResolution,
  TypeInfo,
  TypeScope,
} from '../project/index.ts'
import type { DecoratorReader } from './decorators.ts'

import { compareStrings } from '../project/compare.ts'
import {
  declarationKey,
  namespaceFacts,
  relativePath,
  serializeType,
  substituteType,
  withTypeParameters,
} from '../project/index.ts'
import { evaluateArgument } from './arguments.ts'
import { memberName, visibilityOf } from './ast.ts'
import { LIFECYCLE_MEMBERS } from './core-decorators.ts'

const MAX_HERITAGE_DEPTH = 32
const EMPTY_BINDINGS: ReadonlyMap<string, TypeInfo> = new Map()

type ClassMember = Class['body']['body'][number]

/** Builds and memoizes {@link ClassInfo}s. */
export class ClassAnalyzer {
  readonly #project: Project
  readonly #reader: DecoratorReader
  readonly #infos = new Map<string, ClassInfo>()
  readonly #bases = new Map<string, Declaration | null>()
  readonly #heritage = new Map<string, readonly ReferenceType[]>()
  readonly #inProgress = new Set<string>()
  /** Parameters whose annotation names an alias supplied at runtime: their injection type. */
  readonly #injectionTypes = new WeakMap<ParameterInfo, TypeInfo>()

  constructor(project: Project, reader: DecoratorReader) {
    this.#project = project
    this.#reader = reader
  }

  /** Every class built so far. */
  infos(): ClassInfo[] {
    return [...this.#infos.values()]
  }

  /** Analysis of a class declaration (memoized). */
  infoOf(declaration: Declaration): ClassInfo {
    const key = declarationKey(declaration)
    const cached = this.#infos.get(key)
    if (cached) {
      return cached
    }
    this.#inProgress.add(key)
    try {
      const info = this.#build(declaration)
      this.#infos.set(key, info)
      return info
    } finally {
      this.#inProgress.delete(key)
    }
  }

  /** Analysis of the class named by an identity, when it is an analysable class. */
  infoOfIdentity(identity: string): ClassInfo | undefined {
    const symbol = this.#project.lookupIdentity(identity)
    if (symbol.kind !== 'declaration') {
      return undefined
    }
    const declaration = symbol.declarations.find(candidate => candidate.kind === 'class')
    return declaration ? this.infoOf(declaration) : undefined
  }

  /** The analysable base class of a class (`extends`), if any. */
  baseOf(info: ClassInfo): ClassInfo | undefined {
    const base = this.#baseDeclaration(info.declaration)
    if (!base || this.#inProgress.has(declarationKey(base))) {
      return undefined
    }
    return this.infoOf(base)
  }

  /**
   * Heritage closure of a referenced class or interface with its type arguments bound
   * (`Repository<User>` → its `extends` closure). Empty for other types.
   */
  heritageOfType(type: ReferenceType): readonly ReferenceType[] {
    const symbol = this.#project.lookupIdentity(type.identity)
    if (symbol.kind !== 'declaration') {
      return []
    }
    const declaration = symbol.declarations.find(
      candidate => candidate.kind === 'class' || candidate.kind === 'interface',
    )
    if (!declaration) {
      return []
    }
    return this.#closure(declaration, this.#project.bindTypeArguments(declaration, type.typeArgs))
  }

  /** Heritage closure of a class or interface declaration (own type parameters unbound). */
  heritageOf(declaration: Declaration): readonly ReferenceType[] {
    return this.#closure(declaration, EMPTY_BINDINGS)
  }

  /**
   * Type a parameter is injected as: its type, except that the aliases supplied at runtime (manifest
   * `provides`, `options.externals`) stay references to their identity (`@znight/http#RequestId`
   * rather than `string & {...}`), so that the parameter binds to the external. Extensions keep
   * seeing the expanded type (`ParameterInfo.type`: what the value is).
   */
  injectionTypeOf(param: ParameterInfo): TypeInfo {
    return this.#injectionTypes.get(param) ?? param.type
  }

  /** Lifecycle hooks of the class named by an identity (for `@Provides` values). */
  lifecycleOfIdentity(identity: string): readonly LifecycleHookInfo[] {
    return this.infoOfIdentity(identity)?.lifecycle ?? []
  }

  // ------------------------------------------------------------------ build

  #build(declaration: Declaration): ClassInfo {
    const project = this.#project
    const file = project.getFile(declaration.file)
    if (!file) {
      throw new Error(`[znight] cannot read ${declaration.file}`)
    }
    const node = declaration.node as Class
    const scope: ScopeRef = { file, namespace: declaration.namespace }
    const typeScope = project.typeScopeOf(declaration)
    const identity = project.identities.identityOfDeclaration(declaration)
    const route = project.importRoute(declaration)
    const decorators = this.#reader.read(scope, node.decorators, 'class')

    const methods: MethodInfo[] = []
    const properties: PropertyInfo[] = []
    const ambient = declaration.ambient || file.isDeclarationFile
    for (const member of node.body.body) {
      if (member.type === 'MethodDefinition' || member.type === 'TSAbstractMethodDefinition') {
        if (member.kind === 'constructor') {
          continue
        }
        if (member.type === 'MethodDefinition' && member.value.type === 'TSEmptyBodyFunctionExpression' && !ambient) {
          // Overload signature: the implementation follows.
          continue
        }
        methods.push(this.#method(scope, typeScope, member))
      } else if (
        member.type === 'PropertyDefinition' ||
        member.type === 'TSAbstractPropertyDefinition' ||
        member.type === 'AccessorProperty' ||
        member.type === 'TSAbstractAccessorProperty'
      ) {
        properties.push(this.#property(scope, typeScope, member))
      }
    }

    const ctor = this.#resolveConstructor(declaration, EMPTY_BINDINGS, new Set([declarationKey(declaration)]))
    const ownConstructorDecorated =
      ctor.declaredBy === identity.identity && ctor.params.some(param => param.decorators.length > 0)
    const decorated =
      decorators.length > 0 ||
      ownConstructorDecorated ||
      methods.some(
        method => method.decorators.length > 0 || method.params.some(param => param.decorators.length > 0),
      ) ||
      properties.some(property => property.decorators.length > 0)

    const extendsClause = project.heritageOf(declaration).find(clause => clause.relation === 'extends')
    const superClass = extendsClause?.type.kind === 'reference' ? extendsClause.type : undefined

    const info: ClassInfo = {
      name: declaration.name,
      identity: identity.identity,
      displayName: identity.displayName,
      file: declaration.file,
      relativeFile: relativePath(project.root, declaration.file),
      location: file.location(declaration.span),
      exported: route.ok,
      importRoute: route.ok ? route.route : undefined,
      importError: route.ok ? undefined : route.error,
      abstract: node.abstract === true,
      ambient,
      typeParameters: (node.typeParameters?.params ?? []).map(parameter => parameter.name.name),
      decorators,
      ctor,
      methods,
      properties,
      superClass,
      heritage: this.#closure(declaration, EMPTY_BINDINGS),
      lifecycle: [],
      decorated,
      declaration,
    }
    const lifecycle = this.#lifecycle(info)
    return lifecycle.length === 0 ? info : { ...info, lifecycle }
  }

  #method(scope: ScopeRef, classScope: TypeScope, member: MethodDefinition): MethodInfo {
    const file = scope.file
    const key = memberName(file, member.key, member.computed)
    const fn = member.value
    const typeScope = withTypeParameters(classScope, fn.typeParameters)
    const returnType = fn.returnType ? this.#project.resolveType(scope, fn.returnType, typeScope) : undefined
    return {
      name: key.name,
      kind: member.kind === 'get' || member.kind === 'set' ? member.kind : 'method',
      visibility: visibilityOf(member.accessibility, key.privateName),
      privateName: key.privateName,
      computed: key.computed,
      static: member.static,
      abstract: member.type === 'TSAbstractMethodDefinition',
      async: fn.async || returnType?.kind === 'promise',
      generator: fn.generator,
      optional: member.optional === true,
      decorators: this.#reader.read(scope, member.decorators, 'method'),
      params: this.#parameters(scope, typeScope, fn.params, 'parameter', EMPTY_BINDINGS),
      returnType,
      typeParameters: (fn.typeParameters?.params ?? []).map(parameter => parameter.name.name),
      location: file.location(member.key),
    }
  }

  #property(scope: ScopeRef, typeScope: TypeScope, member: PropertyDefinition | AccessorProperty): PropertyInfo {
    const file = scope.file
    const key = memberName(file, member.key, member.computed)
    let initializer: ArgInfo | undefined
    if (member.value) {
      initializer = evaluateArgument(
        this.#project,
        scope,
        member.value,
        'value',
        `initializer of '${key.name}'`,
        undefined,
      )
    }
    const accessor = member.type === 'AccessorProperty' || member.type === 'TSAbstractAccessorProperty'
    return {
      name: key.name,
      privateName: key.privateName,
      computed: key.computed,
      static: member.static,
      visibility: visibilityOf(member.accessibility, key.privateName),
      readonly: !accessor && (member as PropertyDefinition).readonly === true,
      optional: !accessor && (member as PropertyDefinition).optional === true,
      declare: !accessor && (member as PropertyDefinition).declare === true,
      accessor,
      decorators: this.#reader.read(scope, member.decorators, 'property'),
      type: member.typeAnnotation ? this.#project.resolveType(scope, member.typeAnnotation, typeScope) : undefined,
      initializer,
      location: file.location(member.key),
    }
  }

  /** Parameters of a function, with types substituted by `bindings`. */
  #parameters(
    scope: ScopeRef,
    typeScope: TypeScope,
    params: readonly ParamPattern[],
    target: DecoratorTarget,
    bindings: ReadonlyMap<string, TypeInfo>,
  ): ParameterInfo[] {
    const file = scope.file
    // A TypeScript `this` parameter is erased: it is not a runtime parameter.
    const runtime = params.filter(param => !(param.type === 'Identifier' && param.name === 'this'))
    return runtime.map((param, index) => {
      let decorators = param.decorators ?? []
      let pattern = param.type === 'TSParameterProperty' ? param.parameter : param
      let property: ParameterInfo['property']
      if (param.type === 'TSParameterProperty') {
        property = { visibility: visibilityOf(param.accessibility), readonly: param.readonly }
      }
      const rest = pattern.type === 'RestElement'
      let annotation: TSTypeAnnotation | null | undefined
      let hasDefault = false
      if (pattern.type === 'RestElement') {
        annotation = pattern.typeAnnotation
        pattern = pattern.argument
      }
      if (pattern.type === 'AssignmentPattern') {
        hasDefault = true
        decorators = [...decorators, ...(pattern.decorators ?? [])]
        pattern = pattern.left
      }
      if (!rest) {
        annotation = pattern.typeAnnotation
      }
      const name = pattern.type === 'Identifier' ? pattern.name : `arg${index}`
      const optional = pattern.type === 'Identifier' && (pattern as { optional?: boolean }).optional === true
      let external = false
      const resolved = this.#project.resolveType(scope, annotation, typeScope, {
        onExternalAlias: () => {
          external = true
        },
      })
      const location = file.location(param)
      const info: ParameterInfo = {
        name,
        index,
        type: bindings.size === 0 ? resolved : substituteType(resolved, bindings),
        optional,
        hasDefault,
        rest,
        decorators: this.#reader.read(scope, decorators, target),
        location,
        typeLocation: annotation ? file.location(annotation.typeAnnotation) : location,
        property,
      }
      if (external) {
        const nominal = this.#project.resolveType(scope, annotation, typeScope, { externalAliases: 'keep' })
        this.#injectionTypes.set(info, bindings.size === 0 ? nominal : substituteType(nominal, bindings))
      }
      return info
    })
  }

  // ----------------------------------------------------------- constructor

  /** The constructor of a class: own, or inherited through the `extends` chain (§4.5). */
  #resolveConstructor(
    declaration: Declaration,
    bindings: ReadonlyMap<string, TypeInfo>,
    chain: Set<string>,
  ): ConstructorInfo {
    const project = this.#project
    const file = project.getFile(declaration.file) as SourceFile
    const node = declaration.node as Class
    const constructorNode = findConstructor(node)
    if (constructorNode) {
      const scope: ScopeRef = { file, namespace: declaration.namespace }
      return {
        params: this.#parameters(
          scope,
          project.typeScopeOf(declaration),
          constructorNode.value.params,
          'constructorParameter',
          bindings,
        ),
        declaredBy: project.identities.identityOfDeclaration(declaration).identity,
        visibility: visibilityOf(constructorNode.accessibility),
        location: file.location(constructorNode.key),
        error: undefined,
      }
    }
    const clause = project.heritageOf(declaration).find(candidate => candidate.relation === 'extends')
    if (!clause) {
      return { params: [], declaredBy: undefined, visibility: 'public', location: undefined, error: undefined }
    }
    const location = file.location(clause.span)
    const base =
      clause.symbol.kind === 'declaration'
        ? clause.symbol.declarations.find(candidate => candidate.kind === 'class')
        : undefined
    if (!base || clause.type.kind !== 'reference') {
      return {
        params: [],
        declaredBy: undefined,
        visibility: 'public',
        location,
        error: {
          message: `The constructor inherited by ${declaration.name} from '${file.textOf(clause.span)}' cannot be analysed (${describeUnanalysable(clause.symbol)})`,
          location,
          hints: [`Declare an explicit constructor in ${declaration.name}: \`constructor(...) { super(...) }\``],
        },
      }
    }
    const key = declarationKey(base)
    if (chain.has(key)) {
      return {
        params: [],
        declaredBy: undefined,
        visibility: 'public',
        location,
        error: {
          message: `Circular inheritance through ${base.name}`,
          location,
          hints: [`Declare an explicit constructor in ${declaration.name}`],
        },
      }
    }
    chain.add(key)
    const typeArgs = (bindings.size === 0 ? clause.type : (substituteType(clause.type, bindings) as ReferenceType))
      .typeArgs
    return this.#resolveConstructor(base, project.bindTypeArguments(base, typeArgs), chain)
  }

  #baseDeclaration(declaration: Declaration): Declaration | undefined {
    const key = declarationKey(declaration)
    let cached = this.#bases.get(key)
    if (cached === undefined) {
      const clause = this.#project.heritageOf(declaration).find(candidate => candidate.relation === 'extends')
      cached =
        clause?.symbol.kind === 'declaration'
          ? (clause.symbol.declarations.find(candidate => candidate.kind === 'class') ?? null)
          : null
      this.#bases.set(key, cached)
    }
    return cached ?? undefined
  }

  // -------------------------------------------------------------- heritage

  /** Heritage closure of a declaration with its type parameters bound by `bindings`. */
  #closure(declaration: Declaration, bindings: ReadonlyMap<string, TypeInfo>): readonly ReferenceType[] {
    const memoKey = `${declarationKey(declaration)}<${[...bindings.values()].map(serializeType).join(',')}>`
    const cached = this.#heritage.get(memoKey)
    if (cached) {
      return cached
    }
    const found = new Map<string, ReferenceType>()
    const visit = (current: Declaration, currentBindings: ReadonlyMap<string, TypeInfo>, depth: number): void => {
      if (depth > MAX_HERITAGE_DEPTH) {
        return
      }
      for (const merged of mergedDeclarations(this.#project, current)) {
        for (const clause of this.#project.heritageOf(merged)) {
          const type = currentBindings.size === 0 ? clause.type : substituteType(clause.type, currentBindings)
          if (type.kind !== 'reference') {
            continue
          }
          const key = serializeType(type)
          if (found.has(key)) {
            continue
          }
          found.set(key, type)
          const target = this.#heritageTarget(clause.symbol, type)
          if (target) {
            visit(target, this.#project.bindTypeArguments(target, type.typeArgs), depth + 1)
          }
        }
      }
    }
    visit(declaration, bindings, 0)
    const result = [...found.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, type]) => type)
    this.#heritage.set(memoKey, result)
    return result
  }

  /**
   * Class or interface a heritage clause continues with. The clause symbol is usually that
   * declaration; through a type alias (`implements UserRepository` with `type UserRepository =
   * Repository<User>`) it is the alias, so the expanded reference's identity is followed instead.
   */
  #heritageTarget(symbol: SymbolResolution, type: ReferenceType): Declaration | undefined {
    const isClassLike = (candidate: Declaration): boolean =>
      candidate.kind === 'class' || candidate.kind === 'interface'
    const direct = symbol.kind === 'declaration' ? symbol.declarations.find(isClassLike) : undefined
    if (direct) {
      return direct
    }
    const resolved = this.#project.lookupIdentity(type.identity)
    return resolved.kind === 'declaration' ? resolved.declarations.find(isClassLike) : undefined
  }

  // ------------------------------------------------------------- lifecycle

  #lifecycle(info: ClassInfo): LifecycleHookInfo[] {
    const found = new Map<string, LifecycleHookInfo>()
    const visited = new Set<string>()
    let current: ClassInfo | undefined = info
    while (current && !visited.has(current.identity)) {
      visited.add(current.identity)
      for (const candidate of hookCandidates(current)) {
        if (!found.has(candidate.hook)) {
          found.set(candidate.hook, candidate)
        }
      }
      current = this.baseOf(current)
    }
    return [...found.values()].sort((a, b) => compareStrings(a.hook, b.hook))
  }
}

/** Instance members first, then static ones (a static hook is reported by ZNIGHT009). */
function hookCandidates(info: ClassInfo): LifecycleHookInfo[] {
  const candidates: LifecycleHookInfo[] = []
  for (const isStatic of [false, true]) {
    for (const method of info.methods) {
      const hook = LIFECYCLE_MEMBERS.get(method.name)
      if (hook && method.static === isStatic && method.kind === 'method') {
        candidates.push({
          hook,
          member: method.name,
          declaredBy: info.identity,
          static: method.static,
          requiredParams: method.params.filter(param => !param.optional && !param.hasDefault && !param.rest).length,
          location: method.location,
        })
      }
    }
    for (const property of info.properties) {
      const hook = LIFECYCLE_MEMBERS.get(property.name)
      const value = property.initializer?.node
      if (
        hook &&
        property.static === isStatic &&
        value &&
        (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
      ) {
        candidates.push({
          hook,
          member: property.name,
          declaredBy: info.identity,
          static: property.static,
          requiredParams: requiredParameters(value.params),
          location: property.location,
        })
      }
    }
  }
  return candidates
}

function requiredParameters(params: readonly ParamPattern[]): number {
  return params.filter(param => {
    const pattern = param.type === 'TSParameterProperty' ? param.parameter : param
    if (pattern.type === 'RestElement' || pattern.type === 'AssignmentPattern') {
      return false
    }
    return !(pattern.type === 'Identifier' && (pattern as { optional?: boolean }).optional === true)
  }).length
}

/** The constructor implementation, or its first declaration in ambient contexts (no body). */
function findConstructor(node: Class): MethodDefinition | undefined {
  let first: MethodDefinition | undefined
  for (const member of node.body.body as readonly ClassMember[]) {
    if (member.type === 'MethodDefinition' && member.kind === 'constructor') {
      if ((member.value as FunctionNode).body !== null) {
        return member
      }
      first ??= member
    }
  }
  return first
}

/** Declarations merged with `declaration` (same name in the same scope): `interface X` + `class X`. */
function mergedDeclarations(project: Project, declaration: Declaration): readonly Declaration[] {
  const scope = declaration.namespace
    ? namespaceFacts(declaration.namespace).declarations
    : project.getFile(declaration.file)?.facts.declarations
  const merged = scope
    ?.get(declaration.localName)
    ?.filter(candidate => candidate.kind === 'class' || candidate.kind === 'interface')
  return merged && merged.length > 0 ? merged : [declaration]
}

function describeUnanalysable(symbol: SymbolResolution): string {
  switch (symbol.kind) {
    case 'unresolved':
      return symbol.message
    case 'external':
      return `'${symbol.specifier}' has no analysable declaration`
    case 'global':
      return `'${symbol.name}' is a global`
    default:
      return 'it is not a class declaration'
  }
}
