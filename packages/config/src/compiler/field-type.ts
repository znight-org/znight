/**
 * TypeScript type of a config property → {@link ConfigFieldType} (+ allowed values).
 *
 * | TypeScript                                                        | Field                  |
 * | ----------------------------------------------------------------- | ---------------------- |
 * | `string`, template literal types                                  | `string`               |
 * | `number` / `boolean`                                              | `number` / `boolean`   |
 * | literal unions (`'dev' \| 'prod'`, `5 \| 10`), TS enums            | base type + `enum`     |
 * | `string[]` / `number[]` (also `readonly`, `Array<…>`, literal/enum elements) | `string[]` / `number[]` + `enum` |
 * | `URL` (global or `node:url`)                                      | `url`                  |
 * | interfaces, object literal / mapped types, `Record`, `Partial`…, tuples, nested arrays, `unknown`, `any`, `object` | `json` |
 * | branded primitives (`string & { __brand: 'Id' }`)                 | the primitive          |
 *
 * Anything else (classes such as `Date` or `Map`, functions, `symbol`, `bigint`, mixed unions such as
 * `string | number`, `boolean[]`, type parameters...) is unsupported (ZNIGHT012). `null`, `undefined`
 * and `void` members are removed: they only make the property optional.
 *
 * This module only `import type`s from `@znight/compiler`: the project model and the type helpers are
 * reached through the extension context.
 */
import type { Project, StaticValue, TypeHelpers, TypeInfo } from '@znight/compiler'
import type { ConfigEnumValue, ConfigFieldType } from '../metadata.ts'

/** Result of {@link FieldTypeResolver.resolve}. */
export type FieldTypeResult =
  | {
      readonly ok: true
      readonly type: ConfigFieldType
      /** Allowed values, `undefined` when every value of the type is allowed. */
      readonly enum: readonly ConfigEnumValue[] | undefined
    }
  | { readonly ok: false; readonly reason: string; readonly hints: readonly string[] }

type ScalarBase = 'string' | 'number' | 'boolean'

/**
 * Intermediate shape of a type. `values` of a scalar are its allowed values (`undefined`: any value);
 * `sorted` tells whether they come from literal types (sorted for the output) or from a TS enum
 * (declaration order kept).
 */
type Shape =
  | {
      readonly kind: 'scalar'
      readonly base: ScalarBase
      readonly values: readonly ConfigEnumValue[] | undefined
      readonly sorted: boolean
    }
  | { readonly kind: 'array'; readonly element: Shape }
  | { readonly kind: 'url' }
  | { readonly kind: 'json' }
  | { readonly kind: 'unsupported'; readonly reason: string; readonly hints: readonly string[] }

/** Identities of the URL class. */
const URL_IDENTITIES: ReadonlySet<string> = new Set(['globalThis#URL', 'node:url#URL'])

/** Global type helpers producing plain object types (JSON values). */
const JSON_GLOBALS: ReadonlySet<string> = new Set([
  'globalThis#Record',
  'globalThis#Partial',
  'globalThis#Required',
  'globalThis#Readonly',
  'globalThis#Pick',
  'globalThis#Omit',
  'globalThis#NonNullable',
  'globalThis#Object',
  'globalThis#JSON',
])

/** Hints for well-known global classes. */
const GLOBAL_HINTS: Readonly<Record<string, string>> = {
  'globalThis#Date': 'Read a string (ISO 8601 date) or a number (timestamp) and convert it where it is used',
  'globalThis#RegExp': 'Read a string and build the RegExp where it is used',
  'globalThis#Map': 'Use a Record<string, T> (a JSON object) instead',
  'globalThis#Set': 'Use an array (string[] or number[]) instead',
  'globalThis#Buffer': 'Read a string (base64...) and decode it where it is used',
}

export const SUPPORTED_TYPES_HINT: string =
  'Supported types: string, number, boolean, literal unions and enums, string[], number[], URL, and JSON types (interfaces, object types, Record, unknown)'

function scalar(base: ScalarBase, values: readonly ConfigEnumValue[] | undefined, sorted: boolean): Shape {
  return { kind: 'scalar', base, values, sorted }
}

function unsupported(reason: string, ...hints: string[]): Shape {
  return { kind: 'unsupported', reason, hints: [...hints, SUPPORTED_TYPES_HINT] }
}

const JSON_SHAPE: Shape = { kind: 'json' }

/** Maps property types to config field types. One instance per analysed class. */
export class FieldTypeResolver {
  readonly #project: Project
  readonly #types: TypeHelpers

  constructor(project: Project, types: TypeHelpers) {
    this.#project = project
    this.#types = types
  }

  /**
   * Field type of an annotated property type. `null`, `undefined` and `void` members are removed:
   * `nullable` tells whether there were any (the property is then optional).
   */
  resolve(type: TypeInfo): { readonly result: FieldTypeResult; readonly nullable: boolean } {
    const stripped = this.#types.stripNullish(type)
    return { result: toResult(this.#shape(stripped.type, 0)), nullable: stripped.nullable }
  }

  /** Field type inferred from a statically evaluated value (initializer or `@Default` without annotation). */
  infer(value: StaticValue): FieldTypeResult | undefined {
    const shape = inferShape(value)
    return shape === undefined ? undefined : toResult(shape)
  }

  #shape(type: TypeInfo, depth: number): Shape {
    if (depth > 16) {
      return unsupported(`'${this.#types.format(type)}' is too deeply nested`)
    }
    switch (type.kind) {
      case 'primitive':
        switch (type.name) {
          case 'string':
          case 'number':
          case 'boolean':
            return scalar(type.name, undefined, false)
          case 'unknown':
          case 'any':
          case 'object':
            return JSON_SHAPE
          case 'bigint':
            return unsupported("'bigint' values cannot be loaded from configuration", 'Use a string or a number')
          default:
            return unsupported(`'${type.name}' is not a configuration value type`)
        }
      case 'literal':
        if (typeof type.value === 'bigint') {
          return unsupported("'bigint' values cannot be loaded from configuration", 'Use a string or a number')
        }
        return scalar(baseOf(type.value), [type.value], true)
      case 'array': {
        const element = this.#shape(this.#types.stripNullish(type.element).type, depth + 1)
        return arrayOf(element, this.#types.format(type))
      }
      case 'tuple':
        return JSON_SHAPE
      case 'union':
        return this.#union(type.types, depth)
      case 'intersection':
        return this.#intersection(type.types, depth)
      case 'reference':
        return this.#reference(type)
      case 'opaque':
        switch (type.reason) {
          case 'object-literal':
          case 'mapped':
            return JSON_SHAPE
          case 'template-literal':
            return scalar('string', undefined, false)
          case 'function':
          case 'constructor':
            return unsupported('functions cannot be loaded from configuration')
          default:
            return unsupported(
              `the type '${type.text}' cannot be analysed (${type.reason.replaceAll('-', ' ')})`,
              'Annotate the property with a plain type',
            )
        }
      case 'promise':
        return unsupported('promises cannot be loaded from configuration')
      case 'typeParameter':
        return unsupported(
          `the type parameter '${type.name}' cannot be loaded from configuration`,
          'Config classes cannot be generic: use a concrete type',
        )
    }
  }

  #union(members: readonly TypeInfo[], depth: number): Shape {
    const shapes = members.map(member => this.#shape(member, depth + 1))
    const failed = shapes.find(shape => shape.kind === 'unsupported')
    if (failed) {
      return failed
    }
    const merged = mergeShapes(shapes)
    if (merged) {
      return merged
    }
    const text = members.map(member => this.#types.format(member)).join(' | ')
    return unsupported(
      `the union '${text}' mixes several kinds of values`,
      "Use a single type (a literal union such as 'a' | 'b', or a JSON type)",
    )
  }

  #intersection(members: readonly TypeInfo[], depth: number): Shape {
    const shapes = members.map(member => this.#shape(member, depth + 1))
    const scalars = shapes.filter(shape => shape.kind === 'scalar')
    const others = shapes.filter(shape => shape.kind !== 'scalar')
    if (others.every(shape => shape.kind === 'json')) {
      // branded primitive (`string & { __brand: 'Id' }`) or an intersection of object types
      if (scalars.length === 1) {
        return scalars[0] as Shape
      }
      if (scalars.length === 0) {
        return JSON_SHAPE
      }
    }
    const failed = shapes.find(shape => shape.kind === 'unsupported')
    return (
      failed ??
      unsupported(
        `the intersection '${members.map(member => this.#types.format(member)).join(' & ')}' is not a value type`,
      )
    )
  }

  #reference(type: Extract<TypeInfo, { kind: 'reference' }>): Shape {
    const identity = type.identity
    if (URL_IDENTITIES.has(identity)) {
      return { kind: 'url' }
    }
    if (JSON_GLOBALS.has(identity)) {
      return JSON_SHAPE
    }
    const name = this.#types.format(type)
    if (identity.startsWith('globalThis#') || identity.startsWith('node:')) {
      const hint = GLOBAL_HINTS[identity]
      return hint === undefined
        ? unsupported(`'${name}' instances cannot be loaded from configuration`)
        : unsupported(`'${name}' instances cannot be loaded from configuration`, hint)
    }
    const symbol = this.#project.lookupIdentity(identity)
    if (symbol.kind !== 'declaration') {
      return unsupported(
        `the type '${name}' cannot be analysed`,
        'Use a type declared in TypeScript sources or declaration files',
      )
    }
    const kinds = new Set(symbol.declarations.map(declaration => declaration.kind))
    if (kinds.has('enum')) {
      return this.#enum(symbol.declarations.find(declaration => declaration.kind === 'enum') as Declaration, name)
    }
    if (kinds.has('class')) {
      return unsupported(
        `'${name}' is a class: class instances cannot be created from configuration values`,
        `Use an interface or a type alias for JSON values (\`interface ${type.name} { ... }\`)`,
      )
    }
    if (kinds.has('interface') || kinds.has('type')) {
      return JSON_SHAPE
    }
    return unsupported(`'${name}' is not a type that can be loaded from configuration`)
  }

  /** A TS enum: the base type of its members and their values, in declaration order. */
  #enum(declaration: Declaration, name: string): Shape {
    const file = this.#project.getFile(declaration.file)
    const id = (declaration.node as { readonly id?: unknown }).id
    if (!file || typeof id !== 'object' || id === null) {
      return unsupported(`the enum '${name}' cannot be analysed`, 'Use a union of literal types instead')
    }
    const result = this.#project.evaluate(
      { file, namespace: declaration.namespace },
      id as Parameters<Project['evaluate']>[1],
      { refs: 'none' },
    )
    if (result.kind !== 'value' || typeof result.value !== 'object' || result.value === null) {
      return unsupported(
        `the members of the enum '${name}' cannot be evaluated`,
        'Initialize every member with a literal, or use a union of literal types',
      )
    }
    const values = Object.values(result.value as Readonly<Record<string, StaticValue>>).filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    )
    const bases = new Set(values.map(baseOf))
    const [base] = bases
    if (base === undefined || bases.size > 1) {
      return unsupported(
        `the enum '${name}' ${base === undefined ? 'has no members' : 'mixes string and number members'}`,
        'Use an enum whose members are all strings or all numbers',
      )
    }
    return scalar(base, [...new Set(values)], false)
  }
}

type Declaration = Extract<ReturnType<Project['lookupIdentity']>, { kind: 'declaration' }>['declaration']

function baseOf(value: string | number | boolean): ScalarBase {
  return typeof value as ScalarBase
}

function arrayOf(element: Shape, text: string): Shape {
  switch (element.kind) {
    case 'scalar':
      if (element.base === 'boolean') {
        return unsupported(
          `'${text}' is not supported (lists are comma-separated strings or numbers)`,
          'Use string[] or number[], or a JSON type',
        )
      }
      return { kind: 'array', element }
    case 'url':
      return unsupported(`'${text}' is not supported`, 'Use string[] and build the URLs where they are used')
    case 'unsupported':
      return element
    default:
      // arrays of objects, nested arrays: JSON
      return JSON_SHAPE
  }
}

/** Merges the members of a union, `undefined` when they mix kinds of values. */
function mergeShapes(shapes: readonly Shape[]): Shape | undefined {
  const [first] = shapes
  if (first === undefined) {
    return undefined
  }
  switch (first.kind) {
    case 'json':
    case 'url':
      return shapes.every(shape => shape.kind === first.kind) ? first : undefined
    case 'scalar': {
      const scalars = shapes.filter(shape => shape.kind === 'scalar')
      if (scalars.length !== shapes.length || scalars.some(shape => shape.base !== first.base)) {
        return undefined
      }
      if (scalars.some(shape => shape.values === undefined)) {
        return scalar(first.base, undefined, false)
      }
      const values = [...new Set(scalars.flatMap(shape => shape.values ?? []))]
      return scalar(
        first.base,
        values,
        scalars.every(shape => shape.sorted),
      )
    }
    case 'array': {
      const elements = shapes.map(shape => (shape.kind === 'array' ? shape.element : undefined))
      if (elements.some(element => element === undefined)) {
        return undefined
      }
      const element = mergeShapes(elements as Shape[])
      return element === undefined ? undefined : { kind: 'array', element }
    }
    default:
      return undefined
  }
}

function sortValues(values: readonly ConfigEnumValue[]): ConfigEnumValue[] {
  return [...values].sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b
    }
    const left = String(a)
    const right = String(b)
    if (left === right) {
      return 0
    }
    return left < right ? -1 : 1
  })
}

function enumOf(shape: Extract<Shape, { kind: 'scalar' }>): readonly ConfigEnumValue[] | undefined {
  if (shape.values === undefined) {
    return undefined
  }
  return shape.sorted ? sortValues(shape.values) : shape.values
}

function toResult(shape: Shape): FieldTypeResult {
  switch (shape.kind) {
    case 'scalar':
      return { ok: true, type: shape.base, enum: enumOf(shape) }
    case 'array': {
      const element = shape.element
      if (element.kind !== 'scalar' || element.base === 'boolean') {
        return { ok: true, type: 'json', enum: undefined }
      }
      return { ok: true, type: element.base === 'string' ? 'string[]' : 'number[]', enum: enumOf(element) }
    }
    case 'url':
      return { ok: true, type: 'url', enum: undefined }
    case 'json':
      return { ok: true, type: 'json', enum: undefined }
    case 'unsupported':
      return { ok: false, reason: shape.reason, hints: shape.hints }
  }
}

/** Shape of an evaluated value (type inference from an initializer). */
function inferShape(value: StaticValue): Shape | undefined {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return scalar(typeof value as ScalarBase, undefined, false)
    case 'object': {
      if (value === null) {
        return undefined
      }
      if (Array.isArray(value)) {
        const items = value as readonly StaticValue[]
        if (items.length > 0 && items.every(item => typeof item === 'string')) {
          return { kind: 'array', element: scalar('string', undefined, false) }
        }
        if (items.length > 0 && items.every(item => typeof item === 'number')) {
          return { kind: 'array', element: scalar('number', undefined, false) }
        }
        return undefined
      }
      // a plain evaluated object (references are class instances)
      return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
        ? JSON_SHAPE
        : undefined
    }
    default:
      return undefined
  }
}
