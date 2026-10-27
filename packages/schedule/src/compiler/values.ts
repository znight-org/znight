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
 * Location of the property `key` of an object literal argument (`timeZone: 'X'` in
 * `@Cron('...', { timeZone: 'X' })`), or of the whole argument when it is not an inline object literal.
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

/**
 * Location of `[start, end)` inside a string argument, when the argument is a plain string literal
 * (or a template without substitutions) whose source text equals its value (no escapes). Otherwise
 * (a `const` reference...), the location of the argument.
 */
export function spanLocation(project: Project, arg: ArgInfo, value: string, start: number, end: number): Location {
  const text = arg.text
  const quote = text[0]
  const literal =
    (quote === "'" || quote === '"' || quote === '`') &&
    text.length === value.length + 2 &&
    text[text.length - 1] === quote &&
    text.slice(1, -1) === value
  if (!literal || start < 0 || end < start || end > value.length) return arg.location
  const offset = arg.location.start + 1
  const file = project.getFile(arg.location.file)
  if (file === undefined) return arg.location
  return file.location({ start: offset + start, end: offset + Math.max(end, start + 1) })
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
