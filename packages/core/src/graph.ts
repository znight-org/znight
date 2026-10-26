/**
 * Graph algorithms of the container (internal): dependency plans, merged topological order,
 * scope validation, closures and missing dependencies. Everything is O(providers + edges).
 */

import type { DependencyRef, Token } from './metadata.ts'

import { ErrorCode, ZnightError } from './errors.ts'
import {
  DEP_LAZY,
  DEP_MULTI,
  DEP_OPTIONAL,
  DEP_REQUIRED,
  type DepPlan,
  REQUEST,
  SINGLETON,
  type Slot,
  TRANSIENT,
  UNBOUND,
} from './slot.ts'
import { describeToken, formatPath } from './tokens.ts'

const WHITE = 0
const GRAY = 1
const BLACK = 2

/** Resolves the dependencies of a provider slot into a plan and dependency edges. */
export function buildPlan(slot: Slot, lookup: (token: Token) => Slot): void {
  const definition = slot.definition
  if (definition === undefined) return
  const plan: DepPlan[] = []
  const edges: Slot[] = []
  const lazyEdges: Slot[] = []
  definition.deps.forEach((ref: DependencyRef, index) => {
    if (typeof ref === 'string') {
      const target = lookup(ref)
      plan.push({ kind: DEP_REQUIRED, slot: target, slots: undefined })
      edges.push(target)
    } else if (ref !== null && typeof ref === 'object' && 'multi' in ref && Array.isArray(ref.multi)) {
      const targets = ref.multi.map(lookup)
      plan.push({ kind: DEP_MULTI, slot: undefined, slots: targets })
      edges.push(...targets)
    } else if (ref !== null && typeof ref === 'object' && 'lazy' in ref && typeof ref.lazy === 'string') {
      const target = lookup(ref.lazy)
      plan.push({ kind: DEP_LAZY, slot: target, slots: undefined })
      lazyEdges.push(target)
    } else if (ref !== null && typeof ref === 'object' && 'token' in ref && typeof ref.token === 'string') {
      const target = lookup(ref.token)
      plan.push({ kind: DEP_OPTIONAL, slot: target, slots: undefined })
      edges.push(target)
    } else {
      throw new ZnightError(
        ErrorCode.InvalidDecorator,
        `Invalid dependency #${index} of ${describeToken(slot.token)}: ${safeJson(ref)}`,
        { hints: ['Expected a token, { token, optional: true }, { multi: [...] } or { lazy: token }'] },
      )
    }
  })
  slot.plan = plan
  slot.edges = edges
  slot.lazyEdges = lazyEdges
}

/**
 * Depth-first topological sort over hard edges (lazy edges are ignored: `Lazy<T>` breaks cycles).
 * Visiting `base` in order keeps the compiled `resolutionOrder` unchanged and inserts runtime
 * definitions right before their first dependent.
 *
 * @throws ZnightError (ZNIGHT002) on a cycle.
 */
export function computeOrder(base: Iterable<Slot>): Slot[] {
  const order: Slot[] = []
  const stack: Slot[] = []
  const cursors: number[] = []
  for (const root of base) {
    if (!root.isProvider || root.mark !== WHITE) continue
    root.mark = GRAY
    stack.push(root)
    cursors.push(0)
    while (stack.length > 0) {
      const top = stack.length - 1
      const slot = stack[top] as Slot
      const cursor = cursors[top] as number
      if (cursor < slot.edges.length) {
        cursors[top] = cursor + 1
        const next = slot.edges[cursor] as Slot
        if (!next.isProvider || next.mark === BLACK) continue
        if (next.mark === GRAY) throw cycleError([...stack.slice(stack.indexOf(next)), next])
        next.mark = GRAY
        stack.push(next)
        cursors.push(0)
      } else {
        slot.mark = BLACK
        slot.order = order.length
        order.push(slot)
        stack.pop()
        cursors.pop()
      }
    }
  }
  return order
}

function cycleError(cycle: readonly Slot[]): ZnightError {
  const path = cycle.map(slot => slot.token)
  return new ZnightError(ErrorCode.CircularDependency, `Circular dependency: ${formatPath(path)}`, {
    hints: [
      'Inject one of these dependencies as Lazy<T> and call get() when needed',
      `Tokens: ${path.slice(0, -1).join(', ')}`,
    ],
  })
}

/** Whether resolving `slot` requires an active request scope. */
function requiresScope(slot: Slot): boolean {
  if (slot.isProvider) return slot.needsScope
  return slot.mode === UNBOUND && slot.external?.scope === 'request'
}

/**
 * Computes `needsScope` and `waits` (singletons to wait for, through transients) for every slot of
 * `order` (dependencies first).
 *
 * @throws ZnightError (ZNIGHT003) when a singleton depends on request-scoped state.
 */
export function analyseScopes(order: readonly Slot[]): void {
  for (const slot of order) {
    let needsScope = slot.mode === REQUEST
    let waits: Set<Slot> | undefined
    for (const dep of slot.edges) {
      if (requiresScope(dep)) {
        if (slot.mode === SINGLETON) throw scopeMismatchError(slot, dep)
        needsScope = true
      }
      if (dep.mode === SINGLETON) {
        waits ??= new Set()
        waits.add(dep)
      } else if (dep.mode === TRANSIENT && dep.waits.length > 0) {
        waits ??= new Set()
        for (const wait of dep.waits) waits.add(wait)
      }
    }
    slot.needsScope = needsScope
    slot.waits = waits === undefined ? [] : [...waits]
  }
}

function scopeMismatchError(singleton: Slot, dep: Slot): ZnightError {
  const path = [singleton.token]
  let current: Slot | undefined = dep
  while (current !== undefined && !path.includes(current.token)) {
    path.push(current.token)
    if (current.mode !== TRANSIENT) break
    current = current.edges.find(requiresScope)
  }
  const target = path[path.length - 1] as Token
  return new ZnightError(
    ErrorCode.ScopeMismatch,
    `Scope mismatch: singleton ${singleton.displayName} depends on request-scoped ${describeToken(target)} (${formatPath(path)})`,
    {
      hints: [
        `Inject it as Lazy<T> and call get() inside the request, or make ${singleton.displayName} request-scoped`,
      ],
    },
  )
}

/** Every slot reachable from `roots` through hard and lazy edges (roots included). */
export function closureOf(roots: Iterable<Slot>): Set<Slot> {
  const seen = new Set<Slot>()
  const queue = [...roots]
  for (let index = 0; index < queue.length; index++) {
    const slot = queue[index] as Slot
    if (seen.has(slot)) continue
    seen.add(slot)
    for (const edge of slot.edges) if (!seen.has(edge)) queue.push(edge)
    for (const edge of slot.lazyEdges) if (!seen.has(edge)) queue.push(edge)
  }
  return seen
}

/** Whether `slot` cannot be resolved at all (unbound and not satisfiable from a scope or as optional). */
export function isMissing(slot: Slot): boolean {
  return slot.mode === UNBOUND && !slot.isSatisfiedExternally
}

/** Missing required dependencies of `slots`, with the providers requiring them (in encounter order). */
export function findMissing(slots: Iterable<Slot>): Map<Slot, Slot[]> {
  const missing = new Map<Slot, Slot[]>()
  const record = (target: Slot, dependent: Slot): void => {
    if (!isMissing(target)) return
    const dependents = missing.get(target)
    if (dependents === undefined) missing.set(target, [dependent])
    else if (!dependents.includes(dependent)) dependents.push(dependent)
  }
  for (const slot of slots) {
    if (slot.plan === undefined) continue
    for (const dep of slot.plan) {
      if (dep.kind === DEP_REQUIRED || dep.kind === DEP_LAZY) record(dep.slot as Slot, slot)
      else if (dep.kind === DEP_MULTI) for (const target of dep.slots as readonly Slot[]) record(target, slot)
    }
  }
  return missing
}

/** ZNIGHT001 listing every missing dependency, its dependents and the plugin expected to provide it. */
export function missingProvidersError(missing: ReadonlyMap<Slot, readonly Slot[]>): ZnightError {
  const lines: string[] = []
  const plugins = new Set<string>()
  for (const [slot, dependents] of missing) {
    let line = `  - ${describeToken(slot.token)}`
    const providedBy = slot.external?.providedBy
    if (providedBy !== undefined) {
      line += `, provided by ${providedBy}`
      plugins.add(providedBy)
    }
    line +=
      dependents.length === 0
        ? ', requested by init({ only })'
        : `, required by ${dependents.map(dependent => dependent.displayName).join(', ')}`
    lines.push(line)
  }
  const count = missing.size
  const hints = [...plugins].map(plugin => `Add ${plugin} to Application.create({ plugins })`)
  hints.push('Supply values with Application.create({ providers }) or container.registerValue()')
  return new ZnightError(
    ErrorCode.MissingProvider,
    `${count === 1 ? 'A required provider is' : `${count} required providers are`} missing:\n${lines.join('\n')}`,
    { hints },
  )
}

/**
 * A dependency path ending with `target`, starting from a provider nothing depends on (used to
 * explain why `target` was instantiated).
 */
export function dependentPath(target: Slot, providers: Iterable<Slot>): Token[] {
  const dependents = new Map<Slot, Slot>()
  for (const slot of providers) {
    for (const edge of slot.edges) if (!dependents.has(edge)) dependents.set(edge, slot)
  }
  const path: Slot[] = [target]
  let current = dependents.get(target)
  while (current !== undefined && !path.includes(current)) {
    path.unshift(current)
    current = dependents.get(current)
  }
  return path.map(slot => slot.token)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
