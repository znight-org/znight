/**
 * Deterministic topological ordering (dependencies first, ties broken by token) and strongly
 * connected components, used by `resolutionOrder` and by the cycle validation (ZNIGHT002).
 */
import type { Token } from '@znight/core'

import { compareStrings } from '../project/compare.ts'

/** Min-heap of strings (compareStrings order). */
class StringHeap {
  readonly #items: string[] = []

  get size(): number {
    return this.#items.length
  }

  push(value: string): void {
    const items = this.#items
    items.push(value)
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (compareStrings(items[parent] as string, value) <= 0) {
        break
      }
      items[index] = items[parent] as string
      index = parent
    }
    items[index] = value
  }

  pop(): string | undefined {
    const items = this.#items
    const top = items[0]
    const last = items.pop()
    if (items.length > 0 && last !== undefined) {
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        let smallestValue = last
        if (left < items.length && compareStrings(items[left] as string, smallestValue) < 0) {
          smallest = left
          smallestValue = items[left] as string
        }
        if (right < items.length && compareStrings(items[right] as string, smallestValue) < 0) {
          smallest = right
        }
        if (smallest === index) {
          break
        }
        items[index] = items[smallest] as string
        index = smallest
      }
      items[index] = last
    }
    return top
  }
}

/**
 * Topological order of `nodes` where `dependencies(node)` must come first. Among ready nodes the
 * smallest token comes first. Nodes on cycles are appended at the end in token order (the cycle
 * itself is reported by ZNIGHT002).
 */
export function topologicalOrder(nodes: readonly Token[], dependencies: (node: Token) => Iterable<Token>): Token[] {
  const known = new Set(nodes)
  const pending = new Map<Token, number>()
  const dependents = new Map<Token, Token[]>()
  for (const node of nodes) {
    const unique = new Set<Token>()
    for (const dependency of dependencies(node)) {
      if (known.has(dependency) && dependency !== node) {
        unique.add(dependency)
      }
    }
    pending.set(node, unique.size)
    for (const dependency of unique) {
      const list = dependents.get(dependency)
      if (list) {
        list.push(node)
      } else {
        dependents.set(dependency, [node])
      }
    }
  }
  const heap = new StringHeap()
  for (const [node, count] of pending) {
    if (count === 0) {
      heap.push(node)
    }
  }
  const order: Token[] = []
  while (heap.size > 0) {
    const node = heap.pop() as Token
    order.push(node)
    for (const dependent of dependents.get(node) ?? []) {
      const count = (pending.get(dependent) ?? 0) - 1
      pending.set(dependent, count)
      if (count === 0) {
        heap.push(dependent)
      }
    }
  }
  if (order.length < nodes.length) {
    const placed = new Set(order)
    order.push(...nodes.filter(node => !placed.has(node)).sort(compareStrings))
  }
  return order
}

/**
 * Strongly connected components (Tarjan, iterative). Each component is sorted; components are
 * returned sorted by their first token. `successors` must be deterministic.
 */
export function stronglyConnectedComponents(
  nodes: readonly Token[],
  successors: (node: Token) => readonly Token[],
): Token[][] {
  const index = new Map<Token, number>()
  const lowLink = new Map<Token, number>()
  const onStack = new Set<Token>()
  const stack: Token[] = []
  const components: Token[][] = []
  let counter = 0
  for (const root of [...nodes].sort(compareStrings)) {
    if (index.has(root)) {
      continue
    }
    const work: { node: Token; next: number }[] = [{ node: root, next: 0 }]
    index.set(root, counter)
    lowLink.set(root, counter)
    counter++
    stack.push(root)
    onStack.add(root)
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: Token; next: number }
      const targets = successors(frame.node)
      if (frame.next < targets.length) {
        const target = targets[frame.next] as Token
        frame.next++
        if (!index.has(target)) {
          index.set(target, counter)
          lowLink.set(target, counter)
          counter++
          stack.push(target)
          onStack.add(target)
          work.push({ node: target, next: 0 })
        } else if (onStack.has(target)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) as number, index.get(target) as number))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) as number, lowLink.get(frame.node) as number))
      }
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: Token[] = []
        let member: Token | undefined
        do {
          member = stack.pop() as Token
          onStack.delete(member)
          component.push(member)
        } while (member !== frame.node)
        components.push(component.sort(compareStrings))
      }
    }
  }
  return components.sort((a, b) => compareStrings(a[0] as string, b[0] as string))
}
