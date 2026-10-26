/**
 * Minimal, structural access to the oxc AST nodes exposed by `ClassInfo` / `ArgInfo` (escape
 * hatches of the extension API). The extension does not depend on `oxc-parser`: nodes are read
 * through this loose shape and checked at runtime.
 */
import type { ClassInfo, MethodInfo, ParameterInfo } from '@znight/compiler'

/** An ESTree node, read structurally. */
export interface AstNode {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly [key: string]: unknown
}

/** `true` for an object shaped like an AST node. */
export function isNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { start?: unknown }).start === 'number'
  )
}

/** The child node stored under `key`, when it is a node. */
export function child(node: AstNode, key: string): AstNode | undefined {
  const value = node[key]
  return isNode(value) ? value : undefined
}

/** The child nodes stored under `key`, when it is an array. */
export function children(node: AstNode, key: string): AstNode[] {
  const value = node[key]
  return Array.isArray(value) ? value.filter(isNode) : []
}

const WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
])

/** Removes parentheses and type-only wrappers (`x as T`, `x satisfies T`, `x!`, `<T>x`). */
export function unwrap(node: AstNode): AstNode {
  let current = node
  while (WRAPPERS.has(current.type)) {
    const inner = child(current, 'expression')
    if (!inner) {
      return current
    }
    current = inner
  }
  return current
}

/**
 * The default value expression of a method parameter (`page = 1` → `1`), found in the class
 * declaration by the location of the method key.
 */
export function defaultValueOf(cls: ClassInfo, method: MethodInfo, param: ParameterInfo): AstNode | undefined {
  const classNode = cls.declaration.node as unknown
  if (!isNode(classNode)) {
    return undefined
  }
  const body = child(classNode, 'body')
  if (!body) {
    return undefined
  }
  for (const member of children(body, 'body')) {
    const key = child(member, 'key')
    if (!key || key.start !== method.location.start) {
      continue
    }
    const fn = child(member, 'value')
    if (!fn) {
      return undefined
    }
    const params = children(fn, 'params').filter(node => !(node.type === 'Identifier' && node['name'] === 'this'))
    let pattern = params[param.index]
    if (pattern?.type === 'TSParameterProperty') {
      pattern = child(pattern, 'parameter')
    }
    return pattern?.type === 'AssignmentPattern' ? child(pattern, 'right') : undefined
  }
  return undefined
}
