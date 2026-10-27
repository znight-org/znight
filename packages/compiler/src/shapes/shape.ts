/**
 * Builders, normalisation and canonical serialization of {@link Shape}s (C1 of RFC 0002).
 *
 * Unions are normalised like `TypeInfo` unions: flattened, de-duplicated and sorted by
 * serialization; `true | false` → `boolean`; literals absorbed by their primitive; `never`
 * dropped; `unknown` absorbs everything; a single member collapses. Intersections of objects are
 * merged; a primitive intersected with objects is the primitive (branded types).
 */
import type { Shape, ShapeKeyword, ShapeProperty } from '../extensions/api.ts'

import { compareStrings } from '../project/compare.ts'

/** An object shape. */
export type ObjectShape = Extract<Shape, { readonly kind: 'object' }>

const KEYWORDS = new Map<ShapeKeyword, Shape>()

/** A keyword shape (instances are shared and frozen). */
export function keyword(kind: ShapeKeyword): Shape {
  let shape = KEYWORDS.get(kind)
  if (!shape) {
    shape = Object.freeze({ kind })
    KEYWORDS.set(kind, shape)
  }
  return shape
}

/** `true` for a keyword shape of that kind. */
export function isKeyword(shape: Shape, kind: ShapeKeyword): boolean {
  return shape.kind === kind
}

export function literal(value: string | number | boolean): Shape {
  return { kind: 'literal', value: Object.is(value, -0) ? 0 : value }
}

export function array(items: Shape): Shape {
  return { kind: 'array', items }
}

export function object(properties: readonly ShapeProperty[], additional?: Shape): ObjectShape {
  return additional === undefined ? { kind: 'object', properties } : { kind: 'object', properties, additional }
}

/** Normalised union. */
export function union(members: readonly Shape[]): Shape {
  const flat: Shape[] = []
  for (const member of members) {
    if (member.kind === 'union') {
      flat.push(...member.members)
    } else {
      flat.push(member)
    }
  }
  if (flat.some(member => member.kind === 'unknown')) {
    return keyword('unknown')
  }
  let kept = flat.filter(member => member.kind !== 'never')
  const hasTrue = kept.some(member => member.kind === 'literal' && member.value === true)
  const hasFalse = kept.some(member => member.kind === 'literal' && member.value === false)
  if (hasTrue && hasFalse) {
    kept.push(keyword('boolean'))
  }
  const primitives = new Set(kept.map(member => member.kind))
  kept = kept.filter(member => member.kind !== 'literal' || !primitives.has(typeof member.value as ShapeKeyword))
  const unique = sortUnique(kept)
  if (unique.length === 0) {
    return keyword('never')
  }
  return unique.length === 1 ? (unique[0] as Shape) : { kind: 'union', members: unique }
}

/** A union in the given order (enums), de-duplicated but not sorted. */
export function orderedUnion(members: readonly Shape[]): Shape {
  const seen = new Set<string>()
  const unique: Shape[] = []
  for (const member of members) {
    const key = serializeShape(member)
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(member)
    }
  }
  if (unique.length === 0) {
    return keyword('never')
  }
  return unique.length === 1 ? (unique[0] as Shape) : { kind: 'union', members: unique }
}

/**
 * Normalised intersection. `toObject` dereferences named shapes to their structure (`undefined`
 * when the shape is not an object).
 */
export function intersection(members: readonly Shape[], toObject: (shape: Shape) => ObjectShape | undefined): Shape {
  const flat: Shape[] = []
  for (const member of members) {
    if (member.kind === 'intersection') {
      flat.push(...member.members)
    } else {
      flat.push(member)
    }
  }
  if (flat.some(member => member.kind === 'never')) {
    return keyword('never')
  }
  const kept = sortUnique(flat.filter(member => member.kind !== 'unknown'))
  if (kept.length === 0) {
    return keyword('unknown')
  }
  if (kept.length === 1) {
    return kept[0] as Shape
  }
  const objects = kept.map(toObject)
  const primitives = kept.filter((member, index) => objects[index] === undefined && isPrimitive(member))
  if (primitives.length === 1 && primitives.length + objects.filter(Boolean).length === kept.length) {
    // `string & { readonly __brand: 'UserId' }`: a branded primitive
    return primitives[0] as Shape
  }
  if (objects.every(candidate => candidate !== undefined)) {
    return mergeObjects(objects as ObjectShape[], toObject)
  }
  return { kind: 'intersection', members: kept }
}

/** Properties of several objects merged (later declarations win, a property is optional only when optional everywhere). */
export function mergeObjects(
  objects: readonly ObjectShape[],
  toObject: (shape: Shape) => ObjectShape | undefined,
): ObjectShape {
  const properties = new Map<string, ShapeProperty>()
  let additional: Shape | undefined
  for (const current of objects) {
    for (const property of current.properties) {
      const previous = properties.get(property.name)
      properties.set(
        property.name,
        previous === undefined
          ? property
          : {
              name: property.name,
              shape: intersection([previous.shape, property.shape], toObject),
              optional: previous.optional && property.optional,
              readonly: previous.readonly || property.readonly,
              doc: property.doc ?? previous.doc,
              location: property.location ?? previous.location,
            },
      )
    }
    if (current.additional !== undefined) {
      additional =
        additional === undefined ? current.additional : intersection([additional, current.additional], toObject)
    }
  }
  return object([...properties.values()], additional)
}

/** Object properties with `extends`/override semantics: later properties replace earlier ones in place. */
export function overrideProperties(base: readonly ShapeProperty[], own: readonly ShapeProperty[]): ShapeProperty[] {
  const result = new Map<string, ShapeProperty>()
  for (const property of base) {
    result.set(property.name, property)
  }
  for (const property of own) {
    result.set(property.name, property)
  }
  return [...result.values()]
}

/** Removes `undefined` from a shape: `{ shape, undefinable }`. */
export function withoutUndefined(shape: Shape): { readonly shape: Shape; readonly undefinable: boolean } {
  if (shape.kind === 'undefined') {
    return { shape, undefinable: true }
  }
  if (shape.kind === 'union' && shape.members.some(member => member.kind === 'undefined')) {
    return { shape: union(shape.members.filter(member => member.kind !== 'undefined')), undefinable: true }
  }
  return { shape, undefinable: false }
}

/** Canonical serialization: equal shapes have equal serializations (keys of generic named shapes). */
export function serializeShape(shape: Shape): string {
  switch (shape.kind) {
    case 'literal':
      return JSON.stringify(shape.value)
    case 'array': {
      const items = serializeShape(shape.items)
      return shape.items.kind === 'union' || shape.items.kind === 'intersection' ? `(${items})[]` : `${items}[]`
    }
    case 'tuple': {
      const items = shape.items.map((item, index) => `${serializeShape(item)}${index >= shape.minItems ? '?' : ''}`)
      if (shape.rest !== undefined) {
        items.push(`...${serializeShape(shape.rest)}[]`)
      }
      return `[${items.join(', ')}]`
    }
    case 'object': {
      const entries = [...shape.properties]
        .sort((a, b) => compareStrings(a.name, b.name))
        .map(
          property =>
            `${JSON.stringify(property.name)}${property.optional ? '?' : ''}: ${serializeShape(property.shape)}`,
        )
      if (shape.additional !== undefined) {
        entries.push(`[string]: ${serializeShape(shape.additional)}`)
      }
      return `{ ${entries.join('; ')} }`
    }
    case 'union':
      return shape.members.map(serializeShape).join(' | ')
    case 'intersection':
      return shape.members
        .map(member => (member.kind === 'union' ? `(${serializeShape(member)})` : serializeShape(member)))
        .join(' & ')
    case 'named':
      return shape.key
    case 'schema':
      return `schema(${shape.ref.identity ?? shape.ref.text}, ${shape.io})`
    case 'reference':
      return shape.typeArgs.length === 0
        ? `ref(${shape.identity})`
        : `ref(${shape.identity}<${shape.typeArgs.map(serializeShape).join(', ')}>)`
    case 'opaque':
      return `opaque(${JSON.stringify(shape.text)})`
    default:
      return shape.kind
  }
}

function isPrimitive(shape: Shape): boolean {
  return (
    shape.kind === 'string' ||
    shape.kind === 'number' ||
    shape.kind === 'boolean' ||
    shape.kind === 'bigint' ||
    shape.kind === 'literal'
  )
}

function sortUnique(shapes: readonly Shape[]): Shape[] {
  const byKey = new Map<string, Shape>()
  for (const shape of shapes) {
    const key = serializeShape(shape)
    if (!byKey.has(key)) {
      byKey.set(key, shape)
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, shape]) => shape)
}
