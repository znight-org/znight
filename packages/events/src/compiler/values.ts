/**
 * Helpers on statically evaluated decorator arguments and their source locations.
 */
import type { ArgInfo, Location, Project, StaticValue } from '@znight/compiler'

type Expression = ArgInfo['node']

/** An evaluated object literal (not an array, not a reference to an exported binding). */
export function isRecord(value: StaticValue): value is Readonly<Record<string, StaticValue>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Short description of a value for messages (`"orders"`, `42`, `an array`...). */
export function describeValue(value: StaticValue): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return 'an array'
  return isRecord(value) ? 'an object' : `a reference to '${(value as { readonly text?: string }).text ?? '?'}'`
}

/**
 * Location of the property `key` of an object literal argument (`order: 1` in `@OnEvent({ order: 1 })`), or of the whole argument when it is not an inline object literal.
 */
export function propertyLocation(project: Project, arg: ArgInfo, key: string): Location {
  const node = unwrap(arg.node)
  if (node.type !== 'ObjectExpression') return arg.location
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed) continue
    const { key: name } = property
    const found =
      name.type === 'Identifier' ? name.name : name.type === 'Literal' && typeof name.value === 'string' && name.value
    if (found === key) return project.getFile(arg.location.file)?.location(property) ?? arg.location
  }
  return arg.location
}

/** The candidate closest to `input` (edit distance at most 2), for "did you mean" hints. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = 3
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
    }
    previous = current
  }
  return previous[b.length] as number
}

function unwrap(node: Expression): Expression {
  let current = node
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'ParenthesizedExpression'
  ) {
    current = current.expression
  }
  return current
}
