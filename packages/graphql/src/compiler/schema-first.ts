/**
 * The schema-first model (RFC 0007): the SDL is the schema. `validate` loads and validates the
 * `.graphql` files (`sdl-source.ts`), binds every resolver method to its field by name (coverage,
 * §5.3), checks the resolver signatures against the SDL (`conformance.ts`, §5.4) and turns the
 * validated graphql-js schema into the same {@link GraphQLModel} as code-first, so that `generate`,
 * the SDL artifact, `schemaHash` and the runtime are shared.
 */
import type { ClassInfo, Diagnostic, Location, MethodInfo, ValidateContext } from '@znight/compiler'
import type {
  GraphQLArgument,
  GraphQLEnumType,
  GraphQLField,
  GraphQLInputField,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLUnionType,
} from 'graphql'
import type { Binding } from './conformance.ts'
import type { FieldData, GraphQLData, ResolverData } from './data.ts'
import type {
  ArgModel,
  FieldModel,
  GraphQLModel,
  InputModel,
  InterfaceModel,
  ObjectModel,
  ScalarModel,
  TypeModel,
  UnionModel,
} from './model.ts'
import type { ScalarDeclaration } from './scalars.ts'
import type { SdlSource } from './sdl-source.ts'

import { BUILTIN_SCALARS, SPECIFIED_SCALARS } from '../names.ts'
import { schemaHash } from '../schema-hash.ts'
import { printSdl } from '../sdl.ts'
import { parseTypeRef } from '../type-ref.ts'
import { checkDecisions, checkLoaders } from './checks.ts'
import { checkConformance } from './conformance.ts'
import { Codes, compareStrings } from './constants.ts'
import { graphqlModules } from './graphql-js.ts'
import { readScalars } from './scalars.ts'
import { loadSdl } from './sdl-source.ts'
import { sdlType } from './sdl-view.ts'
import { closest } from './suggest.ts'

type Context = ValidateContext<GraphQLData>
type Operation = 'query' | 'mutation' | 'subscription'

const DECORATORS: Readonly<Record<FieldData['operation'], string>> = {
  query: '@Query',
  mutation: '@Mutation',
  subscription: '@Subscription',
  field: '@ResolveField',
}

/** Builds the model from the SDL files matching `patterns`; `undefined` after an error. */
export function buildSchemaFirstModel(ctx: Context, patterns: readonly string[]): GraphQLModel | undefined {
  return new SchemaFirstBuilder(ctx).build(patterns)
}

class SchemaFirstBuilder {
  readonly #ctx: Context
  #errors = 0
  readonly #methods = new Map<string, MethodInfo | undefined>()

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  build(patterns: readonly string[]): GraphQLModel | undefined {
    const report = (diagnostic: Diagnostic): void => this.#report(diagnostic)
    const resolvers = [...this.#ctx.stored].sort((a, b) => compareStrings(a.host.identity, b.host.identity))
    checkLoaders(this.#ctx, resolvers, report)
    const scalarDeclarations = readScalars(this.#ctx, report)
    const sdl = loadSdl(this.#ctx, patterns, report)
    if (sdl === undefined) {
      checkDecisions(this.#ctx, resolvers, report)
      return undefined
    }
    const schema = sdl.schema
    const roots = {
      query: (schema.getQueryType() as GraphQLObjectType).name,
      ...(schema.getMutationType() ? { mutation: (schema.getMutationType() as GraphQLObjectType).name } : {}),
      ...(schema.getSubscriptionType()
        ? { subscription: (schema.getSubscriptionType() as GraphQLObjectType).name }
        : {}),
    }
    checkDecisions(this.#ctx, resolvers, report, roots)
    const types = Object.values(schema.getTypeMap())
      .filter(type => !type.name.startsWith('__') && !SPECIFIED_SCALARS.has(type.name))
      .sort((a, b) => compareStrings(a.name, b.name))
    this.#checkUnsupported(sdl, types)
    const scalars = this.#scalars(sdl, types, scalarDeclarations)
    const bindings = this.#bind(sdl, resolvers)
    const bound = new Set(bindings.map(binding => `${binding.type.name}.${binding.sdlField.name}`))
    const conformance = checkConformance({
      ctx: this.#ctx,
      schema,
      locate: node => sdl.locate(node),
      scalars: new Map([...scalarDeclarations.values()].map(declaration => [declaration.name, declaration])),
      bindings,
      bound,
      report,
    })
    if (this.#errors > 0) return undefined
    const byCoordinate = new Map(bindings.map(binding => [`${binding.type.name}.${binding.sdlField.name}`, binding]))
    const models: TypeModel[] = []
    for (const type of types) {
      const model = this.#model(sdl, type, byCoordinate, scalars, conformance)
      if (model !== undefined) models.push(model)
    }
    const meta = resolvers.flatMap(resolver => resolver.fields.flatMap(field => field.meta))
    const printed = printSdl({ roots, types: models.map(sdlType) })
    return { roots, types: models, meta, sdl: printed, schemaHash: schemaHash(printed) }
  }

  #report(diagnostic: Diagnostic): void {
    if (diagnostic.severity === 'error') this.#errors++
    this.#ctx.report(diagnostic)
  }

  #mismatch(
    location: Location | undefined,
    message: string,
    hints: readonly string[],
    related?: Diagnostic['related'],
  ): void {
    this.#report({
      code: Codes.SchemaMismatch,
      severity: 'error',
      message,
      ...(location === undefined ? {} : { location }),
      ...(hints.length === 0 ? {} : { hints }),
      ...(related === undefined || related.length === 0 ? {} : { related }),
    })
  }

  // ------------------------------------------------------------------------------- unsupported

  /** `@oneOf` input objects (the runtime does not model them). */
  #checkUnsupported(sdl: SdlSource, types: readonly GraphQLNamedType[]): void {
    const { isInputObjectType } = graphqlModules().type
    for (const type of types) {
      if (!isInputObjectType(type) || !type.isOneOf) continue
      const location = sdl.locate(type.astNode)
      this.#report({
        code: Codes.InvalidSdl,
        severity: 'error',
        message: `@oneOf input objects are not supported yet (${type.name})`,
        ...(location === undefined ? {} : { location }),
        hints: ['Declare one optional field per case and check that exactly one is set in the resolver'],
      })
    }
  }

  // ------------------------------------------------------------------------------------- scalars

  /** The scalar models: `scalar<T>()` declarations by name, the built-in scalars, else ZNIGHT067. */
  #scalars(
    sdl: SdlSource,
    types: readonly GraphQLNamedType[],
    declarations: ReadonlyMap<string, ScalarDeclaration>,
  ): ReadonlyMap<string, ScalarModel> {
    const { isScalarType } = graphqlModules().type
    const byName = new Map([...declarations.values()].map(declaration => [declaration.name, declaration]))
    const models = new Map<string, ScalarModel>()
    for (const type of types) {
      if (!isScalarType(type)) continue
      const location = sdl.locate(type.astNode)
      const declaration = byName.get(type.name)
      const description = type.description ?? undefined
      const specifiedByURL = type.specifiedByURL ?? undefined
      if (declaration !== undefined) {
        models.set(type.name, {
          kind: 'scalar',
          name: type.name,
          key: `#scalar:${declaration.identity}`,
          description,
          location,
          definition: declaration.identity,
          specifiedByURL,
          fromSdl: true,
        })
        continue
      }
      const builtin = BUILTIN_SCALARS.get(type.name)
      if (builtin !== undefined) {
        if (description !== undefined || (specifiedByURL !== undefined && specifiedByURL !== builtin.specifiedByURL)) {
          this.#report({
            code: Codes.InvalidSdl,
            severity: 'warning',
            message: `scalar ${type.name} is the built-in scalar of @znight/graphql: its description and @specifiedBy in the SDL are ignored`,
            ...(location === undefined ? {} : { location }),
            hints: [
              `Remove them, or implement the scalar yourself: export const ${type.name}Scalar = scalar<T>('${type.name}', { ... })`,
            ],
          })
        }
        models.set(type.name, {
          kind: 'scalar',
          name: type.name,
          key: `#builtin:${type.name}`,
          description: undefined,
          location,
          definition: undefined,
          specifiedByURL: undefined,
        })
        continue
      }
      this.#report({
        code: Codes.InvalidSdl,
        severity: 'error',
        message: `scalar ${type.name} has no implementation: declare it with scalar<T>('${type.name}', ...)`,
        ...(location === undefined ? {} : { location }),
        hints: [
          `export const ${type.name}Scalar = scalar<${type.name}>('${type.name}', { serialize: value => value as ${type.name}, parseValue: value => value as ${type.name} }), with ${type.name} the TypeScript type of its values (the one graphql-codegen maps it to)`,
        ],
      })
    }
    return models
  }

  // ------------------------------------------------------------------------------------- binding

  /** Binds every resolver method to its SDL field (coverage, RFC 0007 §5.3). */
  #bind(sdl: SdlSource, resolvers: readonly ResolverData[]): Binding[] {
    const schema = sdl.schema
    const bindings: Binding[] = []
    const byCoordinate = new Map<string, Binding>()
    for (const resolver of resolvers) {
      const target = this.#resolverType(sdl, resolver)
      for (const field of resolver.fields) {
        if (!field.complete) continue
        const method = this.#method(resolver, field)
        if (method === undefined) continue
        const where = `${resolver.host.displayName}.${field.method}`
        let type: GraphQLObjectType | undefined
        if (field.operation === 'field') {
          type = target
          if (type === undefined) continue
        } else {
          type = rootType(schema, field.operation)
          if (type === undefined) {
            const name = ROOTS[field.operation]
            this.#mismatch(field.location, `${DECORATORS[field.operation]} ${where}: the schema has no ${name} type`, [
              `Declare it in the SDL: type ${name} { ${field.name}: ... }`,
            ])
            continue
          }
        }
        const sdlField = type.getFields()[field.name]
        if (sdlField === undefined) {
          this.#unknownField(schema, type, field, where)
          continue
        }
        const coordinate = `${type.name}.${field.name}`
        const previous = byCoordinate.get(coordinate)
        if (previous !== undefined) {
          this.#report({
            code: Codes.NameConflict,
            severity: 'error',
            message: `Two resolvers bind ${coordinate}: ${where} and ${previous.resolver.host.displayName}.${previous.field.method}`,
            location: field.location,
            related: [{ message: 'the other resolver', location: previous.field.location }],
            hints: ['Keep one of them'],
          })
          continue
        }
        this.#checkArguments(sdl, field, method, sdlField, coordinate, where)
        const binding: Binding = { resolver, field, method, type, sdlField }
        byCoordinate.set(coordinate, binding)
        bindings.push(binding)
      }
    }
    for (const operation of ['query', 'mutation', 'subscription'] as const) {
      const root = rootType(schema, operation)
      if (root === undefined) continue
      for (const field of Object.values(root.getFields())) {
        if (byCoordinate.has(`${root.name}.${field.name}`)) continue
        this.#mismatch(sdl.locate(field.astNode), `Root field ${root.name}.${field.name} has no resolver`, [
          `Add a method to a @Resolver() class: ${DECORATORS[operation]}() ${field.name}(...) (or ${DECORATORS[operation]}('${field.name}') on another method)`,
        ])
      }
    }
    return bindings
  }

  /** The object type of `@Resolver('Type')`, reported when it is not one. */
  #resolverType(sdl: SdlSource, resolver: ResolverData): GraphQLObjectType | undefined {
    const typeName = resolver.typeName
    if (typeName === undefined) return undefined
    const { isObjectType, isInterfaceType } = graphqlModules().type
    const schema = sdl.schema
    const type = schema.getType(typeName.name)
    const owner = resolver.host.displayName
    if (type === undefined) {
      const objects = Object.values(schema.getTypeMap())
        .filter(candidate => isObjectType(candidate) && !candidate.name.startsWith('__'))
        .map(candidate => candidate.name)
        .sort(compareStrings)
      const suggestion = closest(typeName.name, objects)
      this.#mismatch(
        typeName.location,
        `@Resolver('${typeName.name}') of ${owner}: the schema has no type ${typeName.name}`,
        [
          suggestion === undefined
            ? `Declare it in the SDL: type ${typeName.name} { ... }`
            : `Did you mean '${suggestion}'?`,
        ],
      )
      return undefined
    }
    const declared = sdl.locate(type.astNode)
    const related = declared === undefined ? [] : [{ message: `${type.name} is declared here`, location: declared }]
    if (isInterfaceType(type)) {
      const implementations = schema.getPossibleTypes(type).map(object => object.name)
      this.#mismatch(
        typeName.location,
        `@Resolver('${type.name}') of ${owner}: ${type.name} is an interface, field resolvers bind the fields of object types`,
        [
          `Bind the field on each implementation: @Resolver('${implementations[0] ?? 'Book'}')${implementations.length > 1 ? ` (and ${implementations.slice(1).join(', ')})` : ''}`,
        ],
        related,
      )
      return undefined
    }
    if (!isObjectType(type)) {
      this.#mismatch(
        typeName.location,
        `@Resolver('${type.name}') of ${owner}: ${type.name} is not an object type, it has no field to resolve`,
        ['Name an object type of the SDL (type ... { ... })'],
        related,
      )
      return undefined
    }
    const operation = (['query', 'mutation', 'subscription'] as const).find(
      candidate => rootType(sdl.schema, candidate) === type,
    )
    if (operation !== undefined && resolver.fields.some(field => field.operation === 'field')) {
      this.#mismatch(
        typeName.location,
        `@Resolver('${type.name}') of ${owner}: ${type.name} is the ${operation} root type, its fields are bound with ${DECORATORS[operation]}()`,
        [`Replace @ResolveField() with ${DECORATORS[operation]}() and use @Resolver()`],
        related,
      )
      return undefined
    }
    return type
  }

  #unknownField(schema: GraphQLSchema, type: GraphQLObjectType, field: FieldData, where: string): void {
    const hints: string[] = []
    if (field.operation !== 'field') {
      const elsewhere = (['query', 'mutation', 'subscription'] as const).find(
        operation =>
          operation !== field.operation && rootType(schema, operation)?.getFields()[field.name] !== undefined,
      )
      if (elsewhere !== undefined) {
        hints.push(`${ROOTS[elsewhere]}.${field.name} exists: use ${DECORATORS[elsewhere]}()`)
      }
    }
    if (hints.length === 0) {
      const suggestion = closest(field.name, Object.keys(type.getFields()).sort(compareStrings))
      if (suggestion !== undefined) {
        hints.push(`Did you mean '${suggestion}'? ${DECORATORS[field.operation]}('${suggestion}')`)
      }
    }
    hints.push(
      `Declare it in the SDL (${field.operation === 'field' ? `extend type ${type.name}` : `extend type ${type.name}`} { ${field.name}: ... }), or remove the method`,
    )
    this.#mismatch(
      field.location,
      `${DECORATORS[field.operation]} ${where}: ${type.name} has no field '${field.name}'`,
      hints,
    )
  }

  /** `@Args('name')`: the argument must exist. */
  #checkArguments(
    sdl: SdlSource,
    field: FieldData,
    method: MethodInfo,
    sdlField: GraphQLField<unknown, unknown>,
    coordinate: string,
    where: string,
  ): void {
    const names = sdlField.args.map(arg => arg.name)
    field.params.forEach((param, index) => {
      if (param?.kind !== 'args' || param.name === undefined || names.includes(param.name)) return
      const suggestion = closest(param.name, [...names].sort(compareStrings))
      const declared = sdl.locate(sdlField.astNode)
      let hint = `Its arguments: ${names.join(', ')}`
      if (suggestion !== undefined) hint = `Did you mean '${suggestion}'?`
      else if (names.length === 0)
        hint = `${coordinate} takes no argument: declare it in the SDL, or remove the parameter`
      this.#mismatch(
        param.location,
        `@Args('${param.name}') on parameter '${method.params[index]?.name ?? param.name}' of ${where}: ${coordinate} has no argument '${param.name}'`,
        [hint],
        declared === undefined ? [] : [{ message: `${coordinate} is declared here`, location: declared }],
      )
    })
  }

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

  // --------------------------------------------------------------------------------------- model

  #model(
    sdl: SdlSource,
    type: GraphQLNamedType,
    bindings: ReadonlyMap<string, Binding>,
    scalars: ReadonlyMap<string, ScalarModel>,
    conformance: ReturnType<typeof checkConformance>,
  ): TypeModel | undefined {
    const { isObjectType, isInterfaceType, isInputObjectType, isEnumType, isUnionType } = graphqlModules().type
    const base = {
      name: type.name,
      key: `#sdl:${type.name}`,
      description: type.description ?? undefined,
      location: sdl.locate(type.astNode),
    }
    const nulls = conformance.nullAsUndefined
    if (isObjectType(type) || isInterfaceType(type)) {
      const fields = Object.values(type.getFields()).map(field =>
        this.#field(sdl, type, field, bindings.get(`${type.name}.${field.name}`), nulls),
      )
      const interfaces = type.getInterfaces().map(implemented => implemented.name)
      if (isInterfaceType(type)) {
        const model: InterfaceModel = {
          ...base,
          kind: 'interface',
          fields,
          interfaces,
          discriminator: conformance.discriminators.get(type.name),
        }
        return model
      }
      const model: ObjectModel = {
        ...base,
        kind: 'object',
        fields,
        trail: type.name,
        root: undefined,
        classIdentity: undefined,
        properties: [],
        interfaces,
      }
      return model
    }
    if (isInputObjectType(type)) {
      const model: InputModel = {
        ...base,
        kind: 'input',
        fields: Object.values((type as GraphQLInputObjectType).getFields()).map(field =>
          inputValue(sdl, field, `${type.name}.${field.name}`, nulls),
        ),
      }
      return model
    }
    if (isEnumType(type)) {
      return {
        ...base,
        kind: 'enum',
        values: (type as GraphQLEnumType).getValues().map(value => ({
          name: value.name,
          value: value.name,
          description: value.description ?? undefined,
          deprecationReason: value.deprecationReason ?? undefined,
        })),
      }
    }
    if (isUnionType(type)) {
      const model: UnionModel = {
        ...base,
        kind: 'union',
        members: (type as GraphQLUnionType)
          .getTypes()
          .map(member => member.name)
          .sort(compareStrings),
        discriminator: conformance.discriminators.get(type.name),
      }
      return model
    }
    return scalars.get((type as GraphQLScalarType).name)
  }

  #field(
    sdl: SdlSource,
    type: GraphQLObjectType | GraphQLInterfaceType,
    field: GraphQLField<unknown, unknown>,
    binding: Binding | undefined,
    nulls: ReadonlySet<string>,
  ): FieldModel {
    const coordinate = `${type.name}.${field.name}`
    return {
      name: field.name,
      type: String(field.type),
      description: field.description ?? undefined,
      deprecationReason: field.deprecationReason ?? undefined,
      args: field.args.map(arg => inputValue(sdl, arg, `${coordinate}(${arg.name}:)`, nulls)),
      binding: binding === undefined ? undefined : { resolver: binding.resolver, field: binding.field },
      location: sdl.locate(field.astNode),
    }
  }
}

const ROOTS: Readonly<Record<Operation, string>> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
}

function rootType(schema: GraphQLSchema, operation: Operation): GraphQLObjectType | undefined {
  switch (operation) {
    case 'query':
      return schema.getQueryType() ?? undefined
    case 'mutation':
      return schema.getMutationType() ?? undefined
    default:
      return schema.getSubscriptionType() ?? undefined
  }
}

/** An argument or an input field: its default as an external value (enum values by name). */
function inputValue(
  sdl: SdlSource,
  value: GraphQLArgument | GraphQLInputField,
  coordinate: string,
  nulls: ReadonlySet<string>,
): ArgModel {
  const type = String(value.type)
  const ref = parseTypeRef(type) as NonNullable<ReturnType<typeof parseTypeRef>>
  const defaultInput = value.default
  let defaultValue: unknown
  if (defaultInput !== undefined) {
    defaultValue =
      defaultInput.literal === undefined
        ? defaultInput.value
        : graphqlModules().utilities.valueFromASTUntyped(defaultInput.literal)
  }
  return {
    name: value.name,
    type,
    ref,
    description: value.description ?? undefined,
    deprecationReason: value.deprecationReason ?? undefined,
    defaultValue,
    nullAsUndefined: !ref.nonNull && nulls.has(coordinate),
    location: sdl.locate(value.astNode),
  }
}
