import type { RoutePath } from './path.ts'

interface RouteNode<T> {
  statics: Map<string, RouteNode<T>> | undefined
  param: RouteNode<T> | undefined
  /** Values of routes ending with a wildcard at this position, by method. */
  wildcard: Map<string, T> | undefined
  /** Values of routes ending at this node, by method. */
  values: Map<string, T> | undefined
}

function createNode<T>(): RouteNode<T> {
  return { statics: undefined, param: undefined, wildcard: undefined, values: undefined }
}

/**
 * A segment trie mapping `(method, route path)` to values. Lookups prefer static segments over
 * parameters over the wildcard, with backtracking (the same semantics as find-my-way), and are
 * case-sensitive on the raw request path. Used by the built-in Node adapter for routing and by the
 * plugin to tell `404 Not Found` from `405 Method Not Allowed`.
 */
export class RouteTable<T> {
  readonly #root: RouteNode<T> = createNode()
  #size = 0

  /** Number of `(method, route)` entries. */
  get size(): number {
    return this.#size
  }

  /**
   * Adds a value for `method` (upper case) and `route`.
   *
   * @returns the value already registered for the same method and shape, in which case nothing is
   *   added.
   */
  add(method: string, route: RoutePath, value: T): T | undefined {
    let node = this.#root
    for (const segment of route.segments) {
      if (segment.kind === 'static') {
        node.statics ??= new Map()
        let child = node.statics.get(segment.value)
        if (child === undefined) {
          child = createNode()
          node.statics.set(segment.value, child)
        }
        node = child
      } else if (segment.kind === 'param') {
        node.param ??= createNode()
        node = node.param
      } else {
        node.wildcard ??= new Map()
        return this.#set(node.wildcard, method, value)
      }
    }
    node.values ??= new Map()
    return this.#set(node.values, method, value)
  }

  #set(map: Map<string, T>, method: string, value: T): T | undefined {
    const existing = map.get(method)
    if (existing !== undefined) return existing
    map.set(method, value)
    this.#size++
    return undefined
  }

  /** The value of the most specific route matching `method` and the raw `path` (no query string). */
  find(method: string, path: string): T | undefined {
    if (path.charCodeAt(0) !== 47 /* / */) return undefined
    if (path === '/') return this.#root.values?.get(method) ?? this.#root.wildcard?.get(method)
    return search(this.#root, path.split('/'), 1, method)
  }

  /** Methods of every route matching the raw `path`, sorted. */
  allowedMethods(path: string): string[] {
    const methods = new Set<string>()
    if (path.charCodeAt(0) === 47 /* / */) {
      if (path === '/') {
        addKeys(methods, this.#root.values)
        addKeys(methods, this.#root.wildcard)
      } else {
        collect(this.#root, path.split('/'), 1, methods)
      }
    }
    return [...methods].sort()
  }
}

function search<T>(node: RouteNode<T>, segments: readonly string[], index: number, method: string): T | undefined {
  if (index === segments.length) return node.values?.get(method)
  const segment = segments[index] as string
  const child = node.statics?.get(segment)
  if (child !== undefined) {
    const found = search(child, segments, index + 1, method)
    if (found !== undefined) return found
  }
  if (segment !== '' && node.param !== undefined) {
    const found = search(node.param, segments, index + 1, method)
    if (found !== undefined) return found
  }
  return node.wildcard?.get(method)
}

function collect<T>(node: RouteNode<T>, segments: readonly string[], index: number, methods: Set<string>): void {
  if (index === segments.length) {
    addKeys(methods, node.values)
    return
  }
  const segment = segments[index] as string
  const child = node.statics?.get(segment)
  if (child !== undefined) collect(child, segments, index + 1, methods)
  if (segment !== '' && node.param !== undefined) collect(node.param, segments, index + 1, methods)
  addKeys(methods, node.wildcard)
}

function addKeys(target: Set<string>, source: Map<string, unknown> | undefined): void {
  if (source !== undefined) for (const key of source.keys()) target.add(key)
}
