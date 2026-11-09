/**
 * The boot check of route decisions on GraphQL fields (RFC 0001 §5.2, RFC 0005 §5.9): every root
 * field decides every required group, and every decision of a required or enforced group is
 * enforced by a guard of the field's chain (`static enforces`). A group is enforced when a guard of
 * some chain, or a guard class of the application (in a chain or not, `canResolve()` or
 * `canActivate()`), declares it: a guard registered nowhere in GraphQL (an HTTP-only guard) does not
 * make the decisions of its groups inert. Problems are one ZNIGHT023 error (`enforcement: 'error'`)
 * or one warning per group.
 *
 * A small re-implementation of `@znight/http`'s internal checker for fields instead of routes.
 */
import type { CoreLogger } from '@znight/core'
import type { HttpRouteGroupDefinition, RouteDecoratorInfo } from '@znight/http'

import { ErrorCode, ZnightError } from '@znight/core'

/** A resolver-backed field as seen by the check. */
export interface CheckedField {
  /** `Query.books (BookResolver.books)`. */
  readonly description: string
  /** Root fields must decide every required group. */
  readonly root: boolean
  /** Effective metadata. */
  readonly meta: Readonly<Record<string, unknown>>
  /** Guard classes of its chain (global when they apply, class, method); instances give their constructor. */
  readonly guards: readonly { readonly cls: unknown; readonly name: string }[]
}

interface GroupInfo {
  readonly group: string
  readonly required: boolean
}

/** The groups listed by `static enforces` of a guard class (ZNIGHT005 when malformed). */
export function enforcedBy(guard: unknown, name: string): readonly RouteDecoratorInfo[] {
  if (typeof guard !== 'function') return []
  let enforces: unknown
  try {
    enforces = (guard as { enforces?: unknown }).enforces
  } catch (error) {
    throw invalidEnforces(name, 'reading it threw', error)
  }
  if (enforces === undefined) return []
  if (!Array.isArray(enforces)) throw invalidEnforces(name, 'expected an array of route decorators')
  for (const entry of enforces as unknown[]) {
    const info = (typeof entry === 'function' || (typeof entry === 'object' && entry !== null) ? entry : {}) as {
      key?: unknown
      group?: unknown
      required?: unknown
    }
    if (typeof info.key !== 'string' || typeof info.group !== 'string' || typeof info.required !== 'boolean') {
      throw invalidEnforces(name, 'every entry must be a route decorator ({ key, group, required })')
    }
  }
  return enforces as readonly RouteDecoratorInfo[]
}

function invalidEnforces(name: string, reason: string, cause?: unknown): ZnightError {
  return new ZnightError(
    ErrorCode.InvalidDecorator,
    `GraphQLPlugin: invalid static enforces of the guard ${name}: ${reason}`,
    {
      hints: [
        'static readonly enforces = [Public, Authenticated, Roles] (decorators created with createRouteDecorator)',
      ],
      ...(cause === undefined ? {} : { cause }),
    },
  )
}

/** A guard class of the application: a provider class with `canResolve()` or `canActivate()`. */
export function isGuardClass(cls: unknown): boolean {
  if (typeof cls !== 'function') return false
  const prototype: unknown = (cls as { prototype?: unknown }).prototype
  if (typeof prototype !== 'object' || prototype === null) return false
  const methods = prototype as { canResolve?: unknown; canActivate?: unknown }
  return typeof methods.canResolve === 'function' || typeof methods.canActivate === 'function'
}

/**
 * Runs the check. `groups`: `metadata.extensions.graphql.groups`; `applicationGuards`: the guard
 * classes of the application, whose groups only become known (they neither declare a group nor
 * make it required).
 */
export function checkFieldDecisions(
  fields: readonly CheckedField[],
  groups: Readonly<Record<string, HttpRouteGroupDefinition>> | undefined,
  mode: 'error' | 'warn',
  logger: CoreLogger,
  applicationGuards: readonly { readonly cls: unknown; readonly name: string }[] = [],
): void {
  const keys = new Map<string, GroupInfo>()
  const required = new Set<string>()
  for (const [group, definition] of Object.entries(groups ?? {})) {
    for (const key of definition.keys) keys.set(key, { group, required: definition.required })
    if (definition.required) required.add(group)
  }
  const enforcedOf = new Map<unknown, ReadonlySet<string>>()
  const enforced = (guard: { readonly cls: unknown; readonly name: string }): ReadonlySet<string> => {
    let groupsOf = enforcedOf.get(guard.cls)
    if (groupsOf === undefined) {
      const infos = enforcedBy(guard.cls, guard.name)
      for (const info of infos) {
        if (!keys.has(info.key)) keys.set(info.key, { group: info.group, required: info.required })
        if (info.required) required.add(info.group)
      }
      groupsOf = new Set(infos.map(info => info.group))
      enforcedOf.set(guard.cls, groupsOf)
    }
    return groupsOf
  }
  const chains = fields.map(field => {
    const set = new Set<string>()
    for (const guard of field.guards) for (const group of enforced(guard)) set.add(group)
    return set
  })
  const known = new Set<string>()
  for (const chain of chains) for (const group of chain) known.add(group)
  const enforcers = new Map<string, Set<string>>()
  for (const guard of applicationGuards) {
    for (const info of enforcedBy(guard.cls, guard.name)) {
      if (!keys.has(info.key)) keys.set(info.key, { group: info.group, required: info.required })
      known.add(info.group)
      let names = enforcers.get(info.group)
      if (names === undefined) {
        names = new Set()
        enforcers.set(info.group, names)
      }
      names.add(guard.name)
    }
  }
  const groupOf = (key: string): string => keys.get(key)?.group ?? key

  const problems = new Map<string, { missing: string[]; unenforced: string[] }>()
  const problem = (group: string): { missing: string[]; unenforced: string[] } => {
    let entry = problems.get(group)
    if (entry === undefined) {
      entry = { missing: [], unenforced: [] }
      problems.set(group, entry)
    }
    return entry
  }
  fields.forEach((field, index) => {
    const decided = new Set(Object.keys(field.meta).map(groupOf))
    if (field.root) {
      for (const group of required) if (!decided.has(group)) problem(group).missing.push(field.description)
    }
    const chain = chains[index] as Set<string>
    for (const group of decided) {
      if ((required.has(group) || known.has(group)) && !chain.has(group))
        problem(group).unenforced.push(field.description)
    }
  })
  if (problems.size === 0) return
  const messages: string[] = []
  const hints: string[] = []
  for (const group of [...problems.keys()].sort()) {
    const entry = problems.get(group) as { missing: string[]; unenforced: string[] }
    const members = [...keys]
      .filter(([, info]) => info.group === group)
      .map(([key]) => key)
      .sort()
    const parts: string[] = []
    if (entry.missing.length > 0) {
      parts.push(
        `${count(entry.missing.length)} ${entry.missing.length === 1 ? 'has' : 'have'} no "${group}" decision: ${entry.missing.join(', ')}`,
      )
      hints.push(
        `Add a decision of the "${group}" group (${members.join(', ') || group}) to the resolver method or to its class`,
      )
    }
    if (entry.unenforced.length > 0) {
      parts.push(
        `no guard enforces the "${group}" group on ${count(entry.unenforced.length)}: ${entry.unenforced.join(', ')}`,
      )
      hints.push(
        `Register a GraphQL guard declaring \`static enforces\` with the decorators of the "${group}" group: GraphQLPlugin.configure({ guards: [...] }) or @UseGuard(...)`,
      )
      const guards = [...(enforcers.get(group) ?? [])].sort()
      if (guards.length > 0) {
        hints.push(
          `Guards of the application enforcing the "${group}" group: ${guards.join(', ')} (a GraphQL guard needs canResolve())`,
        )
      }
    }
    const message = parts.join('; ')
    if (mode === 'warn') logger.warn(`GraphQLPlugin: ${message}`, { code: ErrorCode.MissingRouteDecision, group })
    else messages.push(message)
  }
  if (mode === 'error') {
    hints.push("Tests that deliberately run without guards can set enforcement: 'warn'")
    const text = messages.join('; ')
    throw new ZnightError(
      ErrorCode.MissingRouteDecision,
      `GraphQLPlugin: ${text.charAt(0).toUpperCase()}${text.slice(1)}`,
      {
        hints,
      },
    )
  }
}

function count(fields: number): string {
  return fields === 1 ? '1 field' : `${fields} fields`
}
