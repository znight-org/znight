/**
 * Deterministic SDL printer (RFC 0005 §6.7, §7.3).
 *
 * Prints a schema model (the data of `metadata.extensions.graphql`, without its functions) exactly
 * like graphql-js 17 `printSchema()` prints the `GraphQLSchema` the runtime builds from it: same
 * order, same block strings, same default value literals, byte for byte. The compiler hashes this
 * output (`schemaHash`) and writes it as the optional SDL artifact; the runtime can print without
 * graphql-js.
 *
 * Import-free (types and constants of import-free modules only): shared by the compiler extension
 * and the runtime. Equivalence holds when the runtime builds the schema the way this module
 * assumes:
 *
 * - every type of the model passed to `new GraphQLSchema({ types })` in model order (metadata types
 *   are sorted by name), so the type map, hence `printSchema`, follows that order;
 * - default values passed as `default: { value }` (external values: enum values by name), printed
 *   by graphql-js through `valueToLiteral`;
 * - built-in scalars (`names.ts`) without description, with their `specifiedByURL`, and no scalar
 *   with a custom `valueToLiteral` used in a default value.
 */
import { BUILTIN_SCALARS, DEFAULT_DEPRECATION_REASON, ROOT_TYPE_NAMES, SPECIFIED_SCALARS } from './names.ts'
import { type GraphQLTypeRef, parseTypeRef } from './type-ref.ts'

/** The schema to print: the shape of `GraphQLMetadata` without resolvers nor scalar implementations. */
export interface SdlSchema {
  readonly roots: SdlRoots
  /** Printed in this order (graphql-js specified scalars are skipped). */
  readonly types: readonly SdlType[]
}

/** Names of the root operation types. */
export interface SdlRoots {
  readonly query: string
  readonly mutation?: string
  readonly subscription?: string
}

/** A named type of the schema. */
export type SdlType = SdlObjectType | SdlInputType | SdlEnumType | SdlUnionType | SdlScalarType

/** What every named type has. */
export interface SdlNamedType {
  readonly name: string
  readonly description?: string
}

/** An object type (`type Book { ... }`). */
export interface SdlObjectType extends SdlNamedType {
  readonly kind: 'object'
  readonly fields: readonly SdlField[]
}

/** A field of an object type. */
export interface SdlField {
  readonly name: string
  /** Type reference (`'[Book!]!'`). */
  readonly type: string
  readonly description?: string
  readonly deprecationReason?: string
  readonly args?: readonly SdlInputValue[]
}

/** An argument or an input field. */
export interface SdlInputValue {
  readonly name: string
  readonly type: string
  readonly description?: string
  readonly deprecationReason?: string
  /** External value (JSON-compatible, enum values by name); `undefined`: no default. */
  readonly defaultValue?: unknown
}

/** An input object type (`input NewBookInput { ... }`). */
export interface SdlInputType extends SdlNamedType {
  readonly kind: 'input'
  readonly fields: readonly SdlInputValue[]
}

/** An enum type. */
export interface SdlEnumType extends SdlNamedType {
  readonly kind: 'enum'
  readonly values: readonly SdlEnumValue[]
}

/** A value of an enum type. */
export interface SdlEnumValue {
  readonly name: string
  readonly description?: string
  readonly deprecationReason?: string
}

/** A union type. */
export interface SdlUnionType extends SdlNamedType {
  readonly kind: 'union'
  readonly members: readonly string[]
}

/** A scalar type: a built-in one of `@znight/graphql` (`builtin: true`) or a user scalar. */
export interface SdlScalarType extends SdlNamedType {
  readonly kind: 'scalar'
  readonly builtin?: boolean
  /** `@specifiedBy(url:)`. Built-in scalars default to the URL of `BUILTIN_SCALARS`. */
  readonly specifiedByURL?: string
}

/**
 * Prints the SDL of a schema, without a trailing newline (like `printSchema`). Throws an `Error` on
 * a malformed type reference or a default value that does not match its type (the compiler reports
 * these as diagnostics before printing).
 */
export function printSdl(schema: SdlSchema): string {
  const types = new Map<string, SdlType>()
  for (const type of schema.types) types.set(type.name, type)
  const printer = new SdlPrinter(types)
  const parts: string[] = []
  const definition = printSchemaDefinition(schema.roots, types)
  if (definition !== undefined) parts.push(definition)
  for (const type of schema.types) {
    if (!SPECIFIED_SCALARS.has(type.name)) parts.push(printer.type(type))
  }
  return parts.join('\n\n')
}

/** `schema { ... }`, only when the root types do not have their default names (as graphql-js). */
function printSchemaDefinition(roots: SdlRoots, types: ReadonlyMap<string, SdlType>): string | undefined {
  // graphql-js compares `getQueryType() == getType('Query')` (and so on): a missing root equals a
  // missing type of the default name.
  const isDefault = (root: string | undefined, name: string): boolean =>
    root === undefined ? !types.has(name) : root === name
  if (
    isDefault(roots.query, ROOT_TYPE_NAMES.query) &&
    isDefault(roots.mutation, ROOT_TYPE_NAMES.mutation) &&
    isDefault(roots.subscription, ROOT_TYPE_NAMES.subscription)
  ) {
    return undefined
  }
  return (
    'schema {\n' +
    `  query: ${roots.query}\n` +
    (roots.mutation === undefined ? '' : `  mutation: ${roots.mutation}\n`) +
    (roots.subscription === undefined ? '' : `  subscription: ${roots.subscription}\n`) +
    '}'
  )
}

/** A GraphQL value literal (the subset of graphql-js `ConstValueNode` defaults can produce). */
type Literal =
  | { readonly kind: 'IntValue' | 'FloatValue' | 'StringValue' | 'EnumValue'; readonly value: string }
  | { readonly kind: 'BooleanValue'; readonly value: boolean }
  | { readonly kind: 'NullValue' }
  | { readonly kind: 'ListValue'; readonly values: readonly Literal[] }
  | { readonly kind: 'ObjectValue'; readonly fields: readonly (readonly [name: string, value: Literal])[] }

const GRAPHQL_MAX_INT = 2_147_483_647
const GRAPHQL_MIN_INT = -2_147_483_648
const INTEGER_STRING = /^-?(?:0|[1-9][0-9]*)$/
/** graphql-js `print()` breaks lists and objects longer than this. */
const MAX_LINE_LENGTH = 80

class SdlPrinter {
  readonly #types: ReadonlyMap<string, SdlType>

  constructor(types: ReadonlyMap<string, SdlType>) {
    this.#types = types
  }

  type(type: SdlType): string {
    const head = printDescription(type.description, '', true)
    switch (type.kind) {
      case 'object':
        return `${head}type ${type.name}${printBlock(type.fields.map((field, i) => this.#field(type.name, field, i)))}`
      case 'input':
        return `${head}input ${type.name}${printBlock(
          type.fields.map(
            (field, i) =>
              `${printDescription(field.description, '  ', i === 0)}  ${this.#inputValue(field, `${type.name}.${field.name}`)}`,
          ),
        )}`
      case 'enum':
        return `${head}enum ${type.name}${printBlock(
          type.values.map(
            (value, i) =>
              `${printDescription(value.description, '  ', i === 0)}  ${value.name}${printDeprecated(value.deprecationReason)}`,
          ),
        )}`
      case 'union':
        return `${head}union ${type.name}${type.members.length === 0 ? '' : ` = ${type.members.join(' | ')}`}`
      case 'scalar': {
        const url =
          type.specifiedByURL ?? (type.builtin === true ? BUILTIN_SCALARS.get(type.name)?.specifiedByURL : undefined)
        return `${head}scalar ${type.name}${url === undefined ? '' : ` @specifiedBy(url: ${printString(url)})`}`
      }
    }
  }

  #field(typeName: string, field: SdlField, index: number): string {
    const coordinate = `${typeName}.${field.name}`
    return (
      `${printDescription(field.description, '  ', index === 0)}  ${field.name}` +
      this.#args(coordinate, field.args ?? []) +
      `: ${checkedTypeRef(field.type, coordinate)}${printDeprecated(field.deprecationReason)}`
    )
  }

  #args(coordinate: string, args: readonly SdlInputValue[]): string {
    if (args.length === 0) return ''
    if (args.every(arg => arg.description === undefined)) {
      return `(${args.map(arg => this.#inputValue(arg, `${coordinate}(${arg.name}:)`)).join(', ')})`
    }
    const lines = args.map(
      (arg, i) =>
        `${printDescription(arg.description, '    ', i === 0)}    ${this.#inputValue(arg, `${coordinate}(${arg.name}:)`)}`,
    )
    return `(\n${lines.join('\n')}\n  )`
  }

  #inputValue(value: SdlInputValue, coordinate: string): string {
    const ref = parseTypeRef(value.type)
    if (ref === undefined) throw new Error(`Invalid type reference '${value.type}' (${coordinate})`)
    let declaration = `${value.name}: ${value.type}`
    if (value.defaultValue !== undefined) {
      const literal = this.#literal(value.defaultValue, ref)
      if (literal === undefined) {
        throw new Error(`Invalid default value for ${coordinate}: ${describe(value.defaultValue)}`)
      }
      declaration += ` = ${printLiteral(literal)}`
    }
    return declaration + printDeprecated(value.deprecationReason)
  }

  /** graphql-js `valueToLiteral(value, type)`: `undefined` when the value does not fit the type. */
  #literal(value: unknown, ref: GraphQLTypeRef): Literal | undefined {
    if (ref.nonNull && value == null) return undefined
    if (value == null) return { kind: 'NullValue' }
    if (ref.kind === 'list') {
      const item: GraphQLTypeRef = ref.of
      if (!isIterableObject(value)) return this.#literal(value, item)
      const values: Literal[] = []
      for (const entry of value) {
        const literal = this.#literal(entry, item)
        if (literal === undefined) return undefined
        values.push(literal)
      }
      return { kind: 'ListValue', values }
    }
    const type = this.#types.get(ref.name)
    if (type?.kind === 'input') return this.#inputLiteral(value, type)
    if (type?.kind === 'enum') {
      return typeof value === 'string' && type.values.some(entry => entry.name === value)
        ? { kind: 'EnumValue', value }
        : undefined
    }
    return scalarLiteral(value, ref.name)
  }

  #inputLiteral(value: unknown, type: SdlInputType): Literal | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Readonly<Record<string, unknown>>
    for (const key of Object.keys(record)) {
      if (record[key] !== undefined && !type.fields.some(field => field.name === key)) return undefined
    }
    const fields: (readonly [string, Literal])[] = []
    for (const field of type.fields) {
      const fieldValue = Object.hasOwn(record, field.name) ? record[field.name] : undefined
      const ref = parseTypeRef(field.type)
      if (ref === undefined) return undefined
      if (fieldValue === undefined) {
        // required input field: non-null without default
        if (ref.nonNull && field.defaultValue === undefined) return undefined
        continue
      }
      const literal = this.#literal(fieldValue, ref)
      if (literal === undefined) return undefined
      fields.push([field.name, literal])
    }
    return { kind: 'ObjectValue', fields }
  }
}

/** The `valueToLiteral` of the specified scalars, and graphql-js' default one for the others. */
function scalarLiteral(value: unknown, name: string): Literal | undefined {
  switch (name) {
    case 'Int': {
      const integer = (typeof value === 'number' && Number.isInteger(value)) || typeof value === 'bigint'
      return integer && value <= GRAPHQL_MAX_INT && value >= GRAPHQL_MIN_INT
        ? { kind: 'IntValue', value: String(value) }
        : undefined
    }
    case 'Float': {
      // graphql-js wraps the `valueToLiteral` of a scalar in a try/catch: a value it cannot convert
      // (a function) is a mismatch, not a crash
      try {
        const literal = defaultScalarLiteral(value)
        return literal.kind === 'FloatValue' || literal.kind === 'IntValue' ? literal : undefined
      } catch {
        return undefined
      }
    }
    case 'String':
      return typeof value === 'string' ? { kind: 'StringValue', value } : undefined
    case 'Boolean':
      return typeof value === 'boolean' ? { kind: 'BooleanValue', value } : undefined
    case 'ID':
      if (typeof value === 'string') {
        return INTEGER_STRING.test(value) ? { kind: 'IntValue', value } : { kind: 'StringValue', value }
      }
      if (typeof value === 'number')
        return Number.isInteger(value) ? { kind: 'IntValue', value: String(value) } : undefined
      return typeof value === 'bigint' ? { kind: 'IntValue', value: String(value) } : undefined
    default:
      return defaultScalarLiteral(value)
  }
}

/** graphql-js `defaultScalarValueToLiteral`. */
function defaultScalarLiteral(value: unknown): Literal {
  if (value == null) return { kind: 'NullValue' }
  switch (typeof value) {
    case 'boolean':
      return { kind: 'BooleanValue', value }
    case 'string':
      return { kind: 'StringValue', value }
    case 'bigint':
      return { kind: 'IntValue', value: value.toString() }
    case 'number': {
      if (!Number.isFinite(value)) return { kind: 'NullValue' }
      const text = String(value)
      return INTEGER_STRING.test(text) ? { kind: 'IntValue', value: text } : { kind: 'FloatValue', value: text }
    }
    case 'object': {
      if (isIterableObject(value)) return { kind: 'ListValue', values: Array.from(value, defaultScalarLiteral) }
      const record = value as Readonly<Record<string, unknown>>
      const fields: (readonly [string, Literal])[] = []
      for (const key of Object.keys(record)) {
        if (record[key] !== undefined) fields.push([key, defaultScalarLiteral(record[key])])
      }
      return { kind: 'ObjectValue', fields }
    }
    default:
      throw new TypeError(`Cannot convert value to AST: ${describe(value)}.`)
  }
}

function isIterableObject(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  )
}

/** graphql-js `print()` of a value literal. */
function printLiteral(literal: Literal): string {
  switch (literal.kind) {
    case 'IntValue':
    case 'FloatValue':
    case 'EnumValue':
      return literal.value
    case 'StringValue':
      return printString(literal.value)
    case 'BooleanValue':
      return literal.value ? 'true' : 'false'
    case 'NullValue':
      return 'null'
    case 'ListValue': {
      const values = literal.values.map(printLiteral)
      const line = `[${values.join(', ')}]`
      return line.length > MAX_LINE_LENGTH ? `[\n${indent(values.join('\n'))}\n]` : line
    }
    case 'ObjectValue': {
      const fields = literal.fields.map(([name, value]) => `${name}: ${printLiteral(value)}`)
      const line = `{ ${fields.join(', ')} }`
      if (line.length <= MAX_LINE_LENGTH) return line
      const body = indent(fields.join('\n'))
      return body === '' ? '' : `{\n${body}\n}`
    }
  }
}

/** graphql-js `indent()` of the printer. */
function indent(text: string): string {
  return text === '' ? '' : `  ${text.replaceAll('\n', '\n  ')}`
}

function printBlock(items: readonly string[]): string {
  return items.length === 0 ? '' : ` {\n${items.join('\n')}\n}`
}

function printDeprecated(reason: string | undefined): string {
  if (reason === undefined) return ''
  return reason === DEFAULT_DEPRECATION_REASON ? ' @deprecated' : ` @deprecated(reason: ${printString(reason)})`
}

/** graphql-js `printDescription()` of `printSchema`. */
function printDescription(description: string | undefined, indentation: string, firstInBlock: boolean): string {
  if (description === undefined) return ''
  const text = isPrintableAsBlockString(description) ? printBlockString(description) : printString(description)
  const prefix = indentation !== '' && !firstInBlock ? `\n${indentation}` : indentation
  return `${prefix}${text.replaceAll('\n', `\n${indentation}`)}\n`
}

function checkedTypeRef(type: string, coordinate: string): string {
  if (parseTypeRef(type) === undefined) throw new Error(`Invalid type reference '${type}' (${coordinate})`)
  return type
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// --- graphql-js string printers (language/printString.ts, language/blockString.ts) ---

/** `\t` and space: the GraphQL `WhiteSpace` characters. */
function isWhiteSpace(code: number): boolean {
  return code === 0x09 || code === 0x20
}

/** Escape sequence of each code unit graphql-js escapes in a string value. */
const ESCAPES: readonly string[] = Array.from({ length: 0xa0 }, (_, code) => {
  switch (code) {
    case 0x08:
      return '\\b'
    case 0x09:
      return '\\t'
    case 0x0a:
      return '\\n'
    case 0x0c:
      return '\\f'
    case 0x0d:
      return '\\r'
    case 0x22:
      return '\\"'
    case 0x5c:
      return '\\\\'
    default:
      return code < 0x20 || code >= 0x7f ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}` : ''
  }
})
// biome-ignore lint/suspicious/noControlCharactersInRegex: graphql-js escapes exactly these code units
const ESCAPED = /[\x00-\x1f\x22\x5c\x7f-\x9f]/g

/** A GraphQL string value (`"..."`), escaped like graphql-js `printString`. */
export function printString(value: string): string {
  return `"${value.replace(ESCAPED, char => ESCAPES[char.charCodeAt(0)] ?? char)}"`
}

/** graphql-js `isPrintableAsBlockString`. */
function isPrintableAsBlockString(value: string): boolean {
  if (value === '') return true
  let isEmptyLine = true
  let hasIndent = false
  let hasCommonIndent = true
  let seenNonEmptyLine = false
  for (let i = 0; i < value.length; ++i) {
    switch (value.codePointAt(i)) {
      case 0x0000:
      case 0x0001:
      case 0x0002:
      case 0x0003:
      case 0x0004:
      case 0x0005:
      case 0x0006:
      case 0x0007:
      case 0x0008:
      case 0x000b:
      case 0x000c:
      case 0x000e:
      case 0x000f:
      case 0x000d:
        return false
      case 0x000a:
        if (isEmptyLine && !seenNonEmptyLine) return false
        seenNonEmptyLine = true
        isEmptyLine = true
        hasIndent = false
        break
      case 0x0009:
      case 0x0020:
        hasIndent ||= isEmptyLine
        break
      default:
        hasCommonIndent &&= hasIndent
        isEmptyLine = false
    }
  }
  if (isEmptyLine) return false
  if (hasCommonIndent && seenNonEmptyLine) return false
  return true
}

/** A GraphQL block string (`"""..."""`), laid out like graphql-js `printBlockString`. */
export function printBlockString(value: string): string {
  const escaped = value.replaceAll('"""', '\\"""')
  const lines = escaped.split(/\r\n|[\n\r]/g)
  const isSingleLine = lines.length === 1
  const forceLeadingNewLine =
    lines.length > 1 && lines.slice(1).every(line => line.length === 0 || isWhiteSpace(line.charCodeAt(0)))
  const hasTrailingTripleQuotes = escaped.endsWith('\\"""')
  const hasTrailingQuote = value.endsWith('"') && !hasTrailingTripleQuotes
  const hasTrailingSlash = value.endsWith('\\')
  const forceTrailingNewline = hasTrailingQuote || hasTrailingSlash
  const printAsMultipleLines =
    !isSingleLine || value.length > 70 || forceTrailingNewline || forceLeadingNewLine || hasTrailingTripleQuotes
  let result = ''
  const skipLeadingNewLine = isSingleLine && isWhiteSpace(value.charCodeAt(0))
  if ((printAsMultipleLines && !skipLeadingNewLine) || forceLeadingNewLine) result += '\n'
  result += escaped
  if (printAsMultipleLines || forceTrailingNewline) result += '\n'
  return `"""${result}"""`
}
