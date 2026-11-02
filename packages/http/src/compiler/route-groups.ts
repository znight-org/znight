/**
 * Route decorator groups of the application (RFC 0001 §5.1): every `createRouteDecorator`
 * definition, applied or not, the consistency of their options and the **required** groups.
 *
 * The http extension reports the inconsistencies (ZNIGHT005) and checks every route against the
 * required groups (ZNIGHT023). Other extensions whose targets carry route decorators (WebSocket
 * gateways, GraphQL root fields) call {@link requiredRouteGroups} to check their own targets with
 * exactly the same groups, without reporting the inconsistencies a second time.
 */
import type { Diagnostic, Location, ValidateContext } from '@znight/compiler'
import type { MetaEntry } from './model.ts'

import { compareStrings } from '../path.ts'
import { Codes, Ids } from './model.ts'
import { parseRouteDecoratorOptions } from './route-decorators.ts'

/** A route decorator definition of the application (`export const Roles = createRouteDecorator(...)`). */
export interface RouteGroupMember {
  /** Canonical identity of the decorator `const` (`src/auth/access.ts#Roles`). */
  readonly identity: string
  /** Name of the `const` (`Roles`). */
  readonly name: string
  readonly key: string
  /** Decision group (`options.group ?? key`). */
  readonly group: string
  readonly required: boolean
  /** Location of the definition. */
  readonly definition: Location
  /**
   * A flag (`@Public()`): created without type argument, and applied without argument wherever it
   * was seen. Decides how the decorator is suggested: `@Public()` or `@Roles(...)`.
   */
  readonly flag: boolean
}

/** A required route decorator group: every route-like target must carry a decision of it. */
export interface RequiredRouteGroup {
  /** Group name (`access`). */
  readonly group: string
  /** The decorators of the group, in source order (file, then position). Never empty. */
  readonly decorators: readonly RouteGroupMember[]
  /** The decorators as a hint: `@Public(), @Authenticated() or @Roles(...)`. */
  readonly suggestion: string
}

/** Result of {@link analyzeRouteGroups}. */
export interface RouteGroupsAnalysis {
  /** Inconsistent definitions (ZNIGHT005), at the second definition; not reported. */
  readonly conflicts: readonly Diagnostic[]
  /** The required groups, in the order of their first definition by identity. */
  readonly required: readonly RequiredRouteGroup[]
}

/** A definition while flags are computed. */
type MutableMember = { -readonly [K in keyof RouteGroupMember]: RouteGroupMember[K] }

/**
 * Every route decorator definition, sorted by identity: the applied ones (`applied`, first usage
 * wins) and, when the compiler provides `definitionsOf`, the ones applied nowhere (invalid ones are
 * left to the usages, which report them).
 */
function routeDecoratorDefinitions(
  ctx: Pick<ValidateContext<unknown>, 'definitionsOf'>,
  applied: Iterable<MetaEntry>,
): MutableMember[] {
  const definitions = new Map<string, MutableMember>()
  for (const entry of applied) {
    const known = definitions.get(entry.identity)
    if (known === undefined) {
      definitions.set(entry.identity, {
        identity: entry.identity,
        name: entry.decorator,
        key: entry.key,
        group: entry.group,
        required: entry.required,
        definition: entry.definition,
        flag: entry.value === true,
      })
    } else if (entry.value !== true) {
      known.flag = false
    }
  }
  // compilers before RFC 0001 have no definitionsOf: only applied decorators are known then
  const all = typeof ctx.definitionsOf === 'function' ? ctx.definitionsOf(Ids.createRouteDecorator) : []
  for (const found of all) {
    const [keyArg, optionsArg, ...extra] = found.args
    const key = keyArg?.evaluated === true ? keyArg.value : undefined
    if (
      typeof key !== 'string' ||
      key === '' ||
      extra.length > 0 ||
      (optionsArg !== undefined && !optionsArg.evaluated)
    ) {
      continue
    }
    const parsed = parseRouteDecoratorOptions(key, optionsArg?.value)
    if ('error' in parsed) {
      continue
    }
    const flag = found.typeArgs.length === 0
    const known = definitions.get(found.identity)
    if (known !== undefined) {
      known.flag &&= flag
      continue
    }
    definitions.set(found.identity, {
      identity: found.identity,
      name: found.name,
      key,
      ...parsed,
      definition: found.location,
      flag,
    })
  }
  return [...definitions.values()].sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * The route decorator groups of the application (RFC 0001 §5.1): every definition of a key must use
 * the same options and the decorators of a group must agree on `required` (a conflict is returned
 * at the second definition, which is then ignored); the required groups with their decorators.
 * `applied` are the entries of the targets the caller analysed (their first usage of a decorator
 * wins over its `definitionsOf` entry).
 */
export function analyzeRouteGroups(
  ctx: Pick<ValidateContext<unknown>, 'definitionsOf'>,
  applied: Iterable<MetaEntry>,
): RouteGroupsAnalysis {
  const definitions = routeDecoratorDefinitions(ctx, applied)
  if (definitions.length === 0) {
    return { conflicts: [], required: [] }
  }
  const conflicts: Diagnostic[] = []
  const byKey = new Map<string, RouteGroupMember>()
  const byGroup = new Map<string, RouteGroupMember>()
  const members = new Map<string, RouteGroupMember[]>()
  for (const definition of definitions) {
    const sameKey = byKey.get(definition.key)
    if (sameKey !== undefined && (sameKey.group !== definition.group || sameKey.required !== definition.required)) {
      conflicts.push({
        code: Codes.InvalidDecorator,
        severity: 'error',
        message: `The route decorator ${definition.name} defines the key "${definition.key}" with ${describeOptions(definition)}, but ${sameKey.name} defines it with ${describeOptions(sameKey)}`,
        location: definition.definition,
        hints: ['Every definition of a key must use the same options: share one definition'],
        related: [{ message: `${sameKey.name} is defined here`, location: sameKey.definition }],
      })
      continue
    }
    const sameGroup = byGroup.get(definition.group)
    if (sameGroup !== undefined && sameGroup.required !== definition.required) {
      conflicts.push({
        code: Codes.InvalidDecorator,
        severity: 'error',
        message: `The "${definition.group}" group is ${definition.required ? '' : 'not '}required for ${definition.name} but ${sameGroup.required ? '' : 'not '}required for ${sameGroup.name}`,
        location: definition.definition,
        hints: [`All the decorators of the "${definition.group}" group must agree on required`],
        related: [{ message: `${sameGroup.name} is defined here`, location: sameGroup.definition }],
      })
      continue
    }
    byKey.set(definition.key, sameKey ?? definition)
    byGroup.set(definition.group, sameGroup ?? definition)
    const list = members.get(definition.group) ?? []
    list.push(definition)
    members.set(definition.group, list)
  }
  const required: RequiredRouteGroup[] = []
  for (const first of byGroup.values()) {
    if (!first.required) {
      continue
    }
    // the decorators of the group in source order: `@Public(), @Authenticated() or @Roles(...)`
    const decorators = [...(members.get(first.group) ?? [first])]
      .sort((a, b) => compareStrings(a.definition.file, b.definition.file) || a.definition.start - b.definition.start)
      .map(member => Object.freeze({ ...member }))
    const usages = decorators.map(member => `@${member.name}(${member.flag ? '' : '...'})`)
    const suggestion =
      usages.length === 1 ? (usages[0] as string) : `${usages.slice(0, -1).join(', ')} or ${usages.at(-1) as string}`
    required.push(Object.freeze({ group: first.group, decorators: Object.freeze(decorators), suggestion }))
  }
  return { conflicts, required }
}

/**
 * The required route decorator groups of the application (RFC 0001): what every route-like target
 * of another extension (a gateway, a GraphQL root field) must decide, exactly as HTTP routes must.
 * A target without a decision of a returned group is **ZNIGHT023**, reported by the caller.
 *
 * `applied` are the route metadata entries the caller read on its own targets
 * ({@link readRouteMeta}): they make decorators known even when the compiler has no
 * `definitionsOf`, and refine how flags are suggested. Inconsistent definitions are left out and
 * not reported here: the http extension reports them (ZNIGHT005) once.
 *
 * ```ts
 * validate(ctx) {
 *   const required = requiredRouteGroups(ctx, ctx.stored.flatMap(gateway => gateway.meta))
 *   for (const gateway of ctx.stored)
 *     for (const group of required)
 *       if (!gateway.meta.some(entry => entry.group === group.group))
 *         ctx.report({ code: 'ZNIGHT023', severity: 'error', message: `${gateway.name} has no "${group.group}" decision`,
 *           location: gateway.location, hints: [`Add ${group.suggestion} to ${gateway.name}`] })
 * }
 * ```
 */
export function requiredRouteGroups(
  ctx: ValidateContext<unknown>,
  applied: Iterable<MetaEntry> = [],
): readonly RequiredRouteGroup[] {
  return analyzeRouteGroups(ctx, applied).required
}

function describeOptions(entry: RouteGroupMember): string {
  const group = entry.group === entry.key ? 'no group' : `group "${entry.group}"`
  return entry.required ? `${group}, required` : group
}
