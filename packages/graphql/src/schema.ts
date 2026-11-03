/**
 * The `GraphQLSchema` of `metadata.extensions.graphql` (RFC 0005 §7.3, §8.1): structural checks of
 * the section (it can be hand-written), then graphql-js 17 constructors (thunks for cycles, every
 * type passed in metadata order so that `printSchema()` matches `printSdl()`), then
 * `validateSchema`. Every problem is collected and reported as one ZNIGHT066 error.
 *
 * Resolve functions are not decided here: the caller supplies them per resolver-backed field
 * (`pipeline.ts`), so this module stays about the shape of the schema.
 */
import type { ZnightMetadata } from '@znight/core'
import type {
  GraphQLArgumentConfig,
  GraphQLEnumValueConfig,
  GraphQLFieldConfig,
  GraphQLFieldResolver,
  GraphQLInputFieldConfig,
  GraphQLInputType,
  GraphQLNamedType,
  GraphQLOutputType,
} from 'graphql'
import type {
  GraphQLArgumentDefinition,
  GraphQLDiscriminator,
  GraphQLFieldDefinition,
  GraphQLInputTypeDefinition,
  GraphQLMetadata,
  GraphQLObjectTypeDefinition,
  GraphQLResolverBinding,
  GraphQLTypeDefinition,
} from './metadata.ts'
import type { GraphQLTypeRef } from './type-ref.ts'
import type { ScalarDefinition } from './types.ts'

import { ErrorCode, ZnightError } from '@znight/core'
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  validateSchema,
} from 'graphql'

import { GRAPHQL_METADATA_VERSION } from './metadata.ts'
import { BUILTIN_SCALARS, isGraphQLName, RESERVED_ENUM_VALUES, SPECIFIED_SCALARS } from './names.ts'
import { builtinScalar, definitionScalar } from './scalars.ts'
import { parseTypeRef } from './type-ref.ts'

/** The resolve functions of a resolver-backed field, decided by the caller (`pipeline.ts`). */
export interface FieldFunctions {
  readonly resolve?: GraphQLFieldResolver<unknown, unknown>
  /** Root subscription fields: the source event stream. */
  readonly subscribe?: GraphQLFieldResolver<unknown, unknown>
}

/** Builds the resolve functions of the field `coordinate` (`Query.books`) backed by `binding`. */
export type FieldFunctionsFactory = (
  binding: GraphQLResolverBinding,
  coordinate: string,
  field: GraphQLFieldDefinition,
  parent: GraphQLObjectTypeDefinition,
) => FieldFunctions

/** The graphql section of the metadata, or ZNIGHT066 when the application has none. */
export function graphqlSection(metadata: ZnightMetadata): GraphQLMetadata {
  const section: unknown = metadata.extensions?.graphql
  if (section === undefined) {
    throw new ZnightError(
      ErrorCode.InvalidGraphQLSetup,
      'GraphQLPlugin: the metadata has no GraphQL schema (metadata.extensions.graphql)',
      {
        hints: [
          'Declare at least one @Resolver() class with a @Query() method',
          'Regenerate the metadata (znight generate) when resolvers exist',
        ],
      },
    )
  }
  return section as GraphQLMetadata
}

const OPERATIONS: ReadonlySet<string> = new Set(['query', 'mutation', 'subscription', 'field'])
const INPUT_KINDS: ReadonlySet<string> = new Set(['input', 'enum', 'scalar'])
const OUTPUT_KINDS: ReadonlySet<string> = new Set(['object', 'enum', 'scalar', 'union'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function show(value: unknown): string {
  if (typeof value === 'function') return 'a function'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return typeof value
  }
}

/**
 * The structural problems of a graphql section (empty when it can be built): version, roots,
 * names, kinds, type references, resolver bindings, discriminators, scalars and groups.
 */
export function checkGraphQLSection(section: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(section)) return [`expected an object (received ${show(section)})`]
  if (section['version'] !== GRAPHQL_METADATA_VERSION) {
    problems.push(
      `unsupported version ${show(section['version'])}: this @znight/graphql reads version ${GRAPHQL_METADATA_VERSION} (rebuild the application with the same @znight/graphql version)`,
    )
    return problems
  }
  if (typeof section['schemaHash'] !== 'string') problems.push('schemaHash must be a string')
  const types = section['types']
  if (!Array.isArray(types)) {
    problems.push('types must be an array')
    return problems
  }
  const kinds = new Map<string, string>()
  for (const [index, type] of types.entries()) {
    if (!isRecord(type) || typeof type['name'] !== 'string' || typeof type['kind'] !== 'string') {
      problems.push(`types[${index}] must be { kind, name, ... } (received ${show(type)})`)
      continue
    }
    const name = type['name']
    if (!isGraphQLName(name)) problems.push(`invalid type name ${show(name)}`)
    else if (SPECIFIED_SCALARS.has(name)) problems.push(`the specified scalar ${name} must not be declared`)
    else if (kinds.has(name)) problems.push(`the type ${name} is declared twice`)
    kinds.set(name, type['kind'])
  }
  const kindOf = (name: string): string | undefined => (SPECIFIED_SCALARS.has(name) ? 'scalar' : kinds.get(name))
  const checkRef = (where: string, text: unknown, allowed: ReadonlySet<string>, position: string): void => {
    const ref = typeof text === 'string' ? parseTypeRef(text) : undefined
    if (ref === undefined) {
      problems.push(`${where}: invalid type reference ${show(text)}`)
      return
    }
    let named: GraphQLTypeRef = ref
    while (named.kind === 'list') named = named.of
    const kind = kindOf(named.name)
    if (kind === undefined) problems.push(`${where}: unknown type ${named.name}`)
    else if (!allowed.has(kind))
      problems.push(`${where}: ${named.name} (${kind}) cannot be used as an ${position} type`)
  }
  const checkInputValues = (where: string, values: unknown, required: boolean): void => {
    if (!Array.isArray(values) || (required && values.length === 0)) {
      problems.push(`${where} must be a ${required ? 'non-empty ' : ''}array`)
      return
    }
    const seen = new Set<string>()
    for (const value of values) {
      if (!isRecord(value) || typeof value['name'] !== 'string') {
        problems.push(`${where}: expected { name, type } (received ${show(value)})`)
        continue
      }
      const name = value['name']
      if (!isGraphQLName(name)) problems.push(`${where}: invalid name ${show(name)}`)
      if (seen.has(name)) problems.push(`${where}: ${name} is declared twice`)
      seen.add(name)
      checkRef(`${where}.${name}`, value['type'], INPUT_KINDS, 'input')
    }
  }
  for (const type of types) {
    if (!isRecord(type) || typeof type['name'] !== 'string') continue
    const name = type['name']
    switch (type['kind']) {
      case 'object': {
        const fields = type['fields']
        if (!Array.isArray(fields) || fields.length === 0) {
          problems.push(`${name}: fields must be a non-empty array`)
          break
        }
        const seen = new Set<string>()
        for (const field of fields) {
          if (!isRecord(field) || typeof field['name'] !== 'string') {
            problems.push(`${name}: expected fields { name, type } (received ${show(field)})`)
            continue
          }
          const coordinate = `${name}.${field['name']}`
          if (!isGraphQLName(field['name'])) problems.push(`${name}: invalid field name ${show(field['name'])}`)
          if (seen.has(field['name'])) problems.push(`${coordinate} is declared twice`)
          seen.add(field['name'])
          checkRef(coordinate, field['type'], OUTPUT_KINDS, 'output')
          if (field['args'] !== undefined) checkInputValues(`${coordinate} arguments`, field['args'], false)
          if (field['resolver'] !== undefined) checkBinding(coordinate, field['resolver'], problems)
        }
        break
      }
      case 'input':
        checkInputValues(`${name} fields`, type['fields'], true)
        break
      case 'enum': {
        const values = type['values']
        if (!Array.isArray(values) || values.length === 0) {
          problems.push(`${name}: values must be a non-empty array`)
          break
        }
        const seen = new Set<string>()
        for (const value of values) {
          const valueName = isRecord(value) ? value['name'] : undefined
          if (
            !isRecord(value) ||
            typeof valueName !== 'string' ||
            !isGraphQLName(valueName) ||
            RESERVED_ENUM_VALUES.has(valueName) ||
            (typeof value['value'] !== 'string' && typeof value['value'] !== 'number')
          ) {
            problems.push(`${name}: invalid enum value ${show(value)} (expected { name, value: string | number })`)
            continue
          }
          if (seen.has(valueName)) problems.push(`${name}.${valueName} is declared twice`)
          seen.add(valueName)
        }
        break
      }
      case 'union': {
        const members = type['members']
        if (!Array.isArray(members) || members.length === 0) {
          problems.push(`${name}: members must be a non-empty array`)
          break
        }
        for (const member of members) {
          if (typeof member !== 'string' || kinds.get(member) !== 'object') {
            problems.push(`${name}: the member ${show(member)} is not an object type`)
          }
        }
        checkDiscriminator(name, type['discriminator'], members, problems)
        break
      }
      case 'scalar':
        if (type['builtin'] === true) {
          if (!BUILTIN_SCALARS.has(name))
            problems.push(`${name} is not a built-in scalar (${[...BUILTIN_SCALARS.keys()].join(', ')})`)
        } else {
          const scalar = type['scalar']
          if (scalar instanceof GraphQLScalarType) {
            if (scalar.name !== name) {
              problems.push(
                `the scalar ${name} is implemented by the graphql-js scalar ${scalar.name} (names must match)`,
              )
            }
          } else if (
            !isRecord(scalar) ||
            typeof scalar['serialize'] !== 'function' ||
            typeof scalar['parseValue'] !== 'function' ||
            (scalar['parseLiteral'] !== undefined && typeof scalar['parseLiteral'] !== 'function')
          ) {
            problems.push(
              `the scalar ${name} needs a definition { serialize, parseValue, parseLiteral? } or a GraphQLScalarType (received ${show(scalar)})`,
            )
          }
        }
        break
      default:
        problems.push(`${name}: unknown kind ${show(type['kind'])}`)
    }
  }
  checkRoots(section['roots'], kinds, types, problems)
  checkGroups(section['groups'], problems)
  return problems
}

function checkBinding(coordinate: string, binding: unknown, problems: string[]): void {
  if (!isRecord(binding)) {
    problems.push(`${coordinate}: resolver must be an object (received ${show(binding)})`)
    return
  }
  const invalid: string[] = []
  if (typeof binding['token'] !== 'string' || binding['token'] === '') invalid.push('token')
  if (typeof binding['method'] !== 'string') invalid.push('method')
  if (typeof binding['operation'] !== 'string' || !OPERATIONS.has(binding['operation'])) invalid.push('operation')
  const guards = binding['guards']
  if (!Array.isArray(guards) || !guards.every(guard => typeof guard === 'string' && guard !== ''))
    invalid.push('guards')
  if (!isRecord(binding['meta'])) invalid.push('meta')
  if (typeof binding['invoke'] !== 'function') invalid.push('invoke')
  if (invalid.length > 0) problems.push(`${coordinate}: invalid resolver binding (${invalid.join(', ')})`)
}

function checkDiscriminator(
  name: string,
  discriminator: unknown,
  members: readonly unknown[],
  problems: string[],
): void {
  const memberSet = new Set(members)
  if (!isRecord(discriminator)) {
    problems.push(`${name}: discriminator must be an object (received ${show(discriminator)})`)
    return
  }
  switch (discriminator['by']) {
    case 'typename':
      return
    case 'property': {
      const values = discriminator['values']
      if (typeof discriminator['property'] !== 'string' || !isRecord(values)) {
        problems.push(`${name}: a property discriminator needs { property, values }`)
        return
      }
      for (const member of Object.values(values)) {
        if (!memberSet.has(member)) problems.push(`${name}: the discriminator names ${show(member)}, not a member`)
      }
      return
    }
    case 'class': {
      const classes = discriminator['classes']
      if (!Array.isArray(classes)) {
        problems.push(`${name}: a class discriminator needs classes: [Class, member][]`)
        return
      }
      for (const entry of classes) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'function' || !memberSet.has(entry[1])) {
          problems.push(`${name}: invalid class discriminator entry ${show(entry)} (expected [Class, member])`)
        }
      }
      return
    }
    default:
      problems.push(`${name}: unknown discriminator ${show(discriminator['by'])}`)
  }
}

function checkRoots(
  roots: unknown,
  kinds: ReadonlyMap<string, string>,
  types: readonly unknown[],
  problems: string[],
): void {
  if (!isRecord(roots) || typeof roots['query'] !== 'string') {
    problems.push(`roots must be { query, mutation?, subscription? } (received ${show(roots)})`)
    return
  }
  for (const operation of ['query', 'mutation', 'subscription'] as const) {
    const root = roots[operation]
    if (root === undefined) continue
    if (typeof root !== 'string' || kinds.get(root) !== 'object') {
      problems.push(`the ${operation} root ${show(root)} is not an object type`)
    }
  }
  const subscription = roots['subscription']
  if (typeof subscription !== 'string') return
  for (const type of types) {
    if (!isRecord(type) || type['name'] !== subscription || !Array.isArray(type['fields'])) continue
    for (const field of type['fields'] as unknown[]) {
      if (!isRecord(field)) continue
      const binding = field['resolver']
      if (!isRecord(binding) || binding['operation'] !== 'subscription') {
        problems.push(`${subscription}.${show(field['name'])} needs a subscription resolver (its source event stream)`)
      }
    }
  }
}

function checkGroups(groups: unknown, problems: string[]): void {
  if (groups === undefined) return
  if (!isRecord(groups)) {
    problems.push(`groups must be an object (received ${show(groups)})`)
    return
  }
  for (const [group, entry] of Object.entries(groups)) {
    const keys = isRecord(entry) ? entry['keys'] : undefined
    if (
      !isRecord(entry) ||
      !Array.isArray(keys) ||
      keys.length === 0 ||
      !keys.every(key => typeof key === 'string' && key !== '') ||
      typeof entry['required'] !== 'boolean'
    ) {
      problems.push(`group ${show(group)} must be { keys: [non-empty strings], required: boolean }`)
    }
  }
}

/** Throws one ZNIGHT066 error listing `problems`. */
export function invalidSchema(problems: readonly string[]): never {
  throw new ZnightError(
    ErrorCode.InvalidGraphQLSetup,
    `GraphQLPlugin: invalid GraphQL schema (metadata.extensions.graphql), ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`,
    {
      hints: [
        'Regenerate the metadata with the @znight/graphql version the application runs (znight generate)',
        'Hand-written metadata must follow GraphQLMetadata (@znight/graphql, RFC 0005 §7.1)',
      ],
    },
  )
}

/** A union's `resolveType`, from its discriminator: data read once, at boot. */
export function typeResolver(discriminator: GraphQLDiscriminator): (value: unknown) => string | undefined {
  switch (discriminator.by) {
    case 'property': {
      const property = discriminator.property
      const values = new Map(Object.entries(discriminator.values))
      return value =>
        value !== null && typeof value === 'object'
          ? (values.get(String((value as Record<string, unknown>)[property])) ?? typenameOf(value))
          : undefined
    }
    case 'class': {
      const classes = discriminator.classes
      return value => {
        for (const [cls, name] of classes) if (value instanceof cls) return name
        return typenameOf(value)
      }
    }
    default:
      return typenameOf
  }
}

function typenameOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const name = (value as { __typename?: unknown }).__typename
  return typeof name === 'string' ? name : undefined
}

/**
 * Builds the schema of a section. `functions` decides the resolve functions of every
 * resolver-backed field; plain property fields keep the graphql-js default resolver.
 *
 * @throws ZnightError ZNIGHT066 listing every structural, construction and `validateSchema` problem.
 */
export function buildGraphQLSchema(section: GraphQLMetadata, functions: FieldFunctionsFactory): GraphQLSchema {
  const structural = checkGraphQLSection(section)
  if (structural.length > 0) invalidSchema(structural)
  const named = new Map<string, GraphQLNamedType>([
    ['String', GraphQLString],
    ['Int', GraphQLInt],
    ['Float', GraphQLFloat],
    ['Boolean', GraphQLBoolean],
    ['ID', GraphQLID],
  ])
  const problems: string[] = []
  const lookup = (name: string): GraphQLNamedType => named.get(name) as GraphQLNamedType
  const typeOf = (ref: GraphQLTypeRef): GraphQLInputType & GraphQLOutputType => {
    const inner = ref.kind === 'named' ? lookup(ref.name) : new GraphQLList(typeOf(ref.of))
    return (ref.nonNull ? new GraphQLNonNull(inner) : inner) as GraphQLInputType & GraphQLOutputType
  }
  // references were checked by checkGraphQLSection
  const typeRef = (text: string): GraphQLInputType & GraphQLOutputType => typeOf(parseTypeRef(text) as GraphQLTypeRef)
  const inputValue = (value: GraphQLArgumentDefinition): GraphQLArgumentConfig & GraphQLInputFieldConfig => ({
    type: typeRef(value.type),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.deprecationReason === undefined ? {} : { deprecationReason: value.deprecationReason }),
    // external value (enum values by name): what printSdl() assumes (sdl.ts)
    ...(value.defaultValue === undefined ? {} : { default: { value: value.defaultValue } }),
  })
  const fieldConfig = (
    type: GraphQLObjectTypeDefinition,
    field: GraphQLFieldDefinition,
  ): GraphQLFieldConfig<unknown, unknown> => {
    const config: GraphQLFieldConfig<unknown, unknown> = {
      type: typeRef(field.type),
      ...(field.description === undefined ? {} : { description: field.description }),
      ...(field.deprecationReason === undefined ? {} : { deprecationReason: field.deprecationReason }),
      ...(field.args === undefined || field.args.length === 0
        ? {}
        : { args: Object.fromEntries(field.args.map(arg => [arg.name, inputValue(arg)])) }),
    }
    if (field.resolver === undefined) return config
    const resolved = functions(field.resolver, `${type.name}.${field.name}`, field, type)
    return {
      ...config,
      ...(resolved.resolve === undefined ? {} : { resolve: resolved.resolve }),
      ...(resolved.subscribe === undefined ? {} : { subscribe: resolved.subscribe }),
    }
  }
  try {
    for (const type of section.types) named.set(type.name, createType(type, fieldConfig, inputValue, lookup))
  } catch (error) {
    invalidSchema([`cannot build the schema: ${error instanceof Error ? error.message : String(error)}`])
  }
  const root = (name: string | undefined): GraphQLObjectType | undefined =>
    name === undefined ? undefined : (lookup(name) as GraphQLObjectType)
  let schema: GraphQLSchema | undefined
  try {
    schema = new GraphQLSchema({
      query: root(section.roots.query),
      mutation: root(section.roots.mutation),
      subscription: root(section.roots.subscription),
      // metadata order (sorted by name): printSchema() follows it, like printSdl()
      types: section.types.map(type => lookup(type.name)),
    })
    for (const error of validateSchema(schema)) problems.push(error.message)
  } catch (error) {
    // thunks run here: a resolver factory (a missing provider keeps its own code) or a constructor
    if (error instanceof ZnightError) throw error
    problems.push(error instanceof Error ? error.message : String(error))
  }
  if (problems.length > 0 || schema === undefined) invalidSchema(problems)
  return schema
}

function createType(
  type: GraphQLTypeDefinition,
  fieldConfig: (
    type: GraphQLObjectTypeDefinition,
    field: GraphQLFieldDefinition,
  ) => GraphQLFieldConfig<unknown, unknown>,
  inputValue: (value: GraphQLArgumentDefinition) => GraphQLInputFieldConfig,
  lookup: (name: string) => GraphQLNamedType,
): GraphQLNamedType {
  const description = 'description' in type && type.description !== undefined ? { description: type.description } : {}
  switch (type.kind) {
    case 'object':
      return new GraphQLObjectType({
        name: type.name,
        ...description,
        // thunk: object types reference each other (cycles)
        fields: () => Object.fromEntries(type.fields.map(field => [field.name, fieldConfig(type, field)])),
      })
    case 'input':
      return new GraphQLInputObjectType({
        name: type.name,
        ...description,
        fields: () =>
          Object.fromEntries((type as GraphQLInputTypeDefinition).fields.map(field => [field.name, inputValue(field)])),
      })
    case 'enum':
      return new GraphQLEnumType({
        name: type.name,
        ...description,
        values: Object.fromEntries(
          type.values.map((value): [string, GraphQLEnumValueConfig] => [
            value.name,
            {
              value: value.value,
              ...(value.description === undefined ? {} : { description: value.description }),
              ...(value.deprecationReason === undefined ? {} : { deprecationReason: value.deprecationReason }),
            },
          ]),
        ),
      })
    case 'union':
      return new GraphQLUnionType({
        name: type.name,
        ...description,
        types: () => type.members.map(member => lookup(member) as GraphQLObjectType),
        resolveType: typeResolver(type.discriminator),
      })
    default: {
      if ('builtin' in type) return builtinScalar(type.name) as GraphQLScalarType
      const scalar = type.scalar
      return scalar instanceof GraphQLScalarType
        ? scalar
        : definitionScalar(type.name, scalar as ScalarDefinition<unknown>)
    }
  }
}
