/**
 * `scalar<T>(name, definition)` declarations of the application (RFC 0005 §5.7): `T` (a plain type
 * reference, by identity) maps to the scalar `name` wherever it appears. The definition is an
 * exported value the generated module imports; its `description` and `specifiedByURL` are read
 * for the SDL when they are statically evaluable.
 */
import type { ArgInfo, Diagnostic, Location, ValidateContext } from '@znight/compiler'
import type { GraphQLData } from './data.ts'

import { isGraphQLName, SPECIFIED_SCALARS } from '../names.ts'
import { Codes } from './constants.ts'
import { GraphQLIds, SCALAR_ALIASES } from './ids.ts'

/** A valid `scalar<T>()` declaration. */
export interface ScalarDeclaration {
  /** GraphQL name. */
  readonly name: string
  /** Identity of the exported constant (imported by the generated module). */
  readonly identity: string
  /** Identity of `T`. */
  readonly type: string
  readonly description: string | undefined
  readonly specifiedByURL: string | undefined
  /** Location of the constant's name. */
  readonly location: Location
}

/** Valid declarations by the identity of their type; invalid ones are reported. */
export function readScalars(
  ctx: ValidateContext<GraphQLData>,
  report: (diagnostic: Diagnostic) => void,
): ReadonlyMap<string, ScalarDeclaration> {
  const byType = new Map<string, ScalarDeclaration>()
  const byName = new Map<string, ScalarDeclaration>()
  for (const definition of ctx.definitionsOf(GraphQLIds.scalar)) {
    const fail = (message: string, hints: readonly string[], related: Diagnostic['related'] = []): void =>
      report({ code: Codes.InvalidDecorator, severity: 'error', message, location: definition.call, hints, related })
    const [nameArg, definitionArg] = definition.args
    const name = nameArg?.evaluated === true ? nameArg.value : undefined
    if (typeof name !== 'string') {
      fail(`scalar() of ${definition.name} needs a static name`, [`scalar<T>('Name', { ... })`])
      continue
    }
    if (!isGraphQLName(name) || SPECIFIED_SCALARS.has(name)) {
      report({
        code: Codes.NameConflict,
        severity: 'error',
        message: SPECIFIED_SCALARS.has(name)
          ? `'${name}' is a specified GraphQL scalar: scalar() cannot redefine it (${definition.name})`
          : `'${name}' is not a valid GraphQL scalar name (${definition.name})`,
        location: nameArg?.location ?? definition.call,
        hints: ['GraphQL names match /^[_A-Za-z][_0-9A-Za-z]*$/ and do not start with __'],
      })
      continue
    }
    const type = definition.typeArgIdentities?.[0]
    if (type === undefined) {
      report({
        code: Codes.InvalidType,
        severity: 'error',
        message: `scalar('${name}') of ${definition.name} needs a named type argument: scalar<T>('${name}', ...)`,
        location: definition.call,
        hints: [
          `Name the TypeScript type of the scalar: export type ${name} = string & { readonly __brand: '${name}' }, then scalar<${name}>('${name}', ...)`,
        ],
      })
      continue
    }
    if (SCALAR_ALIASES.has(type)) {
      fail(
        `scalar('${name}') of ${definition.name} cannot map ${type.slice(type.indexOf('#') + 1)}: it is a built-in scalar alias`,
        ['Declare a branded type for the scalar: export type Name = string & { readonly __brand: "Name" }'],
      )
      continue
    }
    if (!definition.exported) {
      fail(`The scalar ${definition.name} must be exported: the generated module imports it`, [
        `export const ${definition.name} = scalar<...>('${name}', ...)`,
      ])
      continue
    }
    const declaration: ScalarDeclaration = {
      name,
      identity: definition.identity,
      type,
      description: staticProperty(ctx, definitionArg, 'description'),
      specifiedByURL: staticProperty(ctx, definitionArg, 'specifiedByURL'),
      location: definition.location,
    }
    const sameType = byType.get(type)
    if (sameType !== undefined) {
      report({
        code: Codes.NameConflict,
        severity: 'error',
        message: `${definition.name} and ${sameType.identity} both map ${type.slice(type.indexOf('#') + 1)} to a scalar`,
        location: definition.location,
        related: [{ message: 'the other scalar', location: sameType.location }],
        hints: ['Keep one scalar per TypeScript type'],
      })
      continue
    }
    // a user scalar named like a built-in one (DateTime) only conflicts when both are used: the model reports it
    const sameName = byName.get(name)
    if (sameName !== undefined) {
      report({
        code: Codes.NameConflict,
        severity: 'error',
        message: `Two scalars are named '${name}': ${definition.identity} and ${sameName.identity}`,
        location: definition.location,
        related: [{ message: 'the other scalar', location: sameName.location }],
        hints: ['Rename one of them'],
      })
      continue
    }
    byType.set(type, declaration)
    byName.set(name, declaration)
  }
  return byType
}

/** A string property of an object literal argument, when statically evaluable. */
function staticProperty(ctx: ValidateContext<GraphQLData>, arg: ArgInfo | undefined, key: string): string | undefined {
  if (arg === undefined) return undefined
  if (arg.evaluated && typeof arg.value === 'object' && arg.value !== null && !Array.isArray(arg.value)) {
    const value = (arg.value as Readonly<Record<string, unknown>>)[key]
    return typeof value === 'string' ? value : undefined
  }
  const node = arg.node
  if (node.type !== 'ObjectExpression') return undefined
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed) continue
    const name = property.key.type === 'Identifier' ? property.key.name : undefined
    if (name !== key) continue
    const result = ctx.project.evaluate(arg.location.file, property.value, { refs: 'none' })
    return result.kind === 'value' && typeof result.value === 'string' ? result.value : undefined
  }
  return undefined
}
