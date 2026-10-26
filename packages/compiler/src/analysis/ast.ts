/**
 * Small helpers over the oxc AST shared by the analysis modules.
 */
import type { Node, PropertyKey, TSAccessibility } from 'oxc-parser'
import type { Visibility } from '../extensions/api.ts'
import type { SourceFile } from '../project/index.ts'

/** Name of a class member key. */
export interface MemberName {
  /** `name`, `#name`, `quoted` (string literal keys), `[Symbol.asyncDispose]` (computed keys). */
  readonly name: string
  readonly privateName: boolean
  readonly computed: boolean
}

/** Name of a class member key (`computed` is the member's `computed` flag). */
export function memberName(file: SourceFile, key: PropertyKey, computed: boolean): MemberName {
  if (key.type === 'PrivateIdentifier') {
    return { name: `#${key.name}`, privateName: true, computed: false }
  }
  if (!computed) {
    if (key.type === 'Identifier') {
      return { name: key.name, privateName: false, computed: false }
    }
    if (key.type === 'Literal') {
      return { name: String(key.value), privateName: false, computed: false }
    }
  }
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return { name: String(key.value), privateName: false, computed: false }
  }
  return { name: `[${file.textOf(key).replace(/\s+/g, '')}]`, privateName: false, computed: true }
}

/** Visibility from a TypeScript accessibility modifier (`#private` names are private). */
export function visibilityOf(accessibility: TSAccessibility | null | undefined, privateName = false): Visibility {
  if (privateName) {
    return 'private'
  }
  return accessibility ?? 'public'
}

/**
 * Depth-first traversal of an AST subtree. `enter` returns `false` to skip the children of a node.
 * `parent` links are ignored.
 */
export function walk(root: Node, enter: (node: Node) => boolean | undefined): void {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push(current[index])
      }
      continue
    }
    if (typeof current !== 'object' || current === null || typeof (current as { type?: unknown }).type !== 'string') {
      continue
    }
    const node = current as Node
    if (enter(node) === false) {
      continue
    }
    const children: unknown[] = []
    for (const key in node) {
      if (key === 'parent') {
        continue
      }
      const value = (node as unknown as Record<string, unknown>)[key]
      if (typeof value === 'object' && value !== null) {
        children.push(value)
      }
    }
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index])
    }
  }
}
