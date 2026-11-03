/**
 * The schema model (RFC 0005 §6.2–§6.6): starting from the root fields, every reachable TypeScript
 * type is read through the type shapes API (`ctx.types.shape()`, members `'instance'`, aliases kept
 * as named shapes) and mapped to a GraphQL type, row by row of the §6.2 table. Names follow §6.4,
 * objects, inputs and arguments §6.3; every problem is a diagnostic with a location, a hint and the
 * path from the root field ("reached from Query.book → Book").
 *
 * Built once per compile (`validate`), read by `generate`. Shapes are cached by the compiler per
 * options for the whole compile, so the walk only pays for what it visits once.
 */
import type {
  ClassInfo,
  Diagnostic,
  Location,
  MethodInfo,
  NamedShape,
  ParameterInfo,
  Shape,
  ShapeOptions,
  ShapeProperty,
  ShapeResult,
  ValidateContext,
} from '@znight/compiler'
import type { MetaEntry } from '@znight/http/compiler'
import type { GraphQLTypeRef } from '../type-ref.ts'
import type { FieldData, GraphQLData, ResolverData } from './data.ts'
import type {
  ArgModel,
  DiscriminantProperty,
  DiscriminatorModel,
  EnumValueModel,
  FieldModel,
  GraphQLModel,
  InputModel,
  ObjectModel,
  ScalarModel,
  TypeModel,
  UnionModel,
} from './model.ts'
import type { ResolvedGraphQLCompilerOptions } from './options.ts'

import { requiredRouteGroups } from '@znight/http/compiler'

import { isGraphQLName, RESERVED_ENUM_VALUES, ROOT_TYPE_NAMES, SPECIFIED_SCALARS } from '../names.ts'
import { schemaHash } from '../schema-hash.ts'
import { printSdl } from '../sdl.ts'
import { printTypeRef } from '../type-ref.ts'
import { ASYNC_ITERABLES, BASE_KEEP, Codes, compareStrings, OUTPUT_ITERABLES } from './constants.ts'
import { externalValue } from './defaults.ts'
import { discriminatorOf } from './discriminators.ts'
import { defaultTagValue, deprecationOf, descriptionOf, isHidden, paramDescription, tagOf } from './docs.ts'
import { GraphQLIds, SCALAR_ALIASES } from './ids.ts'
import { annotationLocation } from './locate.ts'
import { readScalars, type ScalarDeclaration } from './scalars.ts'
import { sdlType } from './sdl-view.ts'

type Context = ValidateContext<GraphQLData>
type Position = 'input' | 'output'
type Operation = 'query' | 'mutation' | 'subscription'

/** Where a type is used: what diagnostics say and where they point. */
interface Use {
  readonly position: Position
  /** `Book.cover`, `Query.book`, `Query.books(limit:)`. */
  readonly coordinate: string
  /** Prefix of the trail of the types reached from here (`Query.book → Book.cover`). */
  readonly trail: string
  /** The trail of the owner of the coordinate (`Query.book → Book`), for "reached from". */
  readonly reached: string | undefined
  /** Location of the root field the walk started from. */
  readonly root: Location | undefined
  /** Where the type is written; called only when a diagnostic is reported. */
  readonly locate: () => Location | undefined
}

/** A converted type: the reference (non-null when nothing made it nullable) and whether TS accepts `null`. */
interface Converted {
  readonly ref: GraphQLTypeRef
  readonly acceptsNull: boolean
}

/** A converted inner type: its reference and whether the type itself admits `null` (`JSONValue`). */
interface Inner {
  readonly ref: GraphQLTypeRef
  readonly nullable: boolean
}

/** A `@ResolveField` waiting for its parent type to be reached. */
interface PendingFieldResolver {
  readonly resolver: ResolverData
  readonly field: FieldData
  readonly method: MethodInfo
  attached: boolean
}

/** A default value to check once every type is complete. */
interface PendingDefault {
  readonly target: ArgModel
  readonly value: unknown
  readonly use: Use
  readonly location: Location | undefined
}

/** The first use of a declaration in a position (ZNIGHT063 "input and output"). */
interface PositionUse {
  readonly coordinate: string
  readonly location: Location | undefined
}

const NAME_HINT = 'GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __'
const RECORD_HINT =
  "GraphQL objects have fixed fields: declare an interface, or use JSONValue (import type { JSONValue } from '@znight/graphql')"
const ROOT_NAMES: ReadonlySet<string> = new Set(Object.values(ROOT_TYPE_NAMES))

/** Builds the model; `undefined` when the application has no resolver. */
export function buildModel(ctx: Context, options: ResolvedGraphQLCompilerOptions): GraphQLModel | undefined {
  const resolvers = [...ctx.stored].sort((a, b) => compareStrings(a.host.identity, b.host.identity))
  if (resolvers.length === 0) return undefined
  return new SchemaBuilder(ctx, options).build(resolvers)
}

class SchemaBuilder {
  readonly #ctx: Context
  readonly #number: 'Float' | 'Int'
  readonly #shapeOptions: ShapeOptions
  /** `scalar<T>()` declarations by the identity of `T`. */
  readonly #scalars: ReadonlyMap<string, ScalarDeclaration>
  /** Every named shape seen, by key. */
  readonly #named = new Map<string, NamedShape>()
  /** Models by GraphQL name (the first claimant). */
  readonly #types = new Map<string, TypeModel>()
  /** Models by declaration key. */
  readonly #models = new Map<string, TypeModel>()
  /** GraphQL names by declaration key. */
  readonly #names = new Map<string, string | undefined>()
  readonly #positions = new Map<string, { output?: PositionUse; input?: PositionUse }>()
  readonly #reported = new Set<string>()
  readonly #fieldResolvers = new Map<string, PendingFieldResolver[]>()
  readonly #defaults: PendingDefault[] = []
  readonly #methods = new Map<string, MethodInfo | undefined>()
  #errors = 0

  constructor(ctx: Context, options: ResolvedGraphQLCompilerOptions) {
    this.#ctx = ctx
    this.#number = options.number
    const declarations = readScalars(ctx, diagnostic => this.#report(diagnostic))
    this.#scalars = declarations
    // shapes keep the scalar types as references: `T` of `scalar<T>()` maps to its scalar wherever it appears
    const keep = [...new Set([...BASE_KEEP, ...declarations.keys()])].sort(compareStrings)
    this.#shapeOptions = Object.freeze({ keep: Object.freeze(keep), members: 'instance', jsdoc: true })
  }

  build(resolvers: readonly ResolverData[]): GraphQLModel | undefined {
    this.#checkLoaders(resolvers)
    this.#indexFieldResolvers(resolvers)
    const roots = new Map<Operation, ObjectModel>()
    const rootFields = new Map<string, { readonly field: FieldData; readonly resolver: ResolverData }>()
    let hasQuery = false
    for (const resolver of resolvers) {
      for (const field of resolver.fields) {
        if (field.operation === 'field') continue
        if (field.operation === 'query') hasQuery = true
        if (!field.complete) continue
        const method = this.#method(resolver, field)
        if (method === undefined) continue
        const root = this.#rootModel(roots, field.operation)
        const coordinate = `${root.name}.${field.name}`
        const previous = rootFields.get(coordinate)
        if (previous !== undefined) {
          this.#report({
            code: Codes.NameConflict,
            severity: 'error',
            message: `Two root fields are named ${coordinate}: ${resolver.host.displayName}.${field.method} and ${previous.resolver.host.displayName}.${previous.field.method}`,
            location: field.location,
            related: [{ message: 'the other field', location: previous.field.location }],
            hints: [`Rename one of them: @${decoratorName(field.operation)}('otherName')`],
          })
          continue
        }
        rootFields.set(coordinate, { field, resolver })
        root.fields.push(this.#resolverField(root, resolver, field, method))
      }
    }
    if (!hasQuery) {
      const first = resolvers[0] as ResolverData
      this.#report({
        code: Codes.InvalidResolver,
        severity: 'error',
        message: 'The application has GraphQL resolvers but no @Query field: GraphQL requires a query root type',
        location: first.location,
        hints: [`Add a @Query() method to a resolver (${first.host.displayName}, for instance)`],
      })
    }
    this.#reportUnreachableFieldResolvers()
    this.#checkDefaults()
    this.#checkInputCycles()
    this.#checkDecisions(resolvers)
    if (this.#errors > 0 || !hasQuery) return undefined
    return this.#assemble(roots, resolvers)
  }

  // ------------------------------------------------------------------------------------- reporting

  #report(diagnostic: Diagnostic): void {
    if (diagnostic.severity === 'error') this.#errors++
    this.#ctx.report(diagnostic)
  }

  /** Reports once per `key`. */
  #reportOnce(key: string, diagnostic: Diagnostic): void {
    if (this.#reported.has(key)) return
    this.#reported.add(key)
    this.#report(diagnostic)
  }

  #fail(code: Diagnostic['code'], use: Use, message: string, hints: readonly string[]): undefined {
    const location = use.locate()
    this.#report({
      code,
      severity: 'error',
      message,
      ...(location === undefined ? {} : { location }),
      ...(hints.length === 0 ? {} : { hints }),
      related: reachedFrom(use),
    })
    return undefined
  }

  // ------------------------------------------------------------------------------------ resolvers

  #method(resolver: ResolverData, field: FieldData): MethodInfo | undefined {
    const key = `${resolver.host.identity}#${field.method}`
    if (!this.#methods.has(key)) {
      const cls: ClassInfo | undefined = this.#ctx.classInfo(resolver.host.identity)
      this.#methods.set(
        key,
        cls?.methods.find(method => method.name === field.method && method.kind === 'method'),
      )
    }
    return this.#methods.get(key)
  }

  #shape(target: { readonly parameter: ParameterInfo } | { readonly returnOf: MethodInfo }): ShapeResult {
    const result = this.#ctx.types.shape(target, this.#shapeOptions)
    for (const named of result.named.values()) this.#named.set(named.key, named)
    return result
  }

  #rootModel(roots: Map<Operation, ObjectModel>, operation: Operation): ObjectModel {
    let root = roots.get(operation)
    if (root === undefined) {
      const name = ROOT_TYPE_NAMES[operation]
      root = {
        kind: 'object',
        name,
        key: `#root:${operation}`,
        description: undefined,
        location: undefined,
        fields: [],
        trail: name,
        root: undefined,
        classIdentity: undefined,
        properties: [],
      }
      roots.set(operation, root)
      this.#claim(root, undefined)
    }
    return root
  }

  /** A field backed by a resolver method (root field or field resolver). */
  #resolverField(owner: ObjectModel, resolver: ResolverData, field: FieldData, method: MethodInfo): FieldModel {
    const coordinate = `${owner.name}.${field.name}`
    const isRoot = field.operation !== 'field'
    const use: Use = {
      position: 'output',
      coordinate,
      trail: isRoot ? coordinate : `${owner.trail}.${field.name}`,
      reached: isRoot ? undefined : owner.trail,
      root: isRoot ? method.location : owner.root,
      locate: () => method.location,
    }
    const type = this.#returnType(resolver, field, method, use)
    return {
      name: field.name,
      type: type === undefined ? 'String' : printTypeRef(type.ref),
      description: descriptionOf(method.doc),
      deprecationReason: deprecationOf(method.doc),
      args: this.#arguments(field, method, use),
      binding: { resolver, field },
      location: field.location,
    }
  }

  #returnType(resolver: ResolverData, field: FieldData, method: MethodInfo, use: Use): Converted | undefined {
    const where = `${resolver.host.displayName}.${field.method}`
    if (method.returnType === undefined) {
      return this.#fail(Codes.InvalidType, use, `${where} has no return type annotation (${use.coordinate})`, [
        `Annotate the return type: the schema is derived from it (${field.method}(...): Promise<Book>)`,
      ])
    }
    const result = this.#shape({ returnOf: method })
    const rootIssue = result.issues.find(issue => issue.named === undefined)
    const located: Use = { ...use, locate: () => rootIssue?.location ?? method.location }
    const root = result.root
    const iterable = root.kind === 'reference' && ASYNC_ITERABLES.has(root.identity) ? root : undefined
    if (field.operation === 'subscription') {
      if (iterable === undefined) {
        this.#report({
          code: Codes.InvalidResolver,
          severity: 'error',
          message: `@Subscription ${where} must return an async iterable, not ${describeShape(root)}`,
          location: method.location,
          hints: [
            `Declare it as an async generator (async *${field.method}(): AsyncGenerator<Event>) or return pubsub.subscribe(...) (AsyncIterable<Event>)`,
          ],
        })
        return undefined
      }
      const item = iterable.typeArgs[0]
      if (item === undefined) {
        return this.#fail(
          Codes.InvalidType,
          located,
          `${where} must declare the type of its events (${use.coordinate})`,
          ['AsyncIterable<Event>'],
        )
      }
      return this.#convert(item, false, located)
    }
    if (iterable !== undefined) {
      return this.#fail(
        Codes.InvalidType,
        located,
        `${where} returns an async iterable: only @Subscription fields stream values (${use.coordinate})`,
        ['Use @Subscription() for a stream of events, or return a list (Promise<readonly Book[]>)'],
      )
    }
    if (root.kind === 'undefined') {
      return this.#fail(
        Codes.InvalidType,
        located,
        `${where} returns void: GraphQL fields must return a value (${use.coordinate})`,
        ['Return a payload type (the changed object) or a boolean'],
      )
    }
    return this.#convert(root, false, located)
  }

  /** Arguments of a resolver field: `@Args('name')` parameters and the properties of `@Args()` types. */
  #arguments(field: FieldData, method: MethodInfo, owner: Use): ArgModel[] {
    const args: ArgModel[] = []
    const seen = new Map<string, Location | undefined>()
    const add = (arg: ArgModel, location: Location | undefined): void => {
      if (seen.has(arg.name)) {
        const first = seen.get(arg.name)
        this.#report({
          code: Codes.NameConflict,
          severity: 'error',
          message: `Argument '${arg.name}' of ${owner.coordinate} is declared twice`,
          ...(location === undefined ? {} : { location }),
          ...(first === undefined ? {} : { related: [{ message: 'first declared here', location: first }] }),
          hints: ['Argument names must be unique: rename one of them'],
        })
        return
      }
      seen.set(arg.name, location)
      args.push(arg)
    }
    field.params.forEach((data, index) => {
      if (data?.kind !== 'args') return
      const param = method.params[index] as ParameterInfo
      const result = this.#shape({ parameter: param })
      if (data.name !== undefined) {
        const coordinate = `${owner.coordinate}(${data.name}:)`
        const use: Use = {
          position: 'input',
          coordinate,
          trail: `${owner.trail}(${data.name})`,
          reached: owner.reached,
          root: owner.root,
          locate: () => param.typeLocation,
        }
        const arg = this.#parameterArgument(data.name, param, method, result, use)
        if (arg !== undefined) add(arg, param.location)
        return
      }
      const properties = this.#propertiesOf(result.root)
      if (properties === 'record') {
        this.#fail(
          Codes.InvalidType,
          { ...owner, locate: () => param.typeLocation },
          `@Args() parameter '${param.name}' of ${owner.coordinate} cannot be a record or an index signature: GraphQL arguments are fixed`,
          [RECORD_HINT, `@Args('${param.name}') declares one argument named '${param.name}'`],
        )
        return
      }
      if (properties === undefined) {
        this.#fail(
          Codes.InvalidType,
          { ...owner, locate: () => param.typeLocation },
          `@Args() parameter '${param.name}' of ${owner.coordinate} must have an object type: its properties are the arguments`,
          [`@Args('${param.name}') declares one argument named '${param.name}'`],
        )
        return
      }
      for (const property of properties) {
        if (isHidden(property.doc)) continue
        const coordinate = `${owner.coordinate}(${property.name}:)`
        const use: Use = {
          position: 'input',
          coordinate,
          trail: `${owner.trail}(${property.name})`,
          reached: owner.reached,
          root: owner.root,
          locate: () => annotationLocation(this.#ctx.project, property.location) ?? param.typeLocation,
        }
        const arg = this.#inputValue(property, use)
        if (arg !== undefined) add(arg, property.location ?? param.location)
      }
    })
    return args
  }

  /** `@Args('limit') limit: Int = 20`. */
  #parameterArgument(
    name: string,
    param: ParameterInfo,
    method: MethodInfo,
    result: ShapeResult,
    use: Use,
  ): ArgModel | undefined {
    if (!isGraphQLName(name)) {
      this.#fail(Codes.NameConflict, use, `'${name}' is not a valid GraphQL argument name (${use.coordinate})`, [
        NAME_HINT,
      ])
      return undefined
    }
    const converted = this.#convert(result.root, param.optional, use)
    if (converted === undefined) return undefined
    let ref = converted.ref
    const arg: ArgModel = {
      name,
      type: '',
      ref,
      description: descriptionOf(param.doc) ?? paramDescription(method.doc, param.name),
      deprecationReason: deprecationOf(param.doc),
      defaultValue: undefined,
      nullAsUndefined: false,
      location: param.location,
    }
    const initializer = param.initializer
    let hasDefault = false
    if (param.hasDefault) {
      if (initializer?.evaluated === true && initializer.ref === undefined && !containsRef(initializer.value)) {
        this.#defaults.push({ target: arg, value: initializer.value, use, location: initializer.location })
        hasDefault = true
      } else {
        // a default the compiler cannot read: the argument becomes optional, the TypeScript default applies
        ref = { ...ref, nonNull: false }
      }
    }
    arg.ref = ref
    arg.type = printTypeRef(ref)
    arg.nullAsUndefined = !ref.nonNull && !converted.acceptsNull
    this.#checkDeprecatedInput(arg, hasDefault, use)
    return arg
  }

  /** A property as an argument or an input field (§6.3): `@default`, `@deprecated`, null handling. */
  #inputValue(property: ShapeProperty, use: Use): ArgModel | undefined {
    if (!isGraphQLName(property.name)) {
      this.#fail(
        Codes.NameConflict,
        { ...use, locate: () => property.location },
        `'${property.name}' is not a valid GraphQL name (${use.coordinate})`,
        [NAME_HINT, 'Hide the property with /** @gqlHidden */'],
      )
      return undefined
    }
    if (property.kind === 'getter') {
      this.#fail(Codes.InvalidInput, use, `${use.coordinate} is a getter: input values are plain data`, [
        'Declare a property instead, or hide the getter with /** @gqlHidden */',
      ])
      return undefined
    }
    const converted = this.#convert(property.shape, property.optional, use)
    if (converted === undefined) return undefined
    const arg: ArgModel = {
      name: property.name,
      type: printTypeRef(converted.ref),
      ref: converted.ref,
      description: descriptionOf(property.doc),
      deprecationReason: deprecationOf(property.doc),
      defaultValue: undefined,
      nullAsUndefined: !converted.ref.nonNull && !converted.acceptsNull,
      location: property.location,
    }
    const tag = tagOf(property.doc, 'default')
    if (tag !== undefined)
      this.#defaults.push({ target: arg, value: defaultTagValue(tag), use, location: tag.location })
    this.#checkDeprecatedInput(arg, tag !== undefined, use)
    return arg
  }

  /** graphql-js rejects a deprecated argument or input field that is required. */
  #checkDeprecatedInput(arg: ArgModel, hasDefault: boolean, use: Use): void {
    if (arg.deprecationReason === undefined || !arg.ref.nonNull || hasDefault) return
    this.#fail(Codes.InvalidInput, use, `${use.coordinate} is required and cannot be deprecated`, [
      'Make it optional (?: T or T | undefined) or give it a default value before deprecating it',
    ])
  }

  /** `Loader<L>`: `L` must be a loader provider, implementing `BatchLoad<K, V>` (ZNIGHT065). */
  #checkLoaders(resolvers: readonly ResolverData[]): void {
    const seen = new Set<number>()
    for (const resolver of resolvers) {
      for (const field of resolver.fields) {
        for (const param of field.params) {
          if (param?.kind !== 'loader' || seen.has(param.binding.id)) continue
          seen.add(param.binding.id)
          const ref = this.#ctx.binding(param.binding)
          const token = tokenOfRef(ref)
          const provider = token === undefined ? undefined : this.#ctx.provider(token)
          // an unbound loader is ZNIGHT001 (reported by the binding)
          if (provider === undefined || provider.heritage.some(type => type.identity === GraphQLIds.BatchLoad)) continue
          if (provider.kind !== 'class' || hasLoadMethod(this.#ctx, provider.classIdentity)) continue
          this.#report({
            code: Codes.InvalidLoader,
            severity: 'error',
            message: `${provider.displayName} is not a loader: Loader<${provider.displayName}> needs a provider implementing BatchLoad<K, V> (${resolver.host.displayName}.${field.method})`,
            location: param.location,
            hints: [
              `export class ${provider.displayName} implements BatchLoad<ID, Value> { async load(keys: readonly ID[]): Promise<readonly (Value | Error)[]> { ... } }`,
            ],
          })
        }
      }
    }
  }

  // ------------------------------------------------------------------------------ field resolvers

  #indexFieldResolvers(resolvers: readonly ResolverData[]): void {
    for (const resolver of resolvers) {
      for (const field of resolver.fields) {
        if (field.operation !== 'field' || !field.complete) continue
        const method = this.#method(resolver, field)
        if (method === undefined) continue
        const index = field.params.findIndex(param => param?.kind === 'parent')
        const param = method.params[index]
        if (param === undefined) continue
        const result = this.#shape({ parameter: param })
        const key = this.#objectKeyOf(result.root)
        if (key === undefined) {
          this.#report({
            code: Codes.InvalidResolver,
            severity: 'error',
            message: `The @Parent() parameter '${param.name}' of ${resolver.host.displayName}.${field.method} must have an object type, not ${describeShape(result.root)}`,
            location: param.typeLocation,
            hints: [
              'The parent type is the object type the field is added to: an interface, a class or a named alias of an object type',
            ],
          })
          continue
        }
        let list = this.#fieldResolvers.get(key)
        if (list === undefined) {
          list = []
          this.#fieldResolvers.set(key, list)
        }
        list.push({ resolver, field, method, attached: false })
      }
    }
    // field resolvers are appended by resolver token, then source order (§7.3)
    for (const list of this.#fieldResolvers.values()) {
      list.sort(
        (a, b) =>
          compareStrings(a.resolver.host.identity, b.resolver.host.identity) ||
          a.field.location.start - b.field.location.start,
      )
    }
  }

  #attachFieldResolvers(model: ObjectModel): void {
    const pending = this.#fieldResolvers.get(model.key)
    if (pending === undefined) return
    for (const entry of pending) {
      entry.attached = true
      const field = this.#resolverField(model, entry.resolver, entry.field, entry.method)
      const index = model.fields.findIndex(existing => existing.name === field.name)
      if (index === -1) {
        model.fields.push(field)
        continue
      }
      const existing = model.fields[index] as FieldModel
      const where = `${entry.resolver.host.displayName}.${entry.field.method}`
      if (existing.binding !== undefined) {
        this.#report({
          code: Codes.NameConflict,
          severity: 'error',
          message: `Two field resolvers add ${model.name}.${field.name}: ${where} and ${existing.binding.resolver.host.displayName}.${existing.binding.field.method}`,
          location: entry.field.location,
          related: [{ message: 'the other field resolver', location: existing.binding.field.location }],
          hints: ["Keep one of them, or rename one: @ResolveField('otherName')"],
        })
        continue
      }
      if (existing.type !== field.type) {
        this.#report({
          code: Codes.NameConflict,
          severity: 'error',
          message: `@ResolveField ${where} returns ${field.type}, but the property ${model.name}.${field.name} is ${existing.type}`,
          location: entry.field.location,
          ...(existing.location === undefined
            ? {}
            : { related: [{ message: 'the property', location: existing.location }] }),
          hints: [
            'A field resolver replacing a property must resolve the same GraphQL type: change its return type, or rename the field',
          ],
        })
        continue
      }
      // replaces the property field in place: same position, the method's documentation first
      model.fields[index] = {
        ...field,
        description: field.description ?? existing.description,
        deprecationReason: field.deprecationReason ?? existing.deprecationReason,
      }
    }
  }

  #reportUnreachableFieldResolvers(): void {
    for (const [key, list] of this.#fieldResolvers) {
      for (const entry of list) {
        if (entry.attached) continue
        const name = this.#named.get(key)?.name ?? key
        this.#report({
          code: Codes.InvalidResolver,
          severity: 'warning',
          message: `@ResolveField ${entry.resolver.host.displayName}.${entry.field.method} adds a field to ${name}, which no root field reaches as an output type: it is not part of the schema`,
          location: entry.field.location,
          hints: [`Return ${name} from a @Query (or another reachable field), or remove the field resolver`],
        })
      }
    }
  }

  // ----------------------------------------------------------------------------------- conversion

  /**
   * The GraphQL type of a shape: `null`, `undefined` and `optional` make it nullable, everything
   * else is non-null (§6.2).
   */
  #convert(shape: Shape, optional: boolean, use: Use): Converted | undefined {
    let nullable = optional
    let acceptsNull = false
    let inner = shape
    if (shape.kind === 'union') {
      const rest = shape.members.filter(member => member.kind !== 'null' && member.kind !== 'undefined')
      if (rest.length !== shape.members.length) {
        nullable = true
        acceptsNull = shape.members.some(member => member.kind === 'null')
      }
      if (rest.length === 0) {
        return this.#fail(Codes.InvalidType, use, `${use.coordinate} is always null or undefined`, [
          'Declare the type of the value',
        ])
      }
      inner = rest.length === 1 ? (rest[0] as Shape) : { kind: 'union', members: rest }
    }
    const converted = this.#inner(inner, use)
    if (converted === undefined) return undefined
    const isNullable = nullable || converted.nullable
    return { ref: { ...converted.ref, nonNull: !isNullable }, acceptsNull: acceptsNull || converted.nullable }
  }

  #inner(shape: Shape, use: Use): Inner | undefined {
    switch (shape.kind) {
      case 'string':
        return refTo('String')
      case 'number':
        return refTo(this.#number)
      case 'boolean':
        return refTo('Boolean')
      case 'literal':
        if (typeof shape.value === 'string') return refTo('String')
        return refTo(typeof shape.value === 'number' ? this.#number : 'Boolean')
      case 'date':
        return this.#builtin('DateTime', use)
      case 'bigint':
        return this.#builtin('BigInt', use)
      case 'array': {
        const item = this.#convert(shape.items, false, use)
        return item === undefined ? undefined : { ref: { kind: 'list', of: item.ref, nonNull: false }, nullable: false }
      }
      case 'named':
        return this.#namedType(shape.key, use)
      case 'reference':
        return this.#reference(shape, use)
      case 'url':
        return this.#fail(Codes.InvalidType, use, `Cannot map 'URL' to a GraphQL type (${use.coordinate})`, [
          "Expose a string (url.href), or declare a scalar: export const UrlScalar = scalar<URL>('URL', { ... })",
        ])
      case 'binary':
        return this.#fail(Codes.InvalidType, use, `Cannot map binary data to a GraphQL type (${use.coordinate})`, [
          "Expose a URL (coverUrl: string), hide the property with /** @gqlHidden */, or declare a scalar: export const Base64 = scalar<Uint8Array>('Base64', { ... })",
        ])
      case 'unknown':
        return this.#fail(
          Codes.InvalidType,
          use,
          `Cannot map 'unknown' or 'any' to a GraphQL type (${use.coordinate})`,
          ["Declare the type, or use JSONValue (import type { JSONValue } from '@znight/graphql') for arbitrary JSON"],
        )
      case 'never':
      case 'null':
      case 'undefined':
        return this.#fail(Codes.InvalidType, use, `Cannot map '${shape.kind}' to a GraphQL type (${use.coordinate})`, [
          'Declare the type of the value',
        ])
      case 'tuple':
        return this.#fail(Codes.InvalidType, use, `Cannot map a tuple to a GraphQL type (${use.coordinate})`, [
          'Use an array (readonly T[]) or a named object type',
        ])
      case 'object':
        if (shape.additional !== undefined) {
          return this.#fail(
            Codes.InvalidType,
            use,
            `Cannot map a record or an index signature to a GraphQL type (${use.coordinate})`,
            [RECORD_HINT],
          )
        }
        return this.#fail(
          Codes.InvalidType,
          use,
          `Cannot map an anonymous object type to a GraphQL type (${use.coordinate})`,
          ['GraphQL types have names: declare it (export interface BookStats { ... }) and use it'],
        )
      case 'intersection':
        return this.#fail(
          Codes.InvalidType,
          use,
          `Cannot map an anonymous intersection to a GraphQL type (${use.coordinate})`,
          ['Name it: export type BookWithAuthor = Book & { readonly author: Author }'],
        )
      case 'union':
        return this.#anonymousUnion(shape.members, use)
      case 'schema':
        return this.#fail(Codes.InvalidType, use, `Cannot map a schema type to a GraphQL type (${use.coordinate})`, [
          'Declare the TypeScript type: the annotation is the GraphQL type',
        ])
      case 'opaque':
        return this.#opaque(shape, use)
    }
  }

  #anonymousUnion(members: readonly Shape[], use: Use): undefined {
    if (members.every(member => member.kind === 'literal' && typeof member.value === 'string')) {
      const values = members.map(member => `'${(member as { value: string }).value}'`).join(' | ')
      return this.#fail(
        Codes.InvalidType,
        use,
        `Cannot map the anonymous union ${values} to a GraphQL type (${use.coordinate})`,
        [`Name it to make it an enum: export type Sort = ${values}`],
      )
    }
    if (members.every(member => member.kind === 'named')) {
      return this.#fail(Codes.InvalidType, use, `Cannot map an anonymous union to a GraphQL type (${use.coordinate})`, [
        `GraphQL unions have names: export type SearchResult = ${members.map(member => this.#named.get((member as { key: string }).key)?.name ?? '?').join(' | ')}`,
      ])
    }
    return this.#fail(
      Codes.InvalidType,
      use,
      `Cannot map the union ${members.map(describeShape).join(' | ')} to a GraphQL type (${use.coordinate})`,
      ['GraphQL unions only contain object types: declare one type, or an object type per case'],
    )
  }

  #opaque(shape: Extract<Shape, { kind: 'opaque' }>, use: Use): undefined {
    const text = shape.text
    let hints: string[]
    switch (shape.reason) {
      case 'non-json':
        if (text.startsWith('Promise')) {
          hints = ['A Promise is only unwrapped at the top of a resolver return type: declare the resolved type']
        } else if (text.startsWith('Map') || text.startsWith('WeakMap')) {
          hints = [
            "Use an array of entries, a named object type, or JSONValue (import type { JSONValue } from '@znight/graphql')",
          ]
        } else {
          hints = ['Declare a plain data type (an interface, an array, a scalar)']
        }
        break
      case 'missing-annotation':
        hints = ['Annotate the type: the compiler reads annotations only']
        break
      case 'function':
        hints = ['Functions are not data: return the value, or hide the member with /** @gqlHidden */']
        break
      case 'type-parameter':
        hints = ['Give the type arguments explicitly']
        break
      default:
        hints = ['Declare the structure with an interface or a named alias']
    }
    return this.#fail(Codes.InvalidType, use, `Cannot map '${text}' to a GraphQL type (${use.coordinate})`, hints)
  }

  #reference(shape: Extract<Shape, { kind: 'reference' }>, use: Use): Inner | undefined {
    const alias = SCALAR_ALIASES.get(shape.identity)
    if (alias === 'JSON') {
      // JSONValue includes null: the field is nullable
      const json = this.#builtin('JSON', use)
      return json === undefined ? undefined : { ref: json.ref, nullable: true }
    }
    if (alias !== undefined) return refTo(alias === 'Float' ? 'Float' : alias)
    const scalar = this.#scalars.get(shape.identity)
    if (scalar !== undefined) return this.#customScalar(scalar, use)
    if (OUTPUT_ITERABLES.has(shape.identity)) {
      if (use.position === 'input') {
        return this.#fail(Codes.InvalidInput, use, `${use.coordinate} is a ${shape.name}: input lists are arrays`, [
          'Declare an array (readonly T[]) for input values',
        ])
      }
      const item = shape.typeArgs[0]
      if (item === undefined)
        return this.#fail(Codes.InvalidType, use, `${use.coordinate}: ${shape.name} needs a type argument`, [])
      const converted = this.#convert(item, false, use)
      return converted === undefined
        ? undefined
        : { ref: { kind: 'list', of: converted.ref, nonNull: false }, nullable: false }
    }
    if (ASYNC_ITERABLES.has(shape.identity)) {
      return this.#fail(Codes.InvalidType, use, `Cannot map '${shape.name}' to a GraphQL type (${use.coordinate})`, [
        'Async iterables are only the return type of @Subscription methods',
      ])
    }
    return this.#fail(Codes.InvalidType, use, `Cannot map '${shape.name}' to a GraphQL type (${use.coordinate})`, [
      'Declare a plain data type (an interface, an array, a scalar)',
    ])
  }

  // ------------------------------------------------------------------------------------- scalars

  #builtin(name: 'DateTime' | 'BigInt' | 'JSON', use: Use): Inner | undefined {
    const key = `#builtin:${name}`
    if (!this.#models.has(key)) {
      const model: ScalarModel = {
        kind: 'scalar',
        name,
        key,
        description: undefined,
        location: undefined,
        definition: undefined,
        specifiedByURL: undefined,
      }
      this.#models.set(key, model)
      if (!this.#claim(model, use)) return undefined
    }
    return refTo(name)
  }

  #customScalar(scalar: ScalarDeclaration, use: Use): Inner | undefined {
    const key = `#scalar:${scalar.identity}`
    if (!this.#models.has(key)) {
      const model: ScalarModel = {
        kind: 'scalar',
        name: scalar.name,
        key,
        description: scalar.description,
        location: scalar.location,
        definition: scalar.identity,
        specifiedByURL: scalar.specifiedByURL,
      }
      this.#models.set(key, model)
      if (!this.#claim(model, use)) return undefined
    }
    return refTo(scalar.name)
  }

  // ------------------------------------------------------------------------------- named types

  #namedType(key: string, use: Use): Inner | undefined {
    const named = this.#named.get(key)
    if (named === undefined)
      return this.#fail(Codes.InvalidType, use, `Cannot resolve the type of ${use.coordinate}`, [])
    switch (named.declaration) {
      case 'enum':
        return this.#enum(named, use)
      case 'alias':
        return this.#alias(named, use)
      default:
        return this.#object(named, named, use)
    }
  }

  /**
   * A named alias: an object type (object literal, intersection, utility type, generic instance),
   * an enum (string literals), a union (object types), or transparent (`type Email = string`,
   * `type Books = Book[]`, `type Author = Person`).
   */
  #alias(alias: NamedShape, use: Use): Inner | undefined {
    const shape = alias.shape
    switch (shape.kind) {
      case 'object':
      case 'intersection':
        return this.#object(alias, alias, use)
      case 'named': {
        const target = this.#named.get(shape.key)
        if (
          target !== undefined &&
          target.declaration !== 'alias' &&
          target.declaration !== 'enum' &&
          target.typeArgs.length > 0
        ) {
          // `type BookList = Page<Book>`: the alias names the instance
          return this.#object(alias, target, use)
        }
        return this.#namedType(shape.key, use)
      }
      case 'union': {
        const rest = shape.members.filter(member => member.kind !== 'null' && member.kind !== 'undefined')
        const nullable = rest.length !== shape.members.length
        if (rest.length === 1) {
          const inner = this.#inner(rest[0] as Shape, use)
          return inner === undefined ? undefined : { ref: inner.ref, nullable: inner.nullable || nullable }
        }
        let converted: Inner | undefined
        if (rest.every(member => member.kind === 'literal')) converted = this.#literalEnum(alias, rest, use)
        else if (rest.length > 0 && rest.every(member => member.kind === 'named'))
          converted = this.#union(alias, rest, use)
        else converted = this.#anonymousUnion(rest, use)
        return converted === undefined ? undefined : { ref: converted.ref, nullable }
      }
      default:
        return this.#inner(shape, use)
    }
  }

  /**
   * The declaration key of the object type a shape maps to in output position (the parent of a
   * field resolver), `undefined` when it is not an object type. Mirrors {@link #alias}.
   */
  #objectKeyOf(shape: Shape): string | undefined {
    if (shape.kind === 'union') {
      const rest = shape.members.filter(member => member.kind !== 'null' && member.kind !== 'undefined')
      return rest.length === 1 ? this.#objectKeyOf(rest[0] as Shape) : undefined
    }
    if (shape.kind !== 'named') return undefined
    const named = this.#named.get(shape.key)
    if (named === undefined || named.declaration === 'enum') return undefined
    if (named.declaration !== 'alias') return named.key
    const target = named.shape
    if (target.kind === 'object' || target.kind === 'intersection') return named.key
    if (target.kind === 'named') {
      const instance = this.#named.get(target.key)
      if (
        instance !== undefined &&
        instance.declaration !== 'alias' &&
        instance.declaration !== 'enum' &&
        instance.typeArgs.length > 0
      ) {
        return named.key
      }
    }
    return this.#objectKeyOf(target)
  }

  /** An object type (output) or an input object type (input) for `named`, structured as `structure`. */
  #object(named: NamedShape, structure: NamedShape, use: Use): Inner | undefined {
    const key = named.key
    if (!this.#checkPosition(named, use)) return undefined
    const existing = this.#models.get(key)
    if (existing !== undefined) return this.#known(existing)
    const name = this.#typeName(named, use)
    if (name === undefined) return undefined
    const properties = this.#propertiesOf(structure.shape)
    if (properties === 'record') {
      return this.#fail(
        Codes.InvalidType,
        use,
        `Cannot map ${named.name}, a record or an index signature, to a GraphQL type (${use.coordinate})`,
        [RECORD_HINT],
      )
    }
    if (properties === undefined) {
      return this.#fail(
        Codes.InvalidType,
        use,
        `Cannot map ${named.name} to a GraphQL object type (${use.coordinate})`,
        ['Declare an interface, a class or a named object type'],
      )
    }
    const description = descriptionOf(named.doc) ?? (structure === named ? undefined : descriptionOf(structure.doc))
    const trail = `${use.trail} → ${name}`
    if (use.position === 'input') {
      const model: InputModel = { kind: 'input', name, key, description, location: named.location, fields: [] }
      this.#models.set(key, model)
      if (!this.#claim(model, use)) return undefined
      for (const property of properties) {
        if (isHidden(property.doc)) continue
        const fieldUse: Use = {
          position: 'input',
          coordinate: `${name}.${property.name}`,
          trail: `${trail}.${property.name}`,
          reached: trail,
          root: use.root,
          locate: () => annotationLocation(this.#ctx.project, property.location),
        }
        const field = this.#inputValue(property, fieldUse)
        if (field !== undefined) model.fields.push(field)
      }
      return refTo(name)
    }
    const model: ObjectModel = {
      kind: 'object',
      name,
      key,
      description,
      location: named.location,
      fields: [],
      trail,
      root: use.root,
      classIdentity:
        structure.declaration === 'class' && structure.typeArgs.length === 0 && structure === named
          ? structure.identity
          : undefined,
      properties: properties.map(property => this.#discriminant(property)),
    }
    this.#models.set(key, model)
    if (!this.#claim(model, use)) return undefined
    for (const property of properties) {
      const field = this.#outputField(model, property)
      if (field !== undefined) model.fields.push(field)
    }
    this.#attachFieldResolvers(model)
    return refTo(name)
  }

  /** A property as a union discriminator candidate: its literal value, through aliases (`kind: BookKind`). */
  #discriminant(property: ShapeProperty): DiscriminantProperty {
    let shape = property.shape
    // `type BookKind = 'book'`, `type Kind = BookKind`; the bound only guards against alias cycles
    for (let depth = 0; shape.kind === 'named' && depth < 32; depth++) {
      const named = this.#named.get(shape.key)
      if (named?.declaration !== 'alias') break
      shape = named.shape
    }
    return {
      name: property.name,
      optional: property.optional,
      literal: shape.kind === 'literal' ? shape.value : undefined,
    }
  }

  #outputField(model: ObjectModel, property: ShapeProperty): FieldModel | undefined {
    // hidden members, functions (methods stored as properties) and the union discriminator `__typename`
    if (isHidden(property.doc) || property.name === '__typename') return undefined
    if (property.shape.kind === 'opaque' && property.shape.reason === 'function') return undefined
    const use: Use = {
      position: 'output',
      coordinate: `${model.name}.${property.name}`,
      trail: `${model.trail}.${property.name}`,
      reached: model.trail,
      root: model.root,
      locate: () => annotationLocation(this.#ctx.project, property.location),
    }
    if (!isGraphQLName(property.name)) {
      return this.#fail(
        Codes.NameConflict,
        { ...use, locate: () => property.location },
        `'${property.name}' is not a valid GraphQL field name (${use.coordinate})`,
        [NAME_HINT, 'Hide the property with /** @gqlHidden */'],
      )
    }
    const converted = this.#convert(property.shape, property.optional, use)
    if (converted === undefined) return undefined
    return {
      name: property.name,
      type: printTypeRef(converted.ref),
      description: descriptionOf(property.doc),
      deprecationReason: deprecationOf(property.doc),
      args: [],
      binding: undefined,
      location: property.location,
    }
  }

  /**
   * The properties of an object structure (intersections merged, later members win), `'record'` for
   * a record or an index signature (ZNIGHT060: GraphQL objects have fixed fields).
   */
  #propertiesOf(shape: Shape): readonly ShapeProperty[] | 'record' | undefined {
    switch (shape.kind) {
      case 'object':
        return shape.additional === undefined ? shape.properties : 'record'
      case 'named': {
        const named = this.#named.get(shape.key)
        return named === undefined || named.declaration === 'enum' ? undefined : this.#propertiesOf(named.shape)
      }
      case 'intersection': {
        const merged = new Map<string, ShapeProperty>()
        for (const member of shape.members) {
          const properties = this.#propertiesOf(member)
          if (properties === undefined || properties === 'record') return properties
          for (const property of properties) {
            merged.delete(property.name)
            merged.set(property.name, property)
          }
        }
        return [...merged.values()]
      }
      default:
        return undefined
    }
  }

  /** A declaration is used in one position: input or output (ZNIGHT063 otherwise). */
  #checkPosition(named: NamedShape, use: Use): boolean {
    let uses = this.#positions.get(named.key)
    if (uses === undefined) {
      uses = {}
      this.#positions.set(named.key, uses)
    }
    const other = use.position === 'input' ? uses.output : uses.input
    if (uses[use.position] === undefined) uses[use.position] = { coordinate: use.coordinate, location: use.locate() }
    if (other === undefined) return true
    const output = use.position === 'output' ? use.coordinate : other.coordinate
    const input = use.position === 'input' ? use.coordinate : other.coordinate
    const inputOwner = input.includes('(') ? input.slice(0, input.indexOf('(')) : input.split('.')[0]
    this.#reportOnce(`position\0${named.key}`, {
      code: Codes.InvalidInput,
      severity: 'error',
      message: `'${named.name}' is used as an output type (${output}) and as an input type (${input})`,
      location: named.location,
      hints: [
        `GraphQL needs two types: declare \`export interface ${named.name}Input extends ${named.name} {}\` and use it in ${inputOwner}`,
      ],
      related: [
        ...(uses.output?.location === undefined
          ? []
          : [{ message: `used as output: ${output}`, location: uses.output.location }]),
        ...(uses.input?.location === undefined
          ? []
          : [{ message: `used as input: ${input}`, location: uses.input.location }]),
      ],
    })
    return false
  }

  /**
   * The GraphQL name of a declaration (§6.4): `@gqlName`, the declaration name, or for a generic
   * instance the names of its type arguments followed by the declaration name (`BookPage`).
   */
  #typeName(named: NamedShape, use: Use): string | undefined {
    if (this.#names.has(named.key)) return this.#names.get(named.key)
    let name: string | undefined
    const explicit = tagOf(named.doc, 'gqlName')?.text.trim()
    if (explicit !== undefined && explicit !== '') name = explicit
    else if (named.typeArgs.length === 0) name = named.name
    else {
      const args = named.typeArgs.map(arg => this.#argumentName(arg))
      const missing = args.findIndex(arg => arg === undefined)
      if (missing === -1) name = `${args.join('')}${named.name}`
      else {
        this.#reportOnce(`argument\0${named.key}`, {
          code: Codes.InvalidType,
          severity: 'error',
          message: `Cannot name the GraphQL type of ${named.name}<...> (${use.coordinate}): its type argument ${describeShape(named.typeArgs[missing] as Shape)} has no GraphQL name`,
          location: named.location,
          related: reachedFrom(use),
          hints: [
            `Name the instance with an alias (export type BookPages = ${named.name}<...>) or with /** @gqlName Name */`,
          ],
        })
      }
    }
    this.#names.set(named.key, name)
    return name
  }

  /** The GraphQL name a type argument contributes to a generic instance name. */
  #argumentName(shape: Shape): string | undefined {
    switch (shape.kind) {
      case 'string':
        return 'String'
      case 'number':
        return this.#number
      case 'boolean':
        return 'Boolean'
      case 'date':
        return 'DateTime'
      case 'bigint':
        return 'BigInt'
      case 'reference': {
        const alias = SCALAR_ALIASES.get(shape.identity)
        if (alias !== undefined) return alias
        return this.#scalars.get(shape.identity)?.name
      }
      case 'union': {
        const rest = shape.members.filter(member => member.kind !== 'null' && member.kind !== 'undefined')
        return rest.length === 1 ? this.#argumentName(rest[0] as Shape) : undefined
      }
      case 'named': {
        const named = this.#named.get(shape.key)
        if (named === undefined) return undefined
        if (named.declaration === 'alias') {
          const target = named.shape
          const instance = target.kind === 'named' ? this.#named.get(target.key) : undefined
          const isObject =
            target.kind === 'object' ||
            target.kind === 'intersection' ||
            (instance !== undefined &&
              instance.declaration !== 'alias' &&
              instance.declaration !== 'enum' &&
              instance.typeArgs.length > 0)
          const isEnum = target.kind === 'union' && target.members.every(member => member.kind === 'literal')
          const isUnion = target.kind === 'union' && target.members.filter(member => member.kind === 'named').length > 1
          if (!isObject && !isEnum && !isUnion) return this.#argumentName(target)
        }
        return this.#typeName(named, {
          position: 'output',
          coordinate: named.name,
          trail: named.name,
          reached: undefined,
          root: undefined,
          locate: () => named.location,
        })
      }
      default:
        return undefined
    }
  }

  /**
   * Registers a model under its GraphQL name: the name must be valid, not reserved, and not taken
   * by another declaration (ZNIGHT061).
   */
  #claim(model: TypeModel, use: Use | undefined): boolean {
    const name = model.name
    const isRoot = model.key.startsWith('#root:')
    const location = model.location ?? use?.locate()
    let problem: string | undefined
    if (!isGraphQLName(name)) problem = `'${name}' is not a valid GraphQL type name`
    else if (!isRoot && ROOT_NAMES.has(name)) problem = `'${name}' is the name of a root operation type`
    else if (SPECIFIED_SCALARS.has(name)) problem = `'${name}' is the name of a specified GraphQL scalar`
    if (problem !== undefined) {
      this.#reportOnce(`name\0${model.key}`, {
        code: Codes.NameConflict,
        severity: 'error',
        message: `${problem} (${model.key.startsWith('#') ? name : model.key})`,
        ...(location === undefined ? {} : { location }),
        related: use === undefined ? [] : reachedFrom(use),
        hints: [isGraphQLName(name) ? 'Rename the declaration, or name it with /** @gqlName OtherName */' : NAME_HINT],
      })
      return false
    }
    const existing = this.#types.get(name)
    if (existing === undefined) {
      this.#types.set(name, model)
      return true
    }
    if (existing === model) return true
    const pair = [existing.key, model.key].sort(compareStrings).join('\0')
    this.#reportOnce(`conflict\0${pair}`, {
      code: Codes.NameConflict,
      severity: 'error',
      message: `Two types are named '${name}' in the GraphQL schema: ${describeKey(model)} and ${describeKey(existing)}`,
      ...(location === undefined ? {} : { location }),
      related: [
        ...(existing.location === undefined ? [] : [{ message: 'the other declaration', location: existing.location }]),
        ...(use === undefined ? [] : reachedFrom(use)),
      ],
      hints: ['Rename one of them, or name one with /** @gqlName OtherName */'],
    })
    return false
  }

  // -------------------------------------------------------------------------------------- enums

  /** A model met again: its reference, unless its name was refused (already reported). */
  #known(model: TypeModel): Inner | undefined {
    return this.#types.get(model.name) === model ? refTo(model.name) : undefined
  }

  /** A TypeScript `enum`: names = member names, internal values = member values. */
  #enum(named: NamedShape, use: Use): Inner | undefined {
    const existing = this.#models.get(named.key)
    if (existing !== undefined) return this.#known(existing)
    const name = this.#typeName(named, use)
    if (name === undefined) return undefined
    const members = named.enumMembers
    if (members === undefined || members.length === 0) {
      return this.#fail(
        Codes.InvalidType,
        use,
        `The values of the enum ${named.name} cannot be evaluated (${use.coordinate})`,
        ['Use literal member values (A = "a", B = 1)'],
      )
    }
    const values: EnumValueModel[] = []
    for (const member of members) {
      if (!this.#checkEnumValueName(member.name, named, member.location, use)) continue
      values.push({
        name: member.name,
        value: member.value,
        description: descriptionOf(member.doc),
        deprecationReason: deprecationOf(member.doc),
      })
    }
    return this.#registerEnum(named, name, values, use)
  }

  /** A named alias of a union of string literals: names = values = the literals, in source order. */
  #literalEnum(named: NamedShape, members: readonly Shape[], use: Use): Inner | undefined {
    const existing = this.#models.get(named.key)
    if (existing !== undefined) return this.#known(existing)
    const literals = named.literals ?? members.map(member => (member as Extract<Shape, { kind: 'literal' }>).value)
    if (!literals.every(value => typeof value === 'string')) {
      return this.#fail(
        Codes.InvalidType,
        use,
        `Cannot map ${named.name} (${literals.map(value => JSON.stringify(value)).join(' | ')}) to a GraphQL type (${use.coordinate}): only unions of string literals are enums`,
        ['Declare a TypeScript enum (enum Level { Low = 1, High = 2 }), or use Int'],
      )
    }
    const name = this.#typeName(named, use)
    if (name === undefined) return undefined
    const values: EnumValueModel[] = []
    for (const literal of literals as readonly string[]) {
      if (!this.#checkEnumValueName(literal, named, named.location, use)) continue
      values.push({ name: literal, value: literal, description: undefined, deprecationReason: undefined })
    }
    return this.#registerEnum(named, name, values, use)
  }

  #checkEnumValueName(value: string, named: NamedShape, location: Location, use: Use): boolean {
    if (isGraphQLName(value) && !RESERVED_ENUM_VALUES.has(value)) return true
    this.#reportOnce(`enum\0${named.key}\0${value}`, {
      code: Codes.NameConflict,
      severity: 'error',
      message: `'${value}' of ${named.name} is not a valid GraphQL enum value`,
      location,
      related: reachedFrom(use),
      hints: [`${NAME_HINT}; true, false and null are reserved`],
    })
    return false
  }

  #registerEnum(named: NamedShape, name: string, values: readonly EnumValueModel[], use: Use): Inner | undefined {
    const model: TypeModel = {
      kind: 'enum',
      name,
      key: named.key,
      description: descriptionOf(named.doc),
      location: named.location,
      values,
    }
    this.#models.set(named.key, model)
    if (!this.#claim(model, use)) return undefined
    return refTo(name)
  }

  // ------------------------------------------------------------------------------------- unions

  /** A named alias of a union of object types (output only), with its runtime discriminator. */
  #union(alias: NamedShape, members: readonly Shape[], use: Use): Inner | undefined {
    if (use.position === 'input') {
      return this.#fail(
        Codes.InvalidInput,
        use,
        `${use.coordinate} is the union ${alias.name}: unions cannot be input values`,
        ['Declare one input type with optional fields, or one argument per case'],
      )
    }
    const existing = this.#models.get(alias.key)
    if (existing !== undefined) return this.#known(existing)
    const name = this.#typeName(alias, use)
    if (name === undefined) return undefined
    const model: UnionModel = {
      kind: 'union',
      name,
      key: alias.key,
      description: descriptionOf(alias.doc),
      location: alias.location,
      members: [],
      discriminator: undefined,
    }
    this.#models.set(alias.key, model)
    if (!this.#claim(model, use)) return undefined
    const trail = `${use.trail} → ${name}`
    const objects: ObjectModel[] = []
    // a failed member is reported: no discriminator then (members that collapse into one object, as
    // `Book | BookAlias`, are not failures)
    let failed = false
    for (const member of members) {
      const memberUse: Use = { ...use, coordinate: name, trail, reached: trail, locate: () => alias.location }
      const converted = this.#inner(member, memberUse)
      if (converted === undefined) {
        failed = true
        continue
      }
      const target = converted.ref.kind === 'named' ? this.#types.get(converted.ref.name) : undefined
      if (target?.kind !== 'object') {
        failed = true
        this.#fail(
          Codes.InvalidType,
          memberUse,
          `The union ${name} contains ${describeShape(member)}, which is not an object type`,
          ['GraphQL unions only contain object types'],
        )
        continue
      }
      if (!objects.includes(target)) objects.push(target)
    }
    objects.sort((a, b) => compareStrings(a.name, b.name))
    model.members = objects.map(object => object.name)
    if (!failed) model.discriminator = this.#discriminator(model, objects)
    return refTo(name)
  }

  /**
   * How the runtime tells the members apart (§5.7): `instanceof` when every member is an exported
   * class, a `__typename` property, a literal property with a distinct value per member, else
   * ZNIGHT064.
   */
  #discriminator(union: UnionModel, members: readonly ObjectModel[]): DiscriminatorModel | undefined {
    const found = discriminatorOf(members, identity => this.#ctx.classInfo(identity))
    if (found !== undefined) return found
    const names = members.map(member => member.name)
    const one = names.length === 1
    const listed = one ? (names[0] as string) : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`
    const allClasses = members.every(member => member.classIdentity !== undefined)
    let why: string
    if (allClasses) why = one ? 'is a class that is not exported' : 'are classes that are not all exported'
    else why = one ? 'has no literal property' : 'have no common literal property'
    this.#report({
      code: Codes.UnresolvableAbstractType,
      severity: 'error',
      message: `The members of union ${union.name} cannot be told apart at runtime: ${listed} ${why}`,
      ...(union.location === undefined ? {} : { location: union.location }),
      hints: [
        allClasses
          ? 'Export the member classes: the generated module imports them for instanceof'
          : `Add a literal property to each member (${members.map(member => `readonly kind: '${lowerFirst(member.name)}'`).join(' / ')}), or make the members classes`,
      ],
    })
    return undefined
  }

  // --------------------------------------------------------------------------------- final checks

  /** Defaults (`@default`, parameter defaults) against their types (ZNIGHT063), as external values. */
  #checkDefaults(): void {
    for (const pending of this.#defaults) {
      const result = externalValue(pending.value, pending.target.ref, this.#types)
      if ('error' in result) {
        const location = pending.location ?? pending.use.locate()
        this.#report({
          code: Codes.InvalidInput,
          severity: 'error',
          message: `Invalid default value ${describeValue(pending.value)} for ${pending.use.coordinate} (${pending.target.type}): ${result.error}`,
          ...(location === undefined ? {} : { location }),
          related: reachedFrom(pending.use),
          hints: ['Defaults are JSON values of the argument type (enum values as their member value or name)'],
        })
        continue
      }
      pending.target.defaultValue = result.value
      if (pending.target.ref.nonNull) pending.target.nullAsUndefined = false
    }
  }

  /** GraphQL forbids a cycle of non-null input fields (ZNIGHT063). */
  #checkInputCycles(): void {
    const inputs = [...this.#models.values()]
      .filter((model): model is InputModel => model.kind === 'input')
      .sort((a, b) => compareStrings(a.name, b.name))
    const state = new Map<string, 'visiting' | 'done'>()
    const stack: string[] = []
    const visit = (model: InputModel): void => {
      state.set(model.name, 'visiting')
      stack.push(model.name)
      for (const field of model.fields) {
        if (field.ref.kind !== 'named' || !field.ref.nonNull) continue
        const target = this.#types.get(field.ref.name)
        if (target?.kind !== 'input') continue
        const status = state.get(target.name)
        if (status === 'visiting') {
          const cycle = [...stack.slice(stack.indexOf(target.name)), target.name]
          this.#report({
            code: Codes.InvalidInput,
            severity: 'error',
            message: `The input types ${cycle.join(' → ')} reference each other through non-null fields: no value can be written`,
            ...(target.location === undefined ? {} : { location: target.location }),
            hints: ['Make one of the fields of the cycle optional (?: T) or a list'],
          })
        } else if (status === undefined) {
          visit(target)
        }
      }
      stack.pop()
      state.set(model.name, 'done')
    }
    for (const model of inputs) if (!state.has(model.name)) visit(model)
  }

  /** RFC 0001: every root field decides every required route decorator group (ZNIGHT023). */
  #checkDecisions(resolvers: readonly ResolverData[]): void {
    const applied: MetaEntry[] = []
    for (const resolver of resolvers) for (const field of resolver.fields) applied.push(...field.meta)
    const required = requiredRouteGroups(this.#ctx, applied)
    if (required.length === 0) return
    for (const resolver of resolvers) {
      for (const field of resolver.fields) {
        if (field.operation === 'field') continue
        const decided = new Set(field.meta.map(entry => entry.group))
        for (const group of required) {
          if (decided.has(group.group)) continue
          const root = ROOT_TYPE_NAMES[field.operation]
          this.#report({
            code: Codes.MissingRouteDecision,
            severity: 'error',
            message: `Root field ${root}.${field.name} (${resolver.host.displayName}.${field.method}) has no "${group.group}" decision`,
            location: field.methodLocation,
            hints: [`Add ${group.suggestion} to the method or to ${resolver.host.displayName}`],
            related: [
              {
                message: `The "${group.group}" group is required`,
                location: (group.decorators[0] as { definition: Location }).definition,
              },
            ],
          })
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------ assembly

  #assemble(roots: ReadonlyMap<Operation, ObjectModel>, resolvers: readonly ResolverData[]): GraphQLModel {
    const types = [...this.#types.values()].sort((a, b) => compareStrings(a.name, b.name))
    const meta: MetaEntry[] = []
    for (const resolver of resolvers) for (const field of resolver.fields) meta.push(...field.meta)
    const rootNames = {
      query: ROOT_TYPE_NAMES.query,
      ...(roots.has('mutation') ? { mutation: ROOT_TYPE_NAMES.mutation } : {}),
      ...(roots.has('subscription') ? { subscription: ROOT_TYPE_NAMES.subscription } : {}),
    }
    const sdl = printSdl({ roots: rootNames, types: types.map(sdlType) })
    return { roots: rootNames, types, meta, sdl, schemaHash: schemaHash(sdl) }
  }
}

// ------------------------------------------------------------------------------------------ helpers

/** The class (or one of its base classes) declares an instance `load` method. */
function hasLoadMethod(ctx: Context, identity: string): boolean {
  const seen = new Set<string>()
  let current: string | undefined = identity
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const cls: ClassInfo | undefined = ctx.classInfo(current)
    if (cls === undefined) return true // not analysable (a compiled class): trust the type checker
    if (cls.methods.some(method => method.name === 'load' && method.kind === 'method' && !method.static)) return true
    if (cls.properties.some(property => property.name === 'load' && !property.static)) return true
    current = cls.superClass?.identity
  }
  return false
}

/** A (nullable, until `#convert` decides) reference to a named type. */
function refTo(name: string): Inner {
  return { ref: { kind: 'named', name, nonNull: false }, nullable: false }
}

function reachedFrom(use: Use): { readonly message: string; readonly location: Location }[] {
  return use.reached === undefined || use.root === undefined
    ? []
    : [{ message: `reached from ${use.reached}`, location: use.root }]
}

function decoratorName(operation: Operation): string {
  return ROOT_TYPE_NAMES[operation]
}

/** The token of a binding result (`undefined` when binding failed). */
function tokenOfRef(ref: ReturnType<Context['binding']>): string | undefined {
  if (typeof ref === 'string') return ref
  return ref !== undefined && 'token' in ref ? ref.token : undefined
}

function describeKey(model: TypeModel): string {
  return model.key.startsWith('#') ? `the ${model.kind} ${model.name}` : model.key
}

/** Short description of a shape for messages (`string`, `Book`, `Map<string, number>`). */
function describeShape(shape: Shape): string {
  switch (shape.kind) {
    case 'literal':
      return JSON.stringify(shape.value)
    case 'named':
      return shape.key.slice(shape.key.indexOf('#') + 1)
    case 'reference':
      return shape.name
    case 'opaque':
      return shape.text
    case 'array':
      return `${describeShape(shape.items)}[]`
    case 'union':
      return shape.members.map(describeShape).join(' | ')
    case 'object':
      return 'an object literal type'
    default:
      return shape.kind
  }
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function containsRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return value.some(containsRef)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return true
  return Object.values(value).some(containsRef)
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`
}
