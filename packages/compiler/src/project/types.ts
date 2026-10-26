/**
 * Type model (§4.4): a small, serializable representation of TypeScript types, sufficient for
 * dependency injection (identities of classes/interfaces, generics, unions with `undefined`,
 * arrays, promises...). Everything the compiler cannot reason about is `opaque`.
 *
 * Builders normalize as they build, so two equivalent annotations produce the same structure and
 * the same {@link serializeType} string (the normative canonical form):
 *
 * - primitives by keyword; literals as JSON (`"admin"`, `42`, `true`), bigints as `10n`;
 * - `Array<T>`, `ReadonlyArray<T>`, `readonly T[]` → `T[]`; `Promise<T>` → `Promise<T>`;
 * - references: `<identity>` or `<identity><A, B>` with default type arguments filled in;
 * - unions/intersections flattened, de-duplicated and sorted by serialization; in unions,
 *   `true | false` → `boolean`, literals are absorbed by their primitive (`string | "a"` →
 *   `string`), `never` is dropped and `any`/`unknown` absorb everything; in intersections,
 *   `never`/`any` absorb everything and `unknown` is dropped; single-member results collapse;
 * - tuples `[A, B?, ...C[]]`; opaque types `opaque("<source text>")`; unbound type parameters by name.
 */

import { compareStrings } from './compare.ts'

/** Keyword types. */
export type PrimitiveTypeName =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'symbol'
  | 'null'
  | 'undefined'
  | 'void'
  | 'any'
  | 'unknown'
  | 'never'
  | 'object'

/** Why a type is opaque. */
export type OpaqueReason =
  | 'object-literal'
  | 'function'
  | 'constructor'
  | 'mapped'
  | 'conditional'
  | 'typeof'
  | 'import-type'
  | 'type-operator'
  | 'indexed-access'
  | 'template-literal'
  | 'this'
  | 'infer'
  | 'predicate'
  | 'intrinsic'
  | 'unresolved'
  | 'missing-annotation'
  | 'recursive-alias'
  | 'not-a-type'
  | 'unsupported'

export interface PrimitiveType {
  readonly kind: 'primitive'
  readonly name: PrimitiveTypeName
}

export interface LiteralType {
  readonly kind: 'literal'
  readonly value: string | number | boolean | bigint
}

/** A class, interface, enum or external/global type, with its type arguments. */
export interface ReferenceType {
  readonly kind: 'reference'
  /** Canonical identity of the declaration (§4.1), without type arguments. */
  readonly identity: string
  /** Display name (part of the identity after the last `#`). */
  readonly name: string
  readonly typeArgs: readonly TypeInfo[]
}

export interface ArrayType {
  readonly kind: 'array'
  readonly element: TypeInfo
}

export interface TupleElement {
  readonly type: TypeInfo
  readonly optional: boolean
  readonly rest: boolean
}

export interface TupleType {
  readonly kind: 'tuple'
  readonly elements: readonly TupleElement[]
}

export interface UnionType {
  readonly kind: 'union'
  readonly types: readonly TypeInfo[]
}

export interface IntersectionType {
  readonly kind: 'intersection'
  readonly types: readonly TypeInfo[]
}

export interface PromiseType {
  readonly kind: 'promise'
  readonly inner: TypeInfo
}

/** A type the compiler does not model (object literals, functions, mapped types, `typeof`...). */
export interface OpaqueType {
  readonly kind: 'opaque'
  /** Source text of the type (whitespace collapsed). */
  readonly text: string
  readonly reason: OpaqueReason
}

/** An unbound type parameter (`T` inside `class Repository<T>`), see {@link substituteType}. */
export interface TypeParameterType {
  readonly kind: 'typeParameter'
  readonly name: string
}

/** The type model. */
export type TypeInfo =
  | PrimitiveType
  | LiteralType
  | ReferenceType
  | ArrayType
  | TupleType
  | UnionType
  | IntersectionType
  | PromiseType
  | OpaqueType
  | TypeParameterType

const PRIMITIVES = new Map<PrimitiveTypeName, PrimitiveType>()

/** Primitive type (instances are shared). */
export function primitiveType(name: PrimitiveTypeName): PrimitiveType {
  let type = PRIMITIVES.get(name)
  if (!type) {
    type = Object.freeze({ kind: 'primitive', name })
    PRIMITIVES.set(name, type)
  }
  return type
}

/** Literal type. `-0` is normalized to `0`. */
export function literalType(value: string | number | boolean | bigint): LiteralType {
  return { kind: 'literal', value: Object.is(value, -0) ? 0 : value }
}

/** Reference to a declaration (identity without type arguments). */
export function referenceType(identity: string, name: string, typeArgs: readonly TypeInfo[] = []): ReferenceType {
  return { kind: 'reference', identity, name, typeArgs }
}

export function arrayType(element: TypeInfo): ArrayType {
  return { kind: 'array', element }
}

export function tupleType(elements: readonly TupleElement[]): TupleType {
  return { kind: 'tuple', elements }
}

export function promiseType(inner: TypeInfo): PromiseType {
  return { kind: 'promise', inner }
}

/** Opaque type; `text` whitespace is collapsed. */
export function opaqueType(text: string, reason: OpaqueReason): OpaqueType {
  return { kind: 'opaque', text: text.replace(/\s+/g, ' ').trim(), reason }
}

export function typeParameterType(name: string): TypeParameterType {
  return { kind: 'typeParameter', name }
}

/** Normalized union (see module documentation). */
export function unionType(types: readonly TypeInfo[]): TypeInfo {
  const flat: TypeInfo[] = []
  for (const type of types) {
    if (type.kind === 'union') {
      flat.push(...type.types)
    } else {
      flat.push(type)
    }
  }
  if (flat.some(type => isPrimitive(type, 'any'))) {
    return primitiveType('any')
  }
  if (flat.some(type => isPrimitive(type, 'unknown'))) {
    return primitiveType('unknown')
  }
  let members = flat.filter(type => !isPrimitive(type, 'never'))
  const hasTrue = members.some(type => type.kind === 'literal' && type.value === true)
  const hasFalse = members.some(type => type.kind === 'literal' && type.value === false)
  if (hasTrue && hasFalse) {
    members.push(primitiveType('boolean'))
  }
  const absorbing = new Set(members.filter(type => type.kind === 'primitive').map(type => (type as PrimitiveType).name))
  members = members.filter(type => type.kind !== 'literal' || !absorbing.has(literalPrimitive(type.value)))
  const unique = sortUnique(members)
  if (unique.length === 0) {
    return primitiveType('never')
  }
  return unique.length === 1 ? (unique[0] as TypeInfo) : { kind: 'union', types: unique }
}

/** Normalized intersection (see module documentation). */
export function intersectionType(types: readonly TypeInfo[]): TypeInfo {
  const flat: TypeInfo[] = []
  for (const type of types) {
    if (type.kind === 'intersection') {
      flat.push(...type.types)
    } else {
      flat.push(type)
    }
  }
  if (flat.some(type => isPrimitive(type, 'never'))) {
    return primitiveType('never')
  }
  if (flat.some(type => isPrimitive(type, 'any'))) {
    return primitiveType('any')
  }
  const unique = sortUnique(flat.filter(type => !isPrimitive(type, 'unknown')))
  if (unique.length === 0) {
    return primitiveType('unknown')
  }
  return unique.length === 1 ? (unique[0] as TypeInfo) : { kind: 'intersection', types: unique }
}

/** Canonical serialization (normative, §4.4). Two types are equal iff their serializations are. */
export function serializeType(type: TypeInfo): string {
  return printType(
    type,
    reference => reference.identity,
    text => `opaque(${JSON.stringify(text)})`,
  )
}

/** Human readable form for messages: display names instead of identities (`Repository<User>`). */
export function formatType(type: TypeInfo): string {
  return printType(
    type,
    reference => reference.name,
    text => text,
  )
}

/** `true` when both types have the same canonical serialization. */
export function typesEqual(a: TypeInfo, b: TypeInfo): boolean {
  return a === b || serializeType(a) === serializeType(b)
}

/** Replaces type parameters by their binding (unknown names are kept) and re-normalizes. */
export function substituteType(type: TypeInfo, bindings: ReadonlyMap<string, TypeInfo>): TypeInfo {
  if (bindings.size === 0) {
    return type
  }
  switch (type.kind) {
    case 'typeParameter':
      return bindings.get(type.name) ?? type
    case 'reference':
      return type.typeArgs.length === 0
        ? type
        : referenceType(
            type.identity,
            type.name,
            type.typeArgs.map(arg => substituteType(arg, bindings)),
          )
    case 'array':
      return arrayType(substituteType(type.element, bindings))
    case 'tuple':
      return tupleType(type.elements.map(element => ({ ...element, type: substituteType(element.type, bindings) })))
    case 'union':
      return unionType(type.types.map(member => substituteType(member, bindings)))
    case 'intersection':
      return intersectionType(type.types.map(member => substituteType(member, bindings)))
    case 'promise':
      return promiseType(substituteType(type.inner, bindings))
    default:
      return type
  }
}

/** Names of the unbound type parameters occurring in a type. */
export function freeTypeParameters(type: TypeInfo): string[] {
  const names = new Set<string>()
  const visit = (current: TypeInfo): void => {
    switch (current.kind) {
      case 'typeParameter':
        names.add(current.name)
        return
      case 'reference':
        current.typeArgs.forEach(visit)
        return
      case 'array':
        visit(current.element)
        return
      case 'tuple':
        for (const element of current.elements) {
          visit(element.type)
        }
        return
      case 'union':
      case 'intersection':
        current.types.forEach(visit)
        return
      case 'promise':
        visit(current.inner)
        return
      default:
        return
    }
  }
  visit(type)
  return [...names].sort()
}

function isPrimitive(type: TypeInfo, name: PrimitiveTypeName): boolean {
  return type.kind === 'primitive' && type.name === name
}

function literalPrimitive(value: string | number | boolean | bigint): PrimitiveTypeName {
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'bigint'
  }
}

function sortUnique(types: readonly TypeInfo[]): TypeInfo[] {
  const byKey = new Map<string, TypeInfo>()
  for (const type of types) {
    const key = serializeType(type)
    if (!byKey.has(key)) {
      byKey.set(key, type)
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, type]) => type)
}

function serializeLiteral(value: string | number | boolean | bigint): string {
  if (typeof value === 'bigint') {
    return `${value}n`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value)
  }
  return JSON.stringify(value)
}

function printType(
  type: TypeInfo,
  referenceName: (type: ReferenceType) => string,
  opaque: (text: string) => string,
): string {
  const print = (current: TypeInfo): string => printType(current, referenceName, opaque)
  switch (type.kind) {
    case 'primitive':
      return type.name
    case 'literal':
      return serializeLiteral(type.value)
    case 'typeParameter':
      return type.name
    case 'reference':
      return type.typeArgs.length === 0
        ? referenceName(type)
        : `${referenceName(type)}<${type.typeArgs.map(print).join(', ')}>`
    case 'array': {
      const element = print(type.element)
      return type.element.kind === 'union' || type.element.kind === 'intersection' ? `(${element})[]` : `${element}[]`
    }
    case 'tuple':
      return `[${type.elements
        .map(element => {
          const printed = print(element.type)
          const grouped =
            element.optional && (element.type.kind === 'union' || element.type.kind === 'intersection')
              ? `(${printed})`
              : printed
          return `${element.rest ? '...' : ''}${grouped}${element.optional ? '?' : ''}`
        })
        .join(', ')}]`
    case 'union':
      return type.types.map(print).join(' | ')
    case 'intersection':
      return type.types.map(member => (member.kind === 'union' ? `(${print(member)})` : print(member))).join(' & ')
    case 'promise':
      return `Promise<${print(type.inner)}>`
    case 'opaque':
      return opaque(type.text)
  }
}
