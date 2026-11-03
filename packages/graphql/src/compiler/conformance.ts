/**
 * Type conformance of schema-first resolvers (RFC 0007 §5.4): the TypeScript signatures of the
 * resolver methods, read through the type shapes API, against the SDL types. Output positions
 * (return types, parent types, the properties of the returned objects) must be assignable to the
 * SDL type; input positions (`@Args` parameters, input objects) must accept every value graphql-js
 * passes. The walk follows the object fields without resolver through the properties of the
 * TypeScript types (each SDL type and TypeScript declaration pair once), which is also where an
 * object field that nothing provides is found (coverage, §5.3).
 *
 * Every mismatch is a ZNIGHT068 located on the TypeScript annotation, the SDL definition related.
 * `any`, `unknown`, opaque types and missing annotations are not checked. The walk also decides
 * `nullAsUndefined` of arguments and input fields and the discriminators of abstract types.
 */
import type {
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
import type {
  ASTNode,
  GraphQLAbstractType,
  GraphQLField,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
} from 'graphql'
import type { FieldData, GraphQLData, ResolverData } from './data.ts'
import type { DiscriminatorModel } from './model.ts'
import type { ScalarDeclaration } from './scalars.ts'

import { ASYNC_ITERABLES, BASE_KEEP, Codes, compareStrings, OUTPUT_ITERABLES } from './constants.ts'
import { graphqlModules } from './graphql-js.ts'
import { GraphQLIds } from './ids.ts'
import { annotationLocation, returnTypeLocation } from './locate.ts'

type Context = ValidateContext<GraphQLData>

/** A resolver method bound to an SDL field. */
export interface Binding {
  readonly resolver: ResolverData
  readonly field: FieldData
  readonly method: MethodInfo
  /** The type declaring the field (a root type for root fields). */
  readonly type: GraphQLObjectType
  readonly sdlField: GraphQLField<unknown, unknown>
}

/** Inputs of {@link checkConformance}. */
export interface ConformanceInput {
  readonly ctx: Context
  readonly schema: GraphQLSchema
  readonly locate: (node: ASTNode | null | undefined) => Location | undefined
  /** `scalar<T>()` declarations by GraphQL name. */
  readonly scalars: ReadonlyMap<string, ScalarDeclaration>
  /** Sorted by resolver identity, then source order. */
  readonly bindings: readonly Binding[]
  /** Coordinates (`Event.owner`) bound to a resolver. */
  readonly bound: ReadonlySet<string>
  readonly report: (diagnostic: Diagnostic) => void
}

/** What the walk decides for the model. */
export interface ConformanceResult {
  /** Coordinates of the arguments (`Query.books(limit:)`) and input fields (`BookFilter.genre`) whose `null` becomes `undefined`. */
  readonly nullAsUndefined: ReadonlySet<string>
  /** Discriminators of the abstract types; absent: `typename`. */
  readonly discriminators: ReadonlyMap<string, DiscriminatorModel>
}

/** Where a TypeScript type is checked. */
interface Site {
  /** What the type is, in messages: `EventResolver.event returns`, `User.email is`. */
  readonly label: string
  /** Where the TypeScript type comes from, in messages: `returned by EventResolver.event`. */
  readonly origin: string
  /** The SDL coordinate, in messages: `Query.event`, `Event.owner`, `Query.events(limit:)`. */
  readonly coordinate: string
  /** The TypeScript annotation (called only when a diagnostic is reported). */
  readonly locate: () => Location | undefined
  /** The SDL definition. */
  readonly sdl: Location | undefined
  /** An optional property (output: may be `undefined`). */
  readonly optional: boolean
}

/** Options of an input position. */
interface InputPosition {
  /** The TypeScript value may be `undefined`: optional parameter or property, parameter default. */
  readonly optional: boolean
  /** The SDL argument or input field has a default value: never absent. */
  readonly sdlDefault: boolean
  /** Coordinate whose `nullAsUndefined` this position votes for. */
  readonly vote?: string
}

/** A shape split into its non-nullish members. */
interface Parts {
  readonly members: Shape[]
  hasNull: boolean
  hasUndefined: boolean
  /** `unknown`, `any` or an opaque part: not checked. */
  unchecked: boolean
}

const MAX_DEPTH = 64

/** Walks every binding; reports the mismatches. */
export function checkConformance(input: ConformanceInput): ConformanceResult {
  return new Conformance(input).run()
}

class Conformance {
  readonly #config: ConformanceInput
  readonly #ctx: Context
  readonly #options: ShapeOptions
  readonly #named = new Map<string, NamedShape>()
  readonly #visited = new Set<string>()
  readonly #anonymous = new WeakMap<object, Set<string>>()
  readonly #reported = new Set<string>()
  readonly #votes = new Map<string, { accepts: number; rejects: Site[] }>()
  /** Abstract type → member object type → class identities (`''`: not an exported class) returned for it. */
  readonly #members = new Map<string, Map<string, Set<string>>>()
  /** TypeScript members of abstract types that cannot be told apart (ZNIGHT064 unless every member is a class). */
  readonly #untellable = new Map<
    string,
    { readonly name: string; readonly site: Site; readonly location?: Location }[]
  >()
  readonly #predicates = graphqlModules().type

  constructor(input: ConformanceInput) {
    this.#config = input
    this.#ctx = input.ctx
    const keep = new Set<string>(BASE_KEEP)
    for (const scalar of input.scalars.values()) keep.add(scalar.type)
    this.#options = Object.freeze({
      keep: Object.freeze([...keep].sort(compareStrings)),
      members: 'instance',
      jsdoc: false,
    })
  }

  run(): ConformanceResult {
    for (const binding of this.#config.bindings) this.#binding(binding)
    const nullAsUndefined = new Set<string>()
    for (const [coordinate, vote] of [...this.#votes].sort(([a], [b]) => compareStrings(a, b))) {
      if (vote.rejects.length === 0) continue
      if (vote.accepts === 0) {
        nullAsUndefined.add(coordinate)
        continue
      }
      for (const site of vote.rejects) {
        this.#mismatch(
          site,
          `${site.label} does not accept null, but another use of ${coordinate} does: null is passed as is`,
          ['Accept null (| null) in every TypeScript type of the value, or none of them'],
        )
      }
    }
    return { nullAsUndefined, discriminators: this.#discriminators() }
  }

  // ------------------------------------------------------------------------------------ bindings

  #binding(binding: Binding): void {
    const { resolver, field, method, type, sdlField } = binding
    const where = `${resolver.host.displayName}.${method.name}`
    const coordinate = `${type.name}.${sdlField.name}`
    const sdl = this.#config.locate(sdlField.astNode)
    if (method.returnType !== undefined) {
      const result = this.#shape({ returnOf: method })
      const site: Site = {
        label: `${where} returns`,
        origin: `returned by ${where}`,
        coordinate,
        locate: () => returnTypeLocation(this.#ctx.project, method) ?? method.location,
        sdl,
        optional: false,
      }
      const root = result.root
      const iterable = root.kind === 'reference' && ASYNC_ITERABLES.has(root.identity) ? root : undefined
      if (field.operation === 'subscription') {
        if (iterable !== undefined) {
          this.#output(sdlField.type, iterable.typeArgs[0] ?? { kind: 'unknown' }, site)
        } else if (!this.#parts(root).unchecked) {
          this.#report({
            code: Codes.InvalidResolver,
            severity: 'error',
            message: `@Subscription ${where} must return an async iterable (${coordinate})`,
            location: site.locate() ?? method.location,
            hints: [
              `Declare it as an async generator (async *${method.name}(): AsyncGenerator<Event>) or return pubsub.subscribe(...) (AsyncIterable<Event>)`,
            ],
          })
        }
      } else if (iterable === undefined) {
        this.#output(sdlField.type, root, site)
      } else {
        this.#mismatch(site, `${where} returns an async iterable: only Subscription fields stream values`, [
          `Use @Subscription() for a stream of events, or return the value of ${coordinate}`,
        ])
      }
    }
    field.params.forEach((data, index) => {
      const param = method.params[index] as ParameterInfo | undefined
      if (param === undefined) return
      if (data?.kind === 'args' && data.schema === undefined) this.#arguments(binding, data.name, param, where)
      else if (data?.kind === 'parent') this.#parent(type, param, where)
    })
  }

  /** `@Args('name')` (one argument) or `@Args()` (every argument, an object type). */
  #arguments(binding: Binding, name: string | undefined, param: ParameterInfo, where: string): void {
    const { type, sdlField } = binding
    const coordinate = `${type.name}.${sdlField.name}`
    const result = this.#shape({ parameter: param })
    if (name !== undefined) {
      const arg = sdlField.args.find(candidate => candidate.name === name)
      if (arg === undefined) return // coverage (schema-first.ts)
      this.#input(
        arg.type,
        result.root,
        {
          optional: param.optional || param.hasDefault,
          sdlDefault: arg.default !== undefined,
          vote: `${coordinate}(${name}:)`,
        },
        {
          label: `parameter '${param.name}' of ${where}`,
          origin: `parameter '${param.name}' of ${where}`,
          coordinate: `${coordinate}(${name}:)`,
          locate: () => param.typeLocation,
          sdl: this.#config.locate(arg.astNode),
          optional: false,
        },
      )
      return
    }
    const site: Site = {
      label: `@Args() parameter '${param.name}' of ${where}`,
      origin: `@Args() parameter '${param.name}' of ${where}`,
      coordinate,
      locate: () => param.typeLocation,
      sdl: this.#config.locate(sdlField.astNode),
      optional: false,
    }
    const parts = this.#parts(result.root)
    if (parts.unchecked) return
    const object = parts.members.length === 1 ? (parts.members[0] as Shape) : undefined
    const properties = object === undefined ? undefined : this.#propertiesOf(object)
    if (properties === 'record') return
    if (properties === undefined) {
      this.#mismatch(site, `${site.label} must be an object type: it receives every argument of ${coordinate}`, [
        `@Args('name') receives one argument`,
      ])
      return
    }
    for (const property of properties) {
      const arg = sdlField.args.find(candidate => candidate.name === property.name)
      const propertySite: Site = {
        label: `property '${property.name}' of the @Args() parameter of ${where}`,
        origin: site.origin,
        coordinate: `${coordinate}(${property.name}:)`,
        locate: () => annotationLocation(this.#ctx.project, property.location) ?? param.typeLocation,
        sdl: this.#config.locate(arg?.astNode ?? sdlField.astNode),
        optional: false,
      }
      if (arg === undefined) {
        const names = sdlField.args.map(candidate => candidate.name)
        this.#mismatch(
          { ...propertySite, locate: () => property.location ?? param.typeLocation },
          `${coordinate} has no argument '${property.name}' (${propertySite.label})`,
          [names.length === 0 ? `${coordinate} takes no argument` : `Its arguments: ${names.join(', ')}`],
        )
        continue
      }
      this.#input(
        arg.type,
        property.shape,
        { optional: property.optional, sdlDefault: arg.default !== undefined, vote: propertySite.coordinate },
        propertySite,
      )
    }
  }

  /** `@Parent()`: its properties named like the unbound fields of the type conform to them. */
  #parent(type: GraphQLObjectType, param: ParameterInfo, where: string): void {
    const result = this.#shape({ parameter: param })
    const site: Site = {
      label: `@Parent() parameter '${param.name}' of ${where}`,
      origin: `@Parent() parameter of ${where}`,
      coordinate: type.name,
      locate: () => param.typeLocation,
      sdl: this.#config.locate(type.astNode),
      optional: false,
    }
    const parts = this.#parts(result.root)
    if (parts.unchecked) return
    for (const member of parts.members) {
      const properties = this.#propertiesOf(member)
      if (properties === 'record') continue
      if (properties === undefined) {
        this.#mismatch(site, `${site.label} is ${this.#describe(member)}, not an object type (${type.name})`, [
          `Type it with the TypeScript type of ${type.name}`,
        ])
        continue
      }
      const fields = type.getFields()
      for (const property of properties) {
        const field = fields[property.name]
        if (field === undefined || this.#config.bound.has(`${type.name}.${field.name}`)) continue
        this.#output(field.type, property.shape, this.#propertySite(site, type, field, property, member))
      }
    }
  }

  // -------------------------------------------------------------------------------------- output

  #output(type: GraphQLOutputType, shape: Shape, site: Site, depth = 0): void {
    if (depth > MAX_DEPTH) return
    const parts = this.#parts(shape)
    if (parts.unchecked) return
    const { isNonNullType, isListType, isScalarType, isEnumType, isObjectType } = this.#predicates
    let inner = type
    if (isNonNullType(inner)) {
      if (parts.hasNull || parts.hasUndefined || site.optional) {
        const what = parts.hasNull ? 'null' : 'undefined'
        this.#mismatch(
          site,
          `${site.label} ${this.#describeParts(parts, site.optional)}, which may be ${what}, but ${site.coordinate} is ${String(type)} (non-null)`,
          [`Return a value in every case, or make ${site.coordinate} nullable in the SDL (${String(inner.ofType)})`],
        )
      }
      inner = inner.ofType
    }
    if (parts.members.length === 0) return
    if (isListType(inner)) {
      for (const member of parts.members) {
        const item = this.#listItem(member, 'output')
        if (item === undefined) {
          this.#mismatch(
            site,
            `${site.label} ${this.#describe(member)}, not a list, but ${site.coordinate} is ${String(type)}`,
            ['Return an array (readonly T[]), a Set or an Iterable'],
          )
          continue
        }
        for (const shape of item) {
          this.#output(inner.ofType, shape, { ...site, label: `${site.label} a list of`, optional: false }, depth + 1)
        }
      }
      return
    }
    if (isScalarType(inner)) {
      for (const member of parts.members) {
        if (this.#scalarAccepts(inner.name, member, 'output')) continue
        this.#mismatch(
          site,
          `${site.label} ${this.#describe(member)}, which is not a ${inner.name} (${site.coordinate})`,
          [this.#scalarHint(inner.name)],
        )
      }
      return
    }
    if (isEnumType(inner)) {
      const values = new Set(inner.getValues().map(value => value.name))
      for (const member of parts.members) {
        const literals = this.#literals(member)
        if (literals === undefined) {
          this.#mismatch(
            site,
            `${site.label} ${this.#describe(member)}, wider than the enum ${inner.name} (${site.coordinate})`,
            [
              `Return the values of ${inner.name}: ${[...values].join(', ')} (a TypeScript enum or a union of literals)`,
            ],
          )
          continue
        }
        const unknown = literals.filter(literal => !values.has(String(literal)))
        if (unknown.length > 0) {
          this.#mismatch(
            site,
            `${site.label} ${unknown.map(literal => JSON.stringify(literal)).join(', ')}, not ${unknown.length === 1 ? 'a value' : 'values'} of the enum ${inner.name} (${site.coordinate})`,
            [`Enum values are compared by value: ${[...values].join(', ')}`],
          )
        }
      }
      return
    }
    if (isObjectType(inner)) {
      for (const member of parts.members) this.#object(inner, member, site, depth)
      return
    }
    this.#abstract(inner, parts.members, site, depth)
  }

  /** An object type returned as `shape`: every field without resolver is a conforming property. */
  #object(type: GraphQLObjectType, shape: Shape, site: Site, depth: number): void {
    const properties = this.#propertiesOf(shape)
    if (properties === 'record') return
    if (properties === undefined) {
      this.#mismatch(
        site,
        `${site.label} ${this.#describe(shape)}, not an object type, but ${site.coordinate} is ${type.name}`,
        [`Return the TypeScript type of ${type.name} (an interface, a class or an object type)`],
      )
      return
    }
    if (!this.#visit(`output\0${type.name}`, shape)) return
    const named = shape.kind === 'named' ? this.#named.get(shape.key) : undefined
    const tsName = named?.name ?? 'the returned object type'
    const byName = new Map(properties.map(property => [property.name, property]))
    for (const field of Object.values(type.getFields())) {
      const coordinate = `${type.name}.${field.name}`
      if (this.#config.bound.has(coordinate)) continue
      const property = byName.get(field.name)
      if (property === undefined) {
        const location = this.#config.locate(field.astNode)
        const declaration = named?.location ?? site.locate()
        this.#reportOnce(`provide\0${coordinate}\0${named?.key ?? site.label}`, {
          code: Codes.SchemaMismatch,
          severity: 'error',
          message: `${coordinate} has no resolver, and ${tsName} (${site.origin}) has no property '${field.name}'`,
          ...(location === undefined ? {} : { location }),
          hints: [
            `Add a field resolver: @ResolveField('${field.name}') in a @Resolver('${type.name}') class`,
            `Or add '${field.name}' to ${tsName}`,
          ],
          ...(declaration === undefined
            ? {}
            : { related: [{ message: `${tsName} is declared here`, location: declaration }] }),
        })
        continue
      }
      this.#output(field.type, property.shape, this.#propertySite(site, type, field, property, shape), depth + 1)
    }
  }

  /** A union or an interface: each TypeScript member is matched to a possible type. */
  #abstract(type: GraphQLAbstractType, members: readonly Shape[], site: Site, depth: number): void {
    const possible = this.#config.schema.getPossibleTypes(type)
    const names = possible.map(object => object.name)
    for (const member of members) {
      const named = member.kind === 'named' ? this.#named.get(member.key) : undefined
      const properties = this.#propertiesOf(member)
      if (properties === undefined) {
        this.#mismatch(
          site,
          `${site.label} ${this.#describe(member)}, not an object type, but ${site.coordinate} is ${type.name}`,
          [`Return one of ${names.join(', ')}`],
        )
        continue
      }
      if (properties === 'record') continue
      // graphql-codegen's interface types (`Node`): checked against the fields of the interface
      if (named?.name === type.name && this.#predicates.isInterfaceType(type)) {
        if (!this.#visit(`interface\0${type.name}`, member)) continue
        const byName = new Map(properties.map(property => [property.name, property]))
        for (const field of Object.values(type.getFields())) {
          const property = byName.get(field.name)
          if (property !== undefined) {
            this.#output(field.type, property.shape, this.#propertySite(site, type, field, property, member), depth + 1)
          }
        }
        continue
      }
      const typename = properties.find(property => property.name === '__typename')
      const literal = typename?.shape.kind === 'literal' ? typename.shape.value : undefined
      // a member is recognised by its `__typename` literal, else by its name
      let target = typeof literal === 'string' ? literal : undefined
      if (target === undefined && named !== undefined && names.includes(named.name)) target = named.name
      if (target === undefined || !names.includes(target)) {
        const what = named?.name ?? this.#describe(member)
        this.#mismatch(
          site,
          `${site.label} ${what}, which is not ${names.length === 1 ? 'the member' : 'a member'} of ${type.name} (${names.join(', ')})`,
          [
            `Return ${names.join(' | ')}: a member is recognised by its __typename literal (__typename: '${names[0] ?? 'Member'}'), else by its name`,
          ],
        )
        continue
      }
      const object = this.#config.schema.getType(target) as GraphQLObjectType
      this.#object(object, member, site, depth + 1)
      const identity =
        named?.declaration === 'class' &&
        named.typeArgs.length === 0 &&
        this.#ctx.classInfo(named.identity)?.exported === true
          ? named.identity
          : ''
      let byMember = this.#members.get(type.name)
      if (byMember === undefined) {
        byMember = new Map()
        this.#members.set(type.name, byMember)
      }
      let identities = byMember.get(target)
      if (identities === undefined) {
        identities = new Set()
        byMember.set(target, identities)
      }
      identities.add(identity)
      if (typename === undefined && identity === '') {
        let list = this.#untellable.get(type.name)
        if (list === undefined) {
          list = []
          this.#untellable.set(type.name, list)
        }
        list.push({ name: named?.name ?? target, site, ...(named === undefined ? {} : { location: named.location }) })
      }
    }
  }

  // --------------------------------------------------------------------------------------- input

  #input(type: GraphQLInputType, shape: Shape, position: InputPosition, site: Site, depth = 0): void {
    if (depth > MAX_DEPTH) return
    const parts = this.#parts(shape)
    const { isNonNullType, isListType, isScalarType, isEnumType } = this.#predicates
    let inner = type
    if (isNonNullType(inner)) inner = inner.ofType
    else {
      const acceptsNull = parts.hasNull || parts.unchecked
      const acceptsUndefined = parts.hasUndefined || position.optional || parts.unchecked
      if (!position.sdlDefault && !acceptsUndefined) {
        this.#mismatch(
          site,
          `${site.label} does not accept undefined, but ${site.coordinate} (${String(type)}) may be omitted`,
          ['Make it optional (?: or | undefined), or make the SDL argument non-null or give it a default value'],
        )
      } else if (!acceptsNull && !acceptsUndefined) {
        this.#mismatch(
          site,
          `${site.label} does not accept null, but ${site.coordinate} (${String(type)}) may be null`,
          [`Accept null (| null) or undefined, or make it non-null in the SDL (${String(type)}!)`],
        )
      }
      if (position.vote !== undefined && !parts.unchecked) {
        let vote = this.#votes.get(position.vote)
        if (vote === undefined) {
          vote = { accepts: 0, rejects: [] }
          this.#votes.set(position.vote, vote)
        }
        if (acceptsNull) vote.accepts++
        else if (acceptsUndefined) vote.rejects.push(site)
      }
    }
    if (parts.unchecked) return
    if (parts.members.length === 0) {
      this.#mismatch(site, `${site.label} accepts no ${String(inner)} value (${site.coordinate})`, [
        `Type it with the TypeScript type of ${String(inner)}`,
      ])
      return
    }
    if (isListType(inner)) {
      const lists = parts.members.map(member => this.#listItem(member, 'input')).filter(item => item !== undefined)
      if (lists.length === 0) {
        this.#mismatch(
          site,
          `${site.label} is ${this.#describeParts(parts, false)}, not an array, but ${site.coordinate} is ${String(type)}`,
          ['Accept an array (readonly T[]): graphql-js always passes lists as arrays'],
        )
        return
      }
      for (const items of lists) {
        for (const item of items) {
          this.#input(
            inner.ofType,
            item,
            { optional: false, sdlDefault: true },
            { ...site, label: `${site.label} (items)` },
            depth + 1,
          )
        }
      }
      return
    }
    if (isScalarType(inner)) {
      if (parts.members.some(member => this.#scalarAccepts(inner.name, member, 'input'))) return
      this.#mismatch(
        site,
        `${site.label} is ${this.#describeParts(parts, false)}, which does not accept every ${inner.name} (${site.coordinate})`,
        [this.#scalarHint(inner.name)],
      )
      return
    }
    if (isEnumType(inner)) {
      const accepted = new Set<string>()
      for (const member of parts.members) {
        if (member.kind === 'string') return
        for (const literal of this.#literals(member) ?? []) accepted.add(String(literal))
      }
      const missing = inner.getValues().filter(value => !accepted.has(value.name))
      if (missing.length > 0) {
        this.#mismatch(
          site,
          `${site.label} is ${this.#describeParts(parts, false)}, which does not accept ${missing.map(value => value.name).join(', ')} of the enum ${inner.name} (${site.coordinate})`,
          [`Accept every value of ${inner.name} (graphql-codegen's enum type, or a union of every value)`],
        )
      }
      return
    }
    const objects = parts.members.filter(member => this.#propertiesOf(member) !== undefined)
    if (objects.length === 0) {
      this.#mismatch(
        site,
        `${site.label} is ${this.#describeParts(parts, false)}, not an object type, but ${site.coordinate} is ${inner.name}`,
        [`Type it with the TypeScript type of the input ${inner.name}`],
      )
      return
    }
    for (const object of objects) this.#inputObject(inner as GraphQLInputObjectType, object, site, depth)
  }

  /** An input object received as `shape`: each property is a field of the input, accepting its values. */
  #inputObject(type: GraphQLInputObjectType, shape: Shape, site: Site, depth: number): void {
    const properties = this.#propertiesOf(shape)
    if (properties === undefined || properties === 'record') return
    if (!this.#visit(`input\0${type.name}`, shape)) return
    const fields = type.getFields()
    for (const property of properties) {
      if (property.name === '__typename') continue
      const field = fields[property.name]
      const propertySite: Site = {
        label: `${this.#tsName(shape) ?? 'the input type'}.${property.name}`,
        origin: site.origin,
        coordinate: `${type.name}.${property.name}`,
        locate: () => annotationLocation(this.#ctx.project, property.location) ?? site.locate(),
        sdl: this.#config.locate(field?.astNode ?? type.astNode),
        optional: false,
      }
      if (field === undefined) {
        this.#mismatch(
          { ...propertySite, locate: () => property.location ?? site.locate() },
          `${propertySite.label} is not a field of the input ${type.name}: it is always undefined`,
          [`Remove it, or declare it in the SDL (input ${type.name} { ${property.name}: ... })`],
        )
        continue
      }
      this.#input(
        field.type,
        property.shape,
        { optional: property.optional, sdlDefault: field.default !== undefined, vote: propertySite.coordinate },
        propertySite,
        depth + 1,
      )
    }
  }

  // ------------------------------------------------------------------------------------- scalars

  /** A member (not nullish, not a union) conforms to a scalar: output, or accepts every value: input. */
  #scalarAccepts(name: string, shape: Shape, position: 'input' | 'output'): boolean {
    const custom = this.#config.scalars.get(name)
    if (custom !== undefined) return this.#hasReference(shape, custom.type)
    const output = position === 'output'
    switch (name) {
      case 'String':
        return this.#isString(shape, output)
      case 'ID':
        return this.#isString(shape, output) || (output && this.#isNumber(shape, true))
      case 'Int':
      case 'Float':
        return this.#isNumber(shape, output)
      case 'Boolean':
        return shape.kind === 'boolean' || (output && shape.kind === 'literal' && typeof shape.value === 'boolean')
      case 'DateTime':
        return shape.kind === 'date'
      case 'BigInt':
        return shape.kind === 'bigint' || (output && this.#isNumber(shape, true))
      default:
        // JSON and the built-in scalars without TypeScript counterpart
        return true
    }
  }

  #scalarHint(name: string): string {
    const custom = this.#config.scalars.get(name)
    if (custom !== undefined) {
      return `${name} is declared with scalar<${custom.type.slice(custom.type.indexOf('#') + 1)}>(): use that type (graphql-codegen: scalars: { ${name}: '...' })`
    }
    switch (name) {
      case 'Int':
      case 'Float':
        return 'Use number (or the Int / Float aliases of @znight/graphql)'
      case 'Boolean':
        return 'Use boolean'
      case 'DateTime':
        return 'The built-in DateTime scalar is a Date'
      case 'BigInt':
        return 'The built-in BigInt scalar is a bigint'
      default:
        return 'Use string (string literals, string enums and branded strings conform in output positions)'
    }
  }

  /** `string`, a branded string, the `ID` alias; output: also string literals and string enums. */
  #isString(shape: Shape, output: boolean): boolean {
    switch (shape.kind) {
      case 'string':
        return true
      case 'literal':
        return output && typeof shape.value === 'string'
      case 'reference':
        return shape.identity === GraphQLIds.ID
      case 'intersection':
        return shape.members.some(
          member => member.kind === 'string' || (member.kind === 'reference' && member.identity === GraphQLIds.ID),
        )
      case 'named': {
        const named = this.#named.get(shape.key)
        return (
          output &&
          named?.declaration === 'enum' &&
          (this.#literals(shape) ?? []).every(value => typeof value === 'string')
        )
      }
      default:
        return false
    }
  }

  /** `number`, a branded number, the `Int` / `Float` aliases; output: also number literals and numeric enums. */
  #isNumber(shape: Shape, output: boolean): boolean {
    const alias = (candidate: Shape): boolean =>
      candidate.kind === 'reference' &&
      (candidate.identity === GraphQLIds.Int || candidate.identity === GraphQLIds.Float)
    switch (shape.kind) {
      case 'number':
        return true
      case 'literal':
        return output && typeof shape.value === 'number'
      case 'reference':
        return alias(shape)
      case 'intersection':
        return shape.members.some(member => member.kind === 'number' || alias(member))
      case 'named': {
        const named = this.#named.get(shape.key)
        return (
          output &&
          named?.declaration === 'enum' &&
          (this.#literals(shape) ?? []).every(value => typeof value === 'number')
        )
      }
      default:
        return false
    }
  }

  #hasReference(shape: Shape, identity: string): boolean {
    if (shape.kind === 'reference') return shape.identity === identity
    if (shape.kind === 'intersection') return shape.members.some(member => this.#hasReference(member, identity))
    return false
  }

  // -------------------------------------------------------------------------------------- shapes

  #shape(target: { readonly parameter: ParameterInfo } | { readonly returnOf: MethodInfo }): ShapeResult {
    const result = this.#ctx.types.shape(target, this.#options)
    for (const named of result.named.values()) this.#named.set(named.key, named)
    return result
  }

  /** The non-nullish members of a shape, through unions and aliases (object aliases stay named). */
  #parts(shape: Shape): Parts {
    const parts: Parts = { members: [], hasNull: false, hasUndefined: false, unchecked: false }
    const visit = (current: Shape, depth: number): void => {
      if (depth > MAX_DEPTH) return
      switch (current.kind) {
        case 'null':
          parts.hasNull = true
          return
        case 'undefined':
          parts.hasUndefined = true
          return
        case 'unknown':
        case 'opaque':
        case 'schema':
          parts.unchecked = true
          return
        case 'never':
          return
        case 'union':
          for (const member of current.members) visit(member, depth + 1)
          return
        case 'named': {
          const named = this.#named.get(current.key)
          if (named === undefined) {
            parts.unchecked = true
            return
          }
          const target = named.shape
          const isObject =
            target.kind === 'object' ||
            (target.kind === 'intersection' && this.#propertiesOf(target) !== undefined) ||
            (target.kind === 'named' && this.#named.get(target.key)?.declaration !== 'alias')
          if (named.declaration !== 'alias' || isObject) parts.members.push(current)
          else visit(target, depth + 1)
          return
        }
        default:
          parts.members.push(current)
      }
    }
    visit(shape, 0)
    return parts
  }

  /** The item shapes of a list member (array, tuple, iterable); `undefined`: not a list. */
  #listItem(shape: Shape, position: 'input' | 'output'): readonly Shape[] | undefined {
    if (shape.kind === 'array') return [shape.items]
    if (shape.kind === 'tuple')
      return position === 'output' ? [...shape.items, ...(shape.rest === undefined ? [] : [shape.rest])] : undefined
    if (shape.kind === 'reference' && position === 'output' && OUTPUT_ITERABLES.has(shape.identity)) {
      return [shape.typeArgs[0] ?? { kind: 'unknown' }]
    }
    return undefined
  }

  /** The literal values of a member: a literal, an enum; `undefined`: not literals. */
  #literals(shape: Shape): readonly (string | number | boolean)[] | undefined {
    if (shape.kind === 'literal') return [shape.value]
    if (shape.kind !== 'named') return undefined
    const named = this.#named.get(shape.key)
    if (named?.declaration !== 'enum') return undefined
    if (named.enumMembers !== undefined) return named.enumMembers.map(member => member.value)
    const target = named.shape
    if (target.kind === 'literal') return [target.value]
    if (target.kind === 'union' && target.members.every(member => member.kind === 'literal')) {
      return target.members.map(member => (member as { value: string | number | boolean }).value)
    }
    return undefined
  }

  /** The properties of an object structure (intersections merged, later members win), `'record'` for index signatures. */
  #propertiesOf(shape: Shape, depth = 0): readonly ShapeProperty[] | 'record' | undefined {
    if (depth > MAX_DEPTH) return undefined
    switch (shape.kind) {
      case 'object':
        return shape.additional === undefined ? shape.properties : 'record'
      case 'named': {
        const named = this.#named.get(shape.key)
        return named === undefined || named.declaration === 'enum'
          ? undefined
          : this.#propertiesOf(named.shape, depth + 1)
      }
      case 'intersection': {
        const merged = new Map<string, ShapeProperty>()
        for (const member of shape.members) {
          const properties = this.#propertiesOf(member, depth + 1)
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

  /** `true` the first time `(namespace, shape)` is visited: named shapes by key, anonymous ones by identity. */
  #visit(namespace: string, shape: Shape): boolean {
    if (shape.kind === 'named') {
      const key = `${namespace}\0${shape.key}`
      if (this.#visited.has(key)) return false
      this.#visited.add(key)
      return true
    }
    let seen = this.#anonymous.get(shape)
    if (seen === undefined) {
      seen = new Set()
      this.#anonymous.set(shape, seen)
    }
    if (seen.has(namespace)) return false
    seen.add(namespace)
    return true
  }

  #propertySite(
    site: Site,
    type: GraphQLObjectType | GraphQLAbstractType,
    field: GraphQLField<unknown, unknown>,
    property: ShapeProperty,
    owner: Shape,
  ): Site {
    const name = this.#tsName(owner)
    return {
      label: `${name === undefined ? `property '${property.name}'` : `${name}.${property.name}`} is`,
      origin: `type of ${name === undefined ? `property '${property.name}'` : `${name}.${property.name}`}, ${site.origin}`,
      coordinate: `${type.name}.${field.name}`,
      locate: () => annotationLocation(this.#ctx.project, property.location) ?? site.locate(),
      sdl: this.#config.locate(field.astNode),
      optional: property.optional,
    }
  }

  #tsName(shape: Shape): string | undefined {
    return shape.kind === 'named' ? this.#named.get(shape.key)?.name : undefined
  }

  // ---------------------------------------------------------------------------------- discriminators

  /**
   * `instanceof` when every TypeScript member returned for an abstract type is an exported class
   * (one per member), else `__typename`; members that are neither are ZNIGHT064.
   */
  #discriminators(): ReadonlyMap<string, DiscriminatorModel> {
    const result = new Map<string, DiscriminatorModel>()
    for (const [name, byMember] of [...this.#members].sort(([a], [b]) => compareStrings(a, b))) {
      const classes: { identity: string; name: string; depth: number }[] = []
      let allClasses = true
      for (const [member, identities] of byMember) {
        const identity = identities.size === 1 ? [...identities][0] : ''
        if (identity === undefined || identity === '') {
          allClasses = false
          break
        }
        classes.push({ identity, name: member, depth: this.#classDepth(identity) })
      }
      if (allClasses && classes.length > 0) {
        // subclasses first: `instanceof` matches the most derived class
        classes.sort((a, b) => b.depth - a.depth || compareStrings(a.name, b.name))
        result.set(name, {
          by: 'class',
          classes: classes.map(({ identity, name: member }) => ({ identity, name: member })),
        })
        continue
      }
      for (const entry of this.#untellable.get(name) ?? []) {
        const location = entry.site.locate()
        this.#reportOnce(`untellable\0${name}\0${entry.name}`, {
          code: Codes.UnresolvableAbstractType,
          severity: 'error',
          message: `${entry.name} cannot be told apart among the members of ${name} at runtime: it declares no __typename and is not an exported class`,
          ...(location === undefined ? {} : { location }),
          hints: [
            `Return objects carrying __typename (declare __typename: '${entry.name}' in the TypeScript type; graphql-codegen declares it), or return exported class instances`,
          ],
          ...(entry.location === undefined
            ? {}
            : { related: [{ message: `${entry.name} is declared here`, location: entry.location }] }),
        })
      }
    }
    return result
  }

  #classDepth(identity: string): number {
    let depth = 0
    let current = this.#ctx.classInfo(identity)?.superClass?.identity
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current) && depth < MAX_DEPTH) {
      seen.add(current)
      depth++
      current = this.#ctx.classInfo(current)?.superClass?.identity
    }
    return depth
  }

  // ------------------------------------------------------------------------------------ reporting

  #report(diagnostic: Diagnostic): void {
    this.#config.report(diagnostic)
  }

  #reportOnce(key: string, diagnostic: Diagnostic): void {
    if (this.#reported.has(key)) return
    this.#reported.add(key)
    this.#report(diagnostic)
  }

  #mismatch(site: Site, message: string, hints: readonly string[]): void {
    const location = site.locate()
    const key = `${location?.file}:${location?.start}\0${message}`
    this.#reportOnce(key, {
      code: Codes.SchemaMismatch,
      severity: 'error',
      message,
      ...(location === undefined ? {} : { location }),
      ...(hints.length === 0 ? {} : { hints }),
      ...(site.sdl === undefined
        ? {}
        : { related: [{ message: `${site.coordinate} is declared here`, location: site.sdl }] }),
    })
  }

  // ----------------------------------------------------------------------------------- messages

  #describeParts(parts: Parts, optional: boolean): string {
    const members = parts.members.map(member => this.#describe(member))
    if (parts.hasNull) members.push('null')
    if (parts.hasUndefined || optional) members.push('undefined')
    return members.join(' | ')
  }

  /** Short description of a shape for messages (`string`, `Book`, `'a'`, `Book[]`). */
  #describe(shape: Shape): string {
    switch (shape.kind) {
      case 'literal':
        return JSON.stringify(shape.value)
      case 'named':
        return this.#named.get(shape.key)?.name ?? shape.key.slice(shape.key.indexOf('#') + 1)
      case 'reference':
        return shape.name
      case 'opaque':
        return shape.text
      case 'array':
        return `${this.#describe(shape.items)}[]`
      case 'union':
      case 'intersection':
        return shape.members.map(member => this.#describe(member)).join(shape.kind === 'union' ? ' | ' : ' & ')
      case 'object':
        return 'an object literal type'
      case 'tuple':
        return 'a tuple'
      default:
        return shape.kind
    }
  }
}
