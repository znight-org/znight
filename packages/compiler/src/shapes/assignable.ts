/**
 * Conservative assignability of two types (RFC 0010 §4.5), compared through their shapes
 * ({@link ShapeResolver}): `true` when every value of the source is a value of the target, `false`
 * when a value of the source certainly is not, `undefined` when it cannot be decided (`any`,
 * `unknown`, opaque parts, schemas, kept references, intersections on the source side...). It is
 * structural like TypeScript, without methods (shapes read the `instance` members: fields and
 * getters): a property of the target that the source declares as a member its shape leaves out (a
 * method `hasRole()` for `hasRole: () => boolean`) is not decided. It is meant for checks that must
 * never reject valid code: callers report only `false`.
 */
import type { NamedShape, Shape, ShapeOptions, ShapeResult, ShapeTarget } from '../extensions/api.ts'
import type { ObjectShape } from './shape.ts'

import { omittedMembers } from './shape.ts'

/** Shape options of the comparison: what reading an instance gives. */
export const ASSIGNABLE_SHAPE_OPTIONS: ShapeOptions = Object.freeze({ members: 'instance', jsdoc: false })

const MAX_DEPTH = 32

type Verdict = boolean | undefined

/** Assignability of the shapes of `source` to `target`. */
export function assignableShapes(
  shape: (target: ShapeTarget, options: ShapeOptions) => ShapeResult,
  source: ShapeTarget,
  target: ShapeTarget,
): Verdict {
  const left = shape(source, ASSIGNABLE_SHAPE_OPTIONS)
  const right = shape(target, ASSIGNABLE_SHAPE_OPTIONS)
  const named = new Map<string, NamedShape>(left.named)
  for (const [key, value] of right.named) named.set(key, value)
  return new Comparison(named).compare(left.root, right.root, 0)
}

class Comparison {
  readonly #named: ReadonlyMap<string, NamedShape>
  /** Pairs being compared (recursive types): assumed assignable. */
  readonly #pending = new Set<string>()

  constructor(named: ReadonlyMap<string, NamedShape>) {
    this.#named = named
  }

  compare(source: Shape, target: Shape, depth: number): Verdict {
    if (depth > MAX_DEPTH) return undefined
    if (target.kind === 'unknown') return true
    if (source.kind === 'never') return true
    if (isUnchecked(source) || isUnchecked(target)) return undefined
    if (source.kind === 'named' && target.kind === 'named' && source.key === target.key) return true
    if (source.kind === 'union') return all(source.members.map(member => this.compare(member, target, depth + 1)))
    if (target.kind === 'union') {
      return some(target.members.map(member => this.compare(source, member, depth + 1)))
    }
    if (source.kind === 'named' || target.kind === 'named') return this.#viaNamed(source, target, depth)
    if (target.kind === 'intersection') {
      return all(target.members.map(member => this.compare(source, member, depth + 1)))
    }
    if (source.kind === 'intersection') {
      const verdicts = source.members.map(member => this.compare(member, target, depth + 1))
      return verdicts.includes(true) ? true : undefined
    }
    return this.#structural(source, target, depth)
  }

  #viaNamed(source: Shape, target: Shape, depth: number): Verdict {
    const key = `${serializeKey(source)}→${serializeKey(target)}`
    if (this.#pending.has(key)) return true
    const left = this.#expand(source)
    const right = this.#expand(target)
    if (left === undefined || right === undefined) return undefined
    this.#pending.add(key)
    try {
      return this.compare(left, right, depth + 1)
    } finally {
      this.#pending.delete(key)
    }
  }

  #expand(shape: Shape): Shape | undefined {
    return shape.kind === 'named' ? this.#named.get(shape.key)?.shape : shape
  }

  #structural(source: Shape, target: Shape, depth: number): Verdict {
    switch (target.kind) {
      case 'string':
      case 'number':
      case 'boolean':
        return source.kind === target.kind || (source.kind === 'literal' && typeof source.value === target.kind)
      case 'null':
      case 'undefined':
      case 'date':
      case 'bigint':
      case 'binary':
      case 'url':
        return source.kind === target.kind
      case 'never':
        return false
      case 'literal':
        if (source.kind === 'literal') return source.value === target.value
        return isPrimitive(source) ? false : undefined
      case 'array':
        if (source.kind === 'array') return this.compare(source.items, target.items, depth + 1)
        if (source.kind === 'tuple') {
          const items = source.rest === undefined ? source.items : [...source.items, source.rest]
          return all(items.map(item => this.compare(item, target.items, depth + 1)))
        }
        return isPrimitive(source) || source.kind === 'object' ? false : undefined
      case 'tuple':
        if (source.kind === 'tuple' && source.rest === undefined && target.rest === undefined) {
          if (source.items.length !== target.items.length) return false
          return all(source.items.map((item, index) => this.compare(item, target.items[index] as Shape, depth + 1)))
        }
        return isPrimitive(source) ? false : undefined
      case 'object':
        if (source.kind === 'object') return this.#object(source, target, depth)
        return isPrimitive(source) || source.kind === 'array' ? false : undefined
      default:
        return undefined
    }
  }

  #object(source: ObjectShape, target: ObjectShape, depth: number): Verdict {
    const { properties, additional } = source
    const verdicts: Verdict[] = []
    const byName = new Map(properties.map(property => [property.name, property]))
    for (const wanted of target.properties) {
      const found = byName.get(wanted.name)
      if (found === undefined) {
        // a member the source shape leaves out (a method `hasRole(): boolean` for `hasRole: () => boolean`)
        // is not compared
        if (omittedMembers(source).has(wanted.name)) verdicts.push(undefined)
        else verdicts.push(wanted.optional || (additional === undefined ? false : undefined))
        continue
      }
      if (found.optional && !wanted.optional) {
        verdicts.push(false)
        continue
      }
      verdicts.push(this.compare(found.shape, wanted.shape, depth + 1))
    }
    if (target.additional !== undefined) {
      for (const property of properties) verdicts.push(this.compare(property.shape, target.additional, depth + 1))
      if (additional !== undefined) verdicts.push(this.compare(additional, target.additional, depth + 1))
    }
    return all(verdicts)
  }
}

function isUnchecked(shape: Shape): boolean {
  return shape.kind === 'unknown' || shape.kind === 'opaque' || shape.kind === 'schema' || shape.kind === 'reference'
}

function isPrimitive(shape: Shape): boolean {
  switch (shape.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'undefined':
    case 'literal':
    case 'bigint':
      return true
    default:
      return false
  }
}

/** `false` if any is `false`, else `undefined` if any is `undefined`, else `true`. */
function all(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes(false)) return false
  return verdicts.includes(undefined) ? undefined : true
}

/** `true` if any is `true`, else `undefined` if any is `undefined`, else `false`. */
function some(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes(true)) return true
  return verdicts.includes(undefined) ? undefined : false
}

function serializeKey(shape: Shape): string {
  return shape.kind === 'named' ? shape.key : JSON.stringify(shape)
}
