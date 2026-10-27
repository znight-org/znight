/**
 * Route decisions (RFC 0001 §5.1, §5.2): route decorator groups as known at boot, the effective
 * metadata of a route (the nearest decision of a group wins) and the boot check of required and
 * enforced groups (ZNIGHT023).
 */
import type { CoreLogger } from '@znight/core'
import type { RouteDecoratorInfo } from './decorators.ts'
import type { HttpMetadata } from './metadata.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { GROUP_NAME } from './decorators.ts'

/** Route metadata: key → value. */
export type RouteMeta = Readonly<Record<string, unknown>>

/** Where a group declaration comes from (messages). */
interface Declaration {
  readonly group: string
  readonly required: boolean
  readonly source: string
}

/**
 * The route decorator groups of an application: the compiled `groups` metadata, completed by the
 * `enforces` declarations of the guards and the `meta` entries of plugin routes. A key absent from
 * every source is its own group, not required.
 */
export class RouteGroups {
  readonly #keys = new Map<string, Declaration>()
  readonly #groups = new Map<string, Declaration>()
  readonly #members = new Map<string, Set<string>>()

  /** Reads `metadata.extensions.http.groups` (ZNIGHT007 when malformed). */
  static fromMetadata(groups: HttpMetadata['groups']): RouteGroups {
    const result = new RouteGroups()
    if (groups === undefined) return result
    if (groups === null || typeof groups !== 'object' || Array.isArray(groups)) {
      throw malformed(`expected an object of { keys, required } (received ${describe(groups)})`)
    }
    for (const group of Object.keys(groups)) {
      const entry: unknown = groups[group]
      const { keys, required } = (entry ?? {}) as { keys?: unknown; required?: unknown }
      // a group is named explicitly (grammar) or after its single key (a decorator without group)
      const ownGroup = Array.isArray(keys) && keys.length === 1 && keys[0] === group
      if (!ownGroup && !GROUP_NAME.test(group)) throw malformed(`invalid group name ${JSON.stringify(group)}`)
      if (
        entry === null ||
        typeof entry !== 'object' ||
        !Array.isArray(keys) ||
        keys.length === 0 ||
        !keys.every(key => typeof key === 'string' && key !== '') ||
        new Set(keys).size !== keys.length ||
        typeof required !== 'boolean'
      ) {
        throw malformed(`group "${group}" must be { keys: [unique non-empty strings], required: boolean }`)
      }
      for (const key of keys as string[]) {
        const previous = result.#keys.get(key)
        if (previous !== undefined) {
          throw malformed(`the key "${key}" belongs to the groups "${previous.group}" and "${group}"`)
        }
        result.#add(key, { group, required, source: 'the compiled metadata' })
      }
    }
    return result
  }

  /**
   * Declares the group of a key (guard `enforces`, plugin route `meta`). A declaration that
   * contradicts an earlier one is ZNIGHT005.
   */
  declare(info: RouteDecoratorInfo, source: string): void {
    const known = this.#keys.get(info.key)
    if (known !== undefined && (known.group !== info.group || known.required !== info.required)) {
      throw conflict(
        `the route decorator "${info.key}" is declared with ${describeGroup(info)} by ${source} but with ${describeGroup({ key: info.key, ...known })} by ${known.source}`,
      )
    }
    const group = this.#groups.get(info.group)
    if (group !== undefined && group.required !== info.required) {
      throw conflict(
        `the "${info.group}" group is ${info.required ? '' : 'not '}required for "${info.key}" (${source}) but ${group.required ? '' : 'not '}required for ${[...(this.#members.get(info.group) ?? [])].map(key => `"${key}"`).join(', ')} (${group.source})`,
      )
    }
    if (known === undefined) this.#add(info.key, { group: info.group, required: info.required, source })
  }

  /** The group of a key (the key itself when no source declares one). */
  groupOf(key: string): string {
    return this.#keys.get(key)?.group ?? key
  }

  /** Groups every route must decide. */
  required(): Set<string> {
    const result = new Set<string>()
    for (const [group, declaration] of this.#groups) if (declaration.required) result.add(group)
    return result
  }

  /** Known keys of a group, sorted. */
  keysOf(group: string): string[] {
    return [...(this.#members.get(group) ?? [group])].sort()
  }

  #add(key: string, declaration: Declaration): void {
    this.#keys.set(key, declaration)
    if (!this.#groups.has(declaration.group)) this.#groups.set(declaration.group, declaration)
    let members = this.#members.get(declaration.group)
    if (members === undefined) {
      members = new Set()
      this.#members.set(declaration.group, members)
    }
    members.add(key)
  }
}

function describeGroup(info: { readonly key: string; readonly group: string; readonly required: boolean }): string {
  const group = info.group === info.key ? 'its own group' : `the group "${info.group}"`
  return info.required ? `${group} (required)` : group
}

/**
 * The effective metadata of a route: the controller's entries whose group the route does not
 * decide, then every entry of the route. Frozen.
 */
export function effectiveMeta(controller: RouteMeta, route: RouteMeta, groupOf: (key: string) => string): RouteMeta {
  const decided = new Set(Object.keys(route).map(groupOf))
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(controller)) {
    if (!decided.has(groupOf(key))) result[key] = controller[key]
  }
  return Object.freeze(Object.assign(result, route))
}

/** The key of `meta` sharing its group with another key, as `[first, second, group]`. */
export function conflictingKeys(
  meta: RouteMeta,
  groupOf: (key: string) => string,
): readonly [string, string, string] | undefined {
  const seen = new Map<string, string>()
  for (const key of Object.keys(meta)) {
    const group = groupOf(key)
    const first = seen.get(group)
    if (first !== undefined) return [first, key, group]
    seen.set(group, key)
  }
  return undefined
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
  if (!Array.isArray(enforces))
    throw invalidEnforces(name, `expected an array of route decorators (received ${describe(enforces)})`)
  for (const entry of enforces as unknown[]) {
    const info = (typeof entry === 'function' || (typeof entry === 'object' && entry !== null) ? entry : {}) as {
      key?: unknown
      group?: unknown
      required?: unknown
    }
    if (typeof info.key !== 'string' || typeof info.group !== 'string' || typeof info.required !== 'boolean') {
      throw invalidEnforces(
        name,
        `every entry must be a route decorator ({ key, group, required }), received ${describe(entry)}`,
      )
    }
  }
  return enforces as readonly RouteDecoratorInfo[]
}

function invalidEnforces(name: string, reason: string, cause?: unknown): ZnightError {
  return new ZnightError(
    ErrorCode.InvalidDecorator,
    `HttpPlugin: invalid static enforces of the guard ${name}: ${reason}`,
    {
      hints: [
        'static readonly enforces = [Public, Authenticated, Roles] (decorators created with createRouteDecorator)',
      ],
      ...(cause === undefined ? {} : { cause }),
    },
  )
}

/** A route as seen by the boot check: one per declared route (no HEAD or trailing-slash variant). */
export interface CheckedRoute {
  /** `GET /books (BookController.list)`. */
  readonly description: string
  /** Effective metadata. */
  readonly meta: RouteMeta
  /** Groups enforced by the guards of its chain (global, controller, route). */
  readonly enforced: ReadonlySet<string>
  /** Name of the plugin declaring the route, for plugin routes. */
  readonly plugin?: string
}

/** How the boot check reports problems. */
export type EnforcementMode = 'error' | 'warn'

/**
 * The boot check (RFC 0001 §5.2): every route decides every required group, and every decision of
 * a required or enforced group is enforced by a guard of the route's chain. A group is enforced when
 * a guard of some chain, or a guard class of the application (`enforcers`, in a chain or not),
 * declares it: a guard registered nowhere does not make its decisions inert. Problems are reported
 * as one ZNIGHT023 error (`'error'`) or one warning per group (`'warn'`).
 */
export function checkDecisions(
  routes: readonly CheckedRoute[],
  groups: RouteGroups,
  mode: EnforcementMode,
  logger: CoreLogger,
  enforcers: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): void {
  const required = groups.required()
  const known = new Set<string>(enforcers.keys())
  for (const route of routes) for (const group of route.enforced) known.add(group)
  const problems = new Map<string, { missing: string[]; unenforced: string[]; plugins: Set<string> }>()
  const problem = (group: string): { missing: string[]; unenforced: string[]; plugins: Set<string> } => {
    let entry = problems.get(group)
    if (entry === undefined) {
      entry = { missing: [], unenforced: [], plugins: new Set() }
      problems.set(group, entry)
    }
    return entry
  }
  for (const route of routes) {
    const decided = new Set(Object.keys(route.meta).map(key => groups.groupOf(key)))
    for (const group of required) {
      if (decided.has(group)) continue
      const entry = problem(group)
      entry.missing.push(route.description)
      if (route.plugin !== undefined) entry.plugins.add(route.plugin)
    }
    for (const group of decided) {
      if ((required.has(group) || known.has(group)) && !route.enforced.has(group)) {
        problem(group).unenforced.push(route.description)
      }
    }
  }
  if (problems.size === 0) return
  const messages: string[] = []
  const hints: string[] = []
  for (const group of [...problems.keys()].sort()) {
    const entry = problems.get(group) as { missing: string[]; unenforced: string[]; plugins: Set<string> }
    const keys = groups.keysOf(group)
    const parts: string[] = []
    const groupHints: string[] = []
    if (entry.missing.length > 0) {
      parts.push(
        `${count(entry.missing.length)} ${entry.missing.length === 1 ? 'has' : 'have'} no "${group}" decision: ${entry.missing.join(', ')}`,
      )
      groupHints.push(`Add a decision of the "${group}" group (${keys.join(', ')}) to the route or to its controller`)
      for (const plugin of [...entry.plugins].sort()) {
        groupHints.push(
          `Routes of the plugin "${plugin}" take their metadata from its options: meta: [Decorator.meta()]`,
        )
      }
    }
    if (entry.unenforced.length > 0) {
      parts.push(
        `no guard enforces the ${required.has(group) ? 'required ' : ''}"${group}" group on ${count(entry.unenforced.length)}: ${entry.unenforced.join(', ')}`,
      )
      groupHints.push(
        `Register a guard declaring \`static enforces\` with the decorators of the "${group}" group (${keys.join(', ')}), e.g. HttpPlugin.configure({ guards: [AuthGuard] })`,
      )
      const guards = [...(enforcers.get(group) ?? [])].sort()
      if (guards.length > 0) {
        groupHints.push(`Guards of the application enforcing the "${group}" group: ${guards.join(', ')}`)
      }
    }
    const message = parts.join('; ')
    if (mode === 'warn') {
      logger.warn(`HttpPlugin: ${message}`, { code: ErrorCode.MissingRouteDecision, group })
    } else {
      messages.push(message)
      hints.push(...groupHints)
    }
  }
  if (mode === 'error') {
    hints.push("Tests that deliberately run without guards can set enforcement: 'warn'")
    throw new ZnightError(ErrorCode.MissingRouteDecision, `HttpPlugin: ${capitalize(messages.join('; '))}`, { hints })
  }
}

function count(routes: number): string {
  return routes === 1 ? '1 route' : `${routes} routes`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function malformed(reason: string): ZnightError {
  return new ZnightError(ErrorCode.InvalidRoute, `Invalid metadata.extensions.http.groups: ${reason}`)
}

function conflict(reason: string): ZnightError {
  return new ZnightError(ErrorCode.InvalidDecorator, `HttpPlugin: inconsistent route decorator groups: ${reason}`, {
    hints: [
      'Every definition of a key must use the same options, and the decorators of a group must agree on required',
      'Regenerate the metadata when createRouteDecorator options changed',
    ],
  })
}

function describe(value: unknown): string {
  try {
    return typeof value === 'function' ? 'a function' : (JSON.stringify(value) ?? String(value))
  } catch {
    return typeof value
  }
}
