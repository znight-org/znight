/**
 * TypeScript shapes (`ctx.types.shape()`, C1 of RFC 0002) → JSON Schema 2020-12 (§6.2): named
 * declarations become components (`#/components/schemas/<name>`), JSDoc tags become keywords,
 * Standard Schema aliases (`z.output<typeof S>`) become placeholders converted at assembly.
 */
import type {
  DocComment,
  Location,
  NamedShape,
  Shape,
  ShapeIssue,
  ShapeOptions,
  ShapeProperty,
  ShapeResult,
  ShapeTarget,
  ValidateContext,
  ValueRef,
} from '@znight/compiler'
import type { SchemaPlaceholder, SchemaTemplate } from '../metadata.ts'
import type { JsonSchema, JsonValue } from '../types.ts'
import type { OpenApiStored, SlotData } from './model.ts'

import { createHash } from 'node:crypto'

import { compareStrings, componentName, schemaRef } from '../shared.ts'
import { Codes, KEEP, SCHEMA_ALIASES, SCHEMA_MEMBERS } from './model.ts'

type Context = ValidateContext<OpenApiStored>
type Diagnostic = Parameters<Context['report']>[0]

/** How a schema is used (messages and severities of ZNIGHT032). */
export interface SchemaUse {
  /** `'output'`: a response body (a `bigint` makes `JSON.stringify` throw: always an error). */
  readonly io: 'input' | 'output'
  /** `GET /books/stats (BookController.stats)`. */
  readonly operation: string
  /** `the response`, `the request body`, `query parameter "q"`. */
  readonly part: string
  /** Where the type is used (the handler, the decorator...). */
  readonly location: Location | undefined
}

/** Standard Schemas referenced by the document, by identity. */
export class Slots {
  readonly #slots = new Map<string, SlotData>()
  readonly #names = new Map<string, { identity: string; location: Location }>()
  readonly #report: (diagnostic: Diagnostic) => void
  readonly #reserved: () => ReadonlySet<string>
  readonly #locate: (ref: ValueRef) => Location | undefined

  constructor(
    report: (diagnostic: Diagnostic) => void,
    reserved: () => ReadonlySet<string>,
    locate: (ref: ValueRef) => Location | undefined = () => undefined,
  ) {
    this.#report = report
    this.#reserved = reserved
    this.#locate = locate
  }

  /** The placeholder of `ref` with this io (registers the slot), `undefined` after a name conflict. */
  use(ref: ValueRef, io: 'input' | 'output'): SchemaPlaceholder | undefined {
    const identity = ref.identity ?? `${ref.location.file}#${ref.text}`
    let slot = this.#slots.get(identity)
    if (slot === undefined) {
      const name = componentName(ref.name.slice(ref.name.lastIndexOf('.') + 1))
      const other = this.#names.get(name)
      if (other !== undefined && other.identity !== identity) {
        this.#report({
          code: Codes.SchemaNameConflict,
          severity: 'error',
          message: `Two schemas are named "${name}" in the OpenAPI document: ${ref.text} and ${other.identity}`,
          location: ref.location,
          related: [{ message: 'the other schema', location: other.location }],
          hints: ['Rename one of the exported schemas: component names come from their export names'],
        })
        return undefined
      }
      if (this.#reserved().has(name)) {
        this.#report({
          code: Codes.SchemaNameConflict,
          severity: 'error',
          message: `The schema ${ref.text} is named "${name}", a name reserved for the standard error components`,
          location: ref.location,
          hints: ['Rename the schema, or turn the standard errors off: @OpenApiDocument({ errors: false })'],
        })
        return undefined
      }
      this.#names.set(name, { identity, location: ref.location })
      slot = { name, ref, io: new Set(), location: this.#locate(ref) ?? ref.location }
      this.#slots.set(identity, slot)
    }
    slot.io.add(io)
    return { $znight: 'schema', name: slot.name, io }
  }

  /** Whether a slot uses this component name. */
  has(name: string): { identity: string; location: Location } | undefined {
    return this.#names.get(name)
  }

  /** Adds an io to the slot of `identity` (no effect for an unknown slot). */
  need(identity: string, io: 'input' | 'output'): void {
    this.#slots.get(identity)?.io.add(io)
  }

  /** Slots sorted by name. */
  list(): SlotData[] {
    return [...this.#slots.values()].sort((a, b) => compareStrings(a.name, b.name))
  }
}

/** A component computed from a TypeScript declaration. */
interface Component {
  readonly key: string
  readonly identity: string
  readonly location: Location
  schema: JsonSchema | undefined
}

/** Converts shapes to JSON Schema and collects the components. */
export class Schemas {
  readonly #ctx: Context
  readonly #options: ShapeOptions
  readonly #slots: Slots
  readonly #strict: boolean
  readonly #reserved: ReadonlySet<string>
  /** Component name by named key. */
  readonly #names = new Map<string, string>()
  /** The first named key given each component name. */
  readonly #keys = new Map<string, string>()
  /** Components by name. */
  readonly #components = new Map<string, Component>()
  /** Every named shape seen, by key. */
  readonly #named = new Map<string, NamedShape>()
  /** Issues reported so far, with the severity they were reported at. */
  readonly #reported = new WeakMap<object, 'warning' | 'error'>()
  readonly #conflicts = new Set<string>()

  constructor(ctx: Context, options: { jsdoc: boolean; strict: boolean; reserved: ReadonlySet<string> }, slots: Slots) {
    this.#ctx = ctx
    this.#slots = slots
    this.#strict = options.strict
    this.#reserved = options.reserved
    this.#options = {
      schemaAliases: SCHEMA_ALIASES,
      schemaMembers: SCHEMA_MEMBERS,
      keep: KEEP,
      jsdoc: options.jsdoc,
    }
  }

  /** The shape of a target with the options of the extension. */
  shape(target: ShapeTarget): ShapeResult {
    return this.#ctx.types.shape(target, this.#options)
  }

  /** Components computed so far, sorted by name. */
  components(): Record<string, JsonSchema> {
    const result: Record<string, JsonSchema> = {}
    for (const name of [...this.#components.keys()].sort(compareStrings)) {
      const schema = this.#components.get(name)?.schema
      if (schema !== undefined) result[name] = schema
    }
    return result
  }

  /** A named shape seen by a result (`undefined` for an unknown key). */
  named(key: string): NamedShape | undefined {
    return this.#named.get(key)
  }

  /**
   * Registers the named shapes of `result` and reports its issues. Call it before converting shapes
   * of the result.
   */
  register(result: ShapeResult, use: SchemaUse): void {
    for (const named of result.named.values()) this.#named.set(named.key, named)
    for (const named of result.named.values()) this.#component(named)
    for (const issue of result.issues) this.#issue(issue, use)
  }

  /** JSON Schema of the root of `result` (registers it first). */
  fromResult(result: ShapeResult, use: SchemaUse): SchemaTemplate {
    this.register(result, use)
    return this.convert(result.root, use, '')
  }

  /** JSON Schema of a shape whose result was {@link register}ed. */
  convert(shape: Shape, use: SchemaUse, path: string): SchemaTemplate {
    switch (shape.kind) {
      case 'string':
        return { type: 'string' }
      case 'number':
        return { type: 'number' }
      case 'boolean':
        return { type: 'boolean' }
      case 'null':
        return { type: 'null' }
      case 'undefined':
      case 'unknown':
        return {}
      case 'never':
        return { not: {} }
      case 'date':
        return { type: 'string', format: 'date-time' }
      case 'url':
        return { type: 'string', format: 'uri' }
      case 'bigint':
        // reported through the issues of the result
        return { type: 'string', pattern: '^-?[0-9]+$' }
      case 'binary':
        if (path !== '') {
          this.#warn(
            `${path} is binary data: inside a JSON body JSON.stringify writes it as an object of numeric keys (${use.operation})`,
            use,
            ['Send bytes as the whole body (application/octet-stream), or encode them (base64 string)'],
          )
        }
        return { type: 'string', contentMediaType: 'application/octet-stream' }
      case 'literal':
        return { type: typeof shape.value as 'string' | 'number' | 'boolean', const: shape.value }
      case 'array':
        return { type: 'array', items: this.convert(shape.items, use, `${path}[]`) as JsonValue }
      case 'tuple':
        return this.#tuple(shape, use, path)
      case 'object':
        return this.#object(shape.properties, shape.additional, use, path)
      case 'union':
        return this.#union(shape.members, use, path)
      case 'intersection':
        return this.#intersection(shape.members, use, path)
      case 'named': {
        const name = this.#nameOfKey(shape.key)
        return name === undefined ? {} : { $ref: schemaRef(name) }
      }
      case 'schema':
        return this.#slots.use(shape.ref, shape.io) ?? {}
      case 'reference':
        this.#warn(
          `${path === '' ? 'The type' : path} (${shape.name}) cannot be documented inside a JSON body (${use.operation})`,
          use,
          [],
        )
        return {}
      case 'opaque':
        // reported through the issues of the result
        return {}
    }
  }

  // ------------------------------------------------------------------------------------------------
  // components

  /**
   * Checks the components against the schema slots once every operation is built, whatever the order
   * they were met in: a declaration merged with the schema it is inferred from (`const User =
   * z.object(...)` and `interface User extends z.infer<typeof User> {}`) is documented by the schema
   * (its output variant); another declaration with the name of a schema is ZNIGHT034.
   */
  settle(): void {
    for (const [name, component] of [...this.#components]) {
      const slot = this.#slots.has(name)
      if (slot === undefined) continue
      if (slot.identity === component.identity) {
        this.#components.delete(name)
        this.#slots.need(slot.identity, 'output')
        continue
      }
      const named = this.#named.get(component.key)
      const key = `${name}\u0000${component.key}`
      if (this.#conflicts.has(key)) continue
      this.#conflicts.add(key)
      this.#ctx.report({
        code: Codes.SchemaNameConflict,
        severity: 'error',
        message: `Two schemas are named "${name}" in the OpenAPI document: the ${named?.declaration ?? 'declaration'} ${named?.name ?? component.identity} and the schema ${slot.identity}`,
        location: component.location,
        related: [{ message: 'the schema', location: slot.location }],
        hints: ['Rename one of them: component names come from declaration and export names'],
      })
    }
  }

  #component(named: NamedShape): void {
    const name = this.#nameOf(named)
    const existing = this.#components.get(name)
    if (existing !== undefined) {
      if (existing.key !== named.key) this.#conflict(name, named, existing)
      return
    }
    if (this.#reserved.has(name)) {
      const key = `${name}\u0000${named.key}`
      if (!this.#conflicts.has(key)) {
        this.#conflicts.add(key)
        this.#ctx.report({
          code: Codes.SchemaNameConflict,
          severity: 'error',
          message: `${named.name} is named "${name}", a name reserved for the standard error components of the OpenAPI document`,
          location: named.location,
          hints: ['Rename one of them: component names come from declaration and export names'],
        })
      }
      return
    }
    const component: Component = {
      key: named.key,
      identity: named.identity,
      location: named.location,
      schema: undefined,
    }
    this.#components.set(name, component)
    const use: SchemaUse = { io: 'output', operation: named.name, part: named.name, location: named.location }
    const schema = this.convert(named.shape, use, named.name)
    component.schema = withDoc(schema as JsonSchema, named.doc, issue => this.#tagIssue(issue))
  }

  #conflict(name: string, named: NamedShape, existing: Component): void {
    const key = [named.key, existing.key].sort(compareStrings).join('\u0000')
    if (this.#conflicts.has(key)) return
    this.#conflicts.add(key)
    this.#ctx.report({
      code: Codes.SchemaNameConflict,
      severity: 'error',
      message: `Two declarations are named "${name}" in the OpenAPI document: ${named.identity} and ${existing.identity}`,
      location: named.location,
      related: [{ message: 'the other declaration', location: existing.location }],
      hints: ['Rename one of them: component names come from declaration names'],
    })
  }

  #nameOfKey(key: string): string | undefined {
    const named = this.#named.get(key)
    return named === undefined ? undefined : this.#nameOf(named)
  }

  /**
   * The component name of a declaration: its name, then the names of its type arguments
   * (`Page_Book`). An instantiation with an anonymous argument (`Page<{ id: string }>`), or whose
   * name another instantiation of the same declaration already has (`Box<Book[]>`, `Box<BookArray>`),
   * also gets a short hash of its key (`Page_object_1a2b3c4d`): two instantiations never clash.
   */
  #nameOf(named: NamedShape): string {
    let name = this.#names.get(named.key)
    if (name === undefined) {
      if (named.typeArgs.length === 0) name = componentName(named.name)
      else {
        const args = named.typeArgs.map(arg => this.#argName(arg))
        name = componentName([named.name, ...args.map(arg => arg.text)].join('_'))
        const taken = this.#keys.get(name)
        const sibling =
          taken !== undefined && taken !== named.key && this.#named.get(taken)?.identity === named.identity
        if (sibling || args.some(arg => !arg.exact)) name = `${name}_${shortHash(named.key)}`
      }
      this.#names.set(named.key, name)
      if (!this.#keys.has(name)) this.#keys.set(name, named.key)
    }
    return name
  }

  /** The name of a type argument; `exact: false` when it does not tell the argument apart (`object`). */
  #argName(shape: Shape): { text: string; exact: boolean } {
    switch (shape.kind) {
      case 'named':
        return { text: this.#nameOfKey(shape.key) ?? 'unknown', exact: true }
      case 'literal':
        return { text: String(shape.value), exact: true }
      case 'array': {
        const items = this.#argName(shape.items)
        return { text: `${items.text}Array`, exact: items.exact }
      }
      case 'union':
      case 'intersection': {
        const members = shape.members.map(member => this.#argName(member))
        return {
          text: members.map(member => member.text).join(shape.kind === 'union' ? '_or_' : '_and_'),
          exact: members.every(member => member.exact),
        }
      }
      case 'schema':
        return { text: componentName(shape.ref.name), exact: true }
      case 'reference':
        return { text: shape.name, exact: shape.typeArgs.length === 0 }
      case 'opaque':
      case 'object':
      case 'tuple':
        return { text: shape.kind, exact: false }
      default:
        return { text: shape.kind, exact: true }
    }
  }

  // ------------------------------------------------------------------------------------------------
  // structures

  #tuple(shape: Extract<Shape, { kind: 'tuple' }>, use: SchemaUse, path: string): JsonSchema {
    const prefixItems = shape.items.map((item, index) => this.convert(item, use, `${path}[${index}]`) as JsonValue)
    const schema: Record<string, JsonValue> = { type: 'array', prefixItems, minItems: shape.minItems }
    if (shape.rest === undefined) {
      schema['maxItems'] = shape.items.length
      schema['items'] = false
    } else {
      schema['items'] = this.convert(shape.rest, use, `${path}[]`) as JsonValue
    }
    return schema
  }

  #object(
    properties: readonly ShapeProperty[],
    additional: Shape | undefined,
    use: SchemaUse,
    path: string,
  ): JsonSchema {
    const schema: Record<string, JsonValue> = { type: 'object' }
    if (properties.length > 0) {
      const props: Record<string, JsonValue> = {}
      for (const property of properties) {
        const converted = this.convert(property.shape, use, path === '' ? property.name : `${path}.${property.name}`)
        props[property.name] = withDoc(converted as JsonSchema, property.doc, issue =>
          this.#tagIssue(issue),
        ) as JsonValue
      }
      schema['properties'] = props
      const required = properties
        .filter(property => !property.optional)
        .map(property => property.name)
        .sort(compareStrings)
      if (required.length > 0) schema['required'] = required
    }
    if (additional !== undefined) {
      schema['additionalProperties'] = this.convert(additional, use, `${path}[string]`) as JsonValue
    }
    return schema
  }

  #union(members: readonly Shape[], use: SchemaUse, path: string): SchemaTemplate {
    const defined = members.filter(member => member.kind !== 'undefined')
    const nullable = defined.some(member => member.kind === 'null')
    const rest = defined.filter(member => member.kind !== 'null')
    if (rest.length === 0) return nullable ? { type: 'null' } : {}
    if (rest.every(member => member.kind === 'literal')) {
      const values = rest.map(member => (member as Extract<Shape, { kind: 'literal' }>).value)
      const types = [...new Set(values.map(value => typeof value))]
      const schema: Record<string, JsonValue> = {}
      if (types.length === 1) schema['type'] = nullable ? [types[0] as string, 'null'] : (types[0] as string)
      schema['enum'] = nullable ? [...values, null] : values
      return schema
    }
    const converted = rest.map(member => this.convert(member, use, path))
    if (converted.length === 1) {
      const single = converted[0] as JsonSchema
      if (!nullable) return single
      if (typeof single['type'] === 'string' && !Object.keys(single).some(key => NOT_NULLABLE_KEYS.has(key))) {
        return { ...single, type: [single['type'], 'null'] }
      }
      return { anyOf: [single as JsonValue, { type: 'null' }] }
    }
    // only simple `{ type }` members: a type list
    const simple = converted as readonly JsonSchema[]
    if (simple.every(schema => Object.keys(schema).length === 1 && typeof schema['type'] === 'string')) {
      const types = simple.map(schema => schema['type'] as string)
      return { type: nullable ? [...types, 'null'] : types }
    }
    const discriminator = this.#discriminator(rest)
    const list: JsonValue[] = converted.map(schema => schema as JsonValue)
    if (nullable) list.push({ type: 'null' })
    if (discriminator === undefined) return { anyOf: list }
    const mapping: Record<string, string> = {}
    rest.forEach((member, index) => {
      const ref = (converted[index] as JsonSchema)['$ref']
      if (member.kind === 'named' && typeof ref === 'string') {
        mapping[String(discriminator.values[index])] = ref
      }
    })
    const schema: Record<string, JsonValue> = { oneOf: list }
    // without a mapping, tools read the values as component names: only when every member is a component
    if (Object.keys(mapping).length === rest.length) {
      schema['discriminator'] = { propertyName: discriminator.property, mapping }
    }
    return schema
  }

  /** A required literal property with distinct (string) values in every object member. */
  #discriminator(members: readonly Shape[]): { property: string; values: (string | number | boolean)[] } | undefined {
    const objects = members.map(member => this.#objectOf(member))
    if (objects.some(object => object === undefined)) return undefined
    const literals = objects.map(object => {
      const map = new Map<string, string | number | boolean>()
      for (const property of object?.properties ?? []) {
        if (!property.optional && property.shape.kind === 'literal' && typeof property.shape.value === 'string') {
          map.set(property.name, property.shape.value)
        }
      }
      return map
    })
    const first = literals[0]
    if (first === undefined) return undefined
    for (const property of [...first.keys()].sort(compareStrings)) {
      if (!literals.every(map => map.has(property))) continue
      const values = literals.map(map => map.get(property) as string | number | boolean)
      if (new Set(values).size === values.length) return { property, values }
    }
    return undefined
  }

  /** The object structure of a shape (named declarations resolved). */
  #objectOf(shape: Shape): Extract<Shape, { kind: 'object' }> | undefined {
    if (shape.kind === 'object') return shape
    if (shape.kind === 'named') {
      const named = this.#named.get(shape.key)
      return named === undefined ? undefined : this.#objectOf(named.shape)
    }
    if (shape.kind === 'intersection') {
      const parts = shape.members.map(member => this.#objectOf(member))
      if (parts.some(part => part === undefined)) return undefined
      const properties = new Map<string, ShapeProperty>()
      for (const part of parts) for (const property of part?.properties ?? []) properties.set(property.name, property)
      return { kind: 'object', properties: [...properties.values()] }
    }
    return undefined
  }

  #intersection(members: readonly Shape[], use: SchemaUse, path: string): SchemaTemplate {
    const merged = this.#objectOf({ kind: 'intersection', members })
    if (merged !== undefined) {
      const additional = members.map(member => this.#objectOf(member)?.additional).find(value => value !== undefined)
      return this.#object(merged.properties, additional, use, path)
    }
    return { allOf: members.map(member => this.convert(member, use, path) as JsonValue) }
  }

  // ------------------------------------------------------------------------------------------------
  // diagnostics

  #issue(issue: ShapeIssue, use: SchemaUse): void {
    // one report per issue, unless a later use is more severe (a bigint met in a request body, then in a response)
    const severity = (issue.reason === 'bigint' && use.io === 'output') || this.#strict ? 'error' : 'warning'
    const reported = this.#reported.get(issue)
    if (reported === 'error' || reported === severity) return
    this.#reported.set(issue, severity)
    const subject = issue.path === '' ? `The type of ${use.part}` : issue.path
    const location = issue.location ?? use.location
    const related =
      issue.location !== undefined && use.location !== undefined
        ? [{ message: `${use.part} of ${use.operation}`, location: use.location }]
        : []
    if (issue.reason === 'bigint') {
      const response = use.io === 'output'
      this.#ctx.report({
        code: Codes.UnrepresentableType,
        severity,
        message: response
          ? `${subject} is a bigint: JSON.stringify throws on bigint, so ${use.operation} would answer 500`
          : `${subject} is a bigint: JSON has no bigint (${use.operation})`,
        ...(location === undefined ? {} : { location }),
        related,
        hints: [
          response
            ? 'Return a number or a string (String(total)), or give the type a toJSON() method'
            : 'Declare a string and convert it (BigInt(value)), or validate the body with a schema',
        ],
      })
      return
    }
    this.#ctx.report({
      code: Codes.UnrepresentableType,
      severity,
      message: `${subject} (${issue.text}) ${REASONS[issue.reason] ?? 'has no JSON Schema'}: it is documented as any value (${use.operation})`,
      ...(location === undefined ? {} : { location }),
      related,
      hints: HINTS[issue.reason] ?? [],
    })
  }

  #warn(message: string, use: SchemaUse, hints: readonly string[]): void {
    this.#ctx.report({
      code: Codes.UnrepresentableType,
      severity: this.#strict ? 'error' : 'warning',
      message,
      ...(use.location === undefined ? {} : { location: use.location }),
      hints,
    })
  }

  #tagIssue(issue: TagIssue): void {
    this.#ctx.report({
      code: Codes.UnrepresentableType,
      severity: this.#strict ? 'error' : 'warning',
      message: issue.message,
      location: issue.location,
      hints: ['JSDoc tag values are JSON (`@minimum 1`, `@example {"id": 1}`) or text'],
    })
  }
}

/** 8 hexadecimal characters of the SHA-256 of `text` (deterministic name suffixes). */
function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/** Keywords whose meaning changes when `null` joins the type list (`enum`, `const`...): `anyOf` instead. */
const NOT_NULLABLE_KEYS = new Set(['$ref', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not'])

const REASONS: Readonly<Record<string, string>> = {
  function: 'is a function, which JSON.stringify skips',
  symbol: 'is a symbol, which JSON.stringify skips',
  'type-parameter': 'is an unbound type parameter',
  'non-json': 'is not serialised as declared by JSON.stringify',
  mapped: 'is a mapped type the compiler cannot expand',
  conditional: 'is a conditional type the compiler cannot expand',
  typeof: 'is a typeof type that is not a schema',
  'indexed-access': 'is an indexed access type the compiler cannot resolve',
  'type-operator': 'uses a type operator the compiler cannot expand',
  this: 'is a this type',
  unresolved: 'cannot be resolved',
  'missing-annotation': 'has no type annotation',
  'to-json': 'has a toJSON() method without return type annotation',
  recursive: 'is a recursion the compiler cannot follow',
  unsupported: 'has no JSON Schema',
}

const HINTS: Readonly<Record<string, readonly string[]>> = {
  'non-json': ['Map, Set, RegExp and Error become {} in JSON: use an array or a record, or add a toJSON() method'],
  'to-json': ['Annotate the return type of toJSON(): toJSON(): BookJson'],
  'missing-annotation': ['Annotate the type: the compiler reads annotations only'],
  conditional: ['Declare the structure with an interface, or describe the body with @ApiResponse({ schema })'],
  mapped: ['Declare the structure with an interface, or describe the body with @ApiResponse({ schema })'],
  'type-parameter': ['Give the type arguments explicitly'],
  function: ['Remove the member from the transported type'],
}

/** A JSDoc tag with an invalid value. */
interface TagIssue {
  readonly message: string
  readonly location: Location
}

const NUMERIC_TAGS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
const COUNT_TAGS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])

/** Adds the JSDoc text and tags of `doc` to a schema (§6.2 "JSDoc tags on types and properties"). */
export function withDoc(
  schema: JsonSchema,
  doc: DocComment | undefined,
  report: (issue: TagIssue) => void,
): JsonSchema {
  if (doc === undefined) return schema
  const result: Record<string, JsonValue | undefined> = { ...schema }
  if (doc.text !== '') result['description'] = doc.text
  for (const tag of doc.tags) {
    const text = tag.text.trim()
    const invalid = (expected: string): void =>
      report({
        message: `Invalid @${tag.name} value ${JSON.stringify(text)}: expected ${expected}`,
        location: tag.location,
      })
    if (tag.name === 'deprecated') {
      result['deprecated'] = true
    } else if (tag.name === 'example') {
      const examples = Array.isArray(result['examples']) ? (result['examples'] as JsonValue[]) : []
      result['examples'] = [...examples, parseTagValue(stripFence(text))]
    } else if (tag.name === 'default') {
      result['default'] = parseTagValue(text)
    } else if (tag.name === 'format') {
      if (text === '' || /\s/.test(text)) invalid('a format name (date, email, int32...)')
      else {
        result['format'] = text
        if ((text === 'int32' || text === 'int64') && result['type'] === 'number') result['type'] = 'integer'
      }
    } else if (NUMERIC_TAGS.has(tag.name)) {
      const value = parseTagValue(text)
      if (typeof value === 'number' && Number.isFinite(value)) result[tag.name] = value
      else invalid('a number')
    } else if (COUNT_TAGS.has(tag.name)) {
      const value = parseTagValue(text)
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) result[tag.name] = value
      else invalid('a non-negative integer')
    } else if (tag.name === 'pattern') {
      try {
        new RegExp(text, 'u')
        result['pattern'] = text
      } catch {
        invalid('a regular expression')
      }
    } else if (tag.name === 'uniqueItems') {
      const value = text === '' ? true : parseTagValue(text)
      if (typeof value === 'boolean') result['uniqueItems'] = value
      else invalid('true or false')
    }
  }
  return result as JsonSchema
}

/** A tag value: JSON when it parses, the text otherwise. */
export function parseTagValue(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return text
  }
}

function stripFence(text: string): string {
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text)
  return fenced?.[1]?.trim() ?? text
}
