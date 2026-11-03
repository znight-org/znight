/**
 * The SDL of a schema-first application (RFC 0007 §5.1): the `.graphql` files matching the
 * `schema` globs, parsed with `graphql/language`, checked structurally (duplicates, unknown types
 * and directives, extensions of missing types: located diagnostics with suggestions), then built
 * with `buildASTSchema` and validated with `validateSchema`, so that the build and the runtime agree
 * on what a valid schema is. Every problem is a ZNIGHT067 located in the `.graphql` file.
 */
import type { Diagnostic, Location, ValidateContext } from '@znight/compiler'
import type {
  ASTNode,
  DefinitionNode,
  DirectiveNode,
  DocumentNode,
  FieldDefinitionNode,
  GraphQLSchema,
  InputValueDefinitionNode,
  NamedTypeNode,
  NameNode,
  TypeNode,
} from 'graphql'
import type { GraphQLData } from './data.ts'

import { Codes, compareStrings } from './constants.ts'
import { graphqlModules } from './graphql-js.ts'
import { closest } from './suggest.ts'

/** Directives graphql-js knows (specified, or `@defer`/`@stream` of graphql 17). */
const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set([
  'deprecated',
  'specifiedBy',
  'oneOf',
  'include',
  'skip',
  'defer',
  'stream',
])

/** A directive as the SDL checks see it: where it applies, its arguments, repeatable or not. */
interface DirectiveSpec {
  readonly locations: ReadonlySet<string>
  /** Argument name → required (non-null without default). */
  readonly args: ReadonlyMap<string, boolean>
  readonly repeatable: boolean
}

/** The built-in directives allowed in an SDL (the others are executable directives). */
const SDL_DIRECTIVES: ReadonlyMap<string, DirectiveSpec> = new Map([
  [
    'deprecated',
    {
      locations: new Set(['FIELD_DEFINITION', 'ARGUMENT_DEFINITION', 'INPUT_FIELD_DEFINITION', 'ENUM_VALUE']),
      args: new Map([['reason', false]]),
      repeatable: false,
    },
  ],
  ['specifiedBy', { locations: new Set(['SCALAR']), args: new Map([['url', true]]), repeatable: false }],
  ['oneOf', { locations: new Set(['INPUT_OBJECT']), args: new Map(), repeatable: false }],
])

/** The directive location of each kind of type definition and extension. */
const TYPE_LOCATIONS: Readonly<Record<string, string>> = {
  type: 'OBJECT',
  interface: 'INTERFACE',
  union: 'UNION',
  enum: 'ENUM',
  input: 'INPUT_OBJECT',
  scalar: 'SCALAR',
}

/** Names of the types graphql-js always provides. */
const PROVIDED_TYPES: ReadonlySet<string> = new Set(['String', 'Int', 'Float', 'Boolean', 'ID'])

/** The parsed and validated SDL. */
export interface SdlSource {
  readonly schema: GraphQLSchema
  /** Names of the custom directives (left out of the served schema). */
  readonly customDirectives: ReadonlySet<string>
  /** The location of an AST node (its name when it has one); `undefined` for nodes without location. */
  locate(node: ASTNode | null | undefined): Location | undefined
}

/** Directive locations in messages. */
const LOCATION_NAMES: Readonly<Record<string, string>> = {
  SCHEMA: 'the schema',
  SCALAR: 'scalars',
  OBJECT: 'object types',
  FIELD_DEFINITION: 'fields',
  ARGUMENT_DEFINITION: 'arguments',
  INTERFACE: 'interfaces',
  UNION: 'unions',
  ENUM: 'enums',
  ENUM_VALUE: 'enum values',
  INPUT_OBJECT: 'input objects',
  INPUT_FIELD_DEFINITION: 'input fields',
}

const TYPE_KINDS: Readonly<Record<string, string>> = {
  ObjectTypeDefinition: 'type',
  ObjectTypeExtension: 'type',
  InterfaceTypeDefinition: 'interface',
  InterfaceTypeExtension: 'interface',
  UnionTypeDefinition: 'union',
  UnionTypeExtension: 'union',
  EnumTypeDefinition: 'enum',
  EnumTypeExtension: 'enum',
  InputObjectTypeDefinition: 'input',
  InputObjectTypeExtension: 'input',
  ScalarTypeDefinition: 'scalar',
  ScalarTypeExtension: 'scalar',
}

/** A type definition or extension. */
type TypeNodeLike = Extract<DefinitionNode, { readonly name: NameNode }> & { readonly kind: string }

/**
 * Reads, parses and validates the SDL; `undefined` after an error (reported). Warnings (custom
 * directives) do not stop the build.
 */
export function loadSdl(
  ctx: ValidateContext<GraphQLData>,
  patterns: readonly string[],
  report: (diagnostic: Diagnostic) => void,
): SdlSource | undefined {
  const files = ctx.inputFiles(patterns)
  if (files.length === 0) {
    report({
      code: Codes.InvalidSdl,
      severity: 'error',
      message: `No GraphQL schema file matches ${patterns.map(pattern => `'${pattern}'`).join(', ')} (schema-first)`,
      hints: [
        "The globs of graphql.configure({ schema }) are relative to the project root: 'src/**/*.graphql'",
        'Remove the schema option to derive the schema from the TypeScript types (code-first)',
      ],
    })
    return undefined
  }
  const { language, type, utilities } = graphqlModules()
  const locator = new Locator(new Map(files.map(file => [file.file, file.text])))
  let errors = 0
  const fail = (
    message: string,
    node: ASTNode | null | undefined,
    hints: readonly string[] = [],
    related?: ASTNode,
  ) => {
    errors++
    const location = locator.locate(node)
    const other = related === undefined ? undefined : locator.locate(related)
    report({
      code: Codes.InvalidSdl,
      severity: 'error',
      message,
      ...(location === undefined ? {} : { location }),
      ...(hints.length === 0 ? {} : { hints }),
      ...(other === undefined ? {} : { related: [{ message: 'first declared here', location: other }] }),
    })
  }

  const documents: DocumentNode[] = []
  for (const file of files) {
    // a file with comments only (a placeholder) defines nothing: graphql-js would reject it
    if (/^(?:\s|,|#[^\n\r]*)*$/.test(file.text.replace(/^\uFEFF/, ''))) continue
    try {
      documents.push(language.parse(new language.Source(file.text, file.file)))
    } catch (error) {
      const position = (error as { positions?: readonly number[] }).positions?.[0]
      errors++
      const location = position === undefined ? undefined : locator.at(file.file, position, position + 1)
      report({
        code: Codes.InvalidSdl,
        severity: 'error',
        message: `${(error as Error).message} (${file.relativeFile})`,
        ...(location === undefined ? {} : { location }),
      })
    }
  }
  if (errors > 0) return undefined
  if (documents.length === 0) {
    report({
      code: Codes.InvalidSdl,
      severity: 'error',
      message: `The GraphQL schema files matching ${patterns.map(pattern => `'${pattern}'`).join(', ')} define nothing (schema-first)`,
      hints: ['Declare the types of the schema, starting with type Query { ... }'],
    })
    return undefined
  }
  const document = utilities.concatAST(documents)
  const customDirectives = checkStructure(document, fail, (message, node) => {
    const location = locator.locate(node)
    report({
      code: Codes.InvalidSdl,
      severity: 'warning',
      message,
      ...(location === undefined ? {} : { location }),
      hints: [
        'Znight serves the schema without custom directives (and so does the SDL artifact): remove it, or keep it for other tools',
      ],
    })
  })
  if (errors > 0) return undefined

  let schema: GraphQLSchema
  try {
    schema = utilities.buildASTSchema(document, { assumeValidSDL: true })
  } catch (error) {
    fail(`Invalid schema: ${(error as Error).message}`, (error as { nodes?: readonly ASTNode[] }).nodes?.[0])
    return undefined
  }
  for (const problem of type.validateSchema(schema)) {
    const [node, ...others] = (problem.nodes ?? []).filter(candidate => candidate.loc !== undefined)
    errors++
    const location = locator.locate(node)
    const related = others.flatMap(other => {
      const at = locator.locate(other)
      return at === undefined ? [] : [{ message: 'see also', location: at }]
    })
    report({
      code: Codes.InvalidSdl,
      severity: 'error',
      message: `Invalid schema: ${problem.message}`,
      ...(location === undefined ? {} : { location }),
      ...(related.length === 0 ? {} : { related }),
      // the one schema-wide error without node: no query type
      ...(node === undefined && schema.getQueryType() == null
        ? { hints: ['Declare the query root type in one of the files: type Query { ... }'] }
        : {}),
    })
  }
  if (errors > 0) return undefined
  return { schema, customDirectives, locate: node => locator.locate(node) }
}

/**
 * The checks graphql-js leaves to its SDL validation (not exported): unique type, field, value and
 * argument names, known types and directives, extensions of existing types of the same kind, one
 * schema definition. Returns the names of the custom directives (each reported as a warning).
 */
function checkStructure(
  document: DocumentNode,
  fail: (message: string, node: ASTNode, hints?: readonly string[], related?: ASTNode) => void,
  warn: (message: string, node: ASTNode) => void,
): ReadonlySet<string> {
  const definitions = new Map<string, TypeNodeLike>()
  const directives = new Map<string, ASTNode>()
  const specs = new Map<string, DirectiveSpec>(SDL_DIRECTIVES)
  let schemaDefinition: ASTNode | undefined
  for (const definition of document.definitions) {
    if (definition.kind === 'SchemaDefinition') {
      if (schemaDefinition === undefined) schemaDefinition = definition
      else
        fail(
          'The schema is defined twice (schema { ... })',
          definition,
          ['Keep one schema definition'],
          schemaDefinition,
        )
      continue
    }
    if (definition.kind === 'DirectiveDefinition') {
      const name = definition.name.value
      const previous = directives.get(name)
      if (previous !== undefined) fail(`The directive @${name} is defined twice`, definition.name, [], previous)
      else if (KNOWN_DIRECTIVES.has(name))
        fail(`@${name} is a built-in directive: it cannot be redefined`, definition.name)
      else {
        directives.set(name, definition.name)
        specs.set(name, {
          locations: new Set(definition.locations.map(location => location.value)),
          args: new Map(
            (definition.arguments ?? []).map(arg => [
              arg.name.value,
              arg.type.kind === 'NonNullType' && arg.defaultValue === undefined,
            ]),
          ),
          repeatable: definition.repeatable,
        })
        warn(`The custom directive @${name} is ignored`, definition.name)
      }
      continue
    }
    const kind = TYPE_KINDS[definition.kind]
    if (kind === undefined || definition.kind.endsWith('Extension')) continue
    const node = definition as TypeNodeLike
    const previous = definitions.get(node.name.value)
    if (previous !== undefined) {
      fail(
        `The type ${node.name.value} is defined twice`,
        node.name,
        [
          kind === 'scalar'
            ? 'Keep one of them, or rename one'
            : `Extend it instead (${declaration(`extend ${kind}`, kind, node.name.value)}), or rename one of them`,
        ],
        previous.name,
      )
      continue
    }
    definitions.set(node.name.value, node)
  }
  const typeNames = [...definitions.keys(), ...PROVIDED_TYPES].sort(compareStrings)
  const known = (name: NamedTypeNode, where: string): void => {
    const value = name.name.value
    if (definitions.has(value) || PROVIDED_TYPES.has(value)) return
    const suggestion = closest(value, typeNames)
    fail(
      `Unknown type ${value} (${where})`,
      name,
      suggestion === undefined ? ['Define it, or fix the name'] : [`Did you mean ${suggestion}?`],
    )
  }
  /** The directives applied at `location`: known, allowed there, once unless repeatable, valid arguments. */
  const directivesOf = (nodes: readonly DirectiveNode[] | undefined, location: string): void => {
    const seen = new Map<string, ASTNode>()
    for (const directive of nodes ?? []) {
      const name = directive.name.value
      const spec = specs.get(name)
      if (spec === undefined) {
        fail(
          KNOWN_DIRECTIVES.has(name)
            ? `@${name} is an executable directive: it cannot be used in a schema`
            : `Unknown directive @${name}`,
          directive.name,
          KNOWN_DIRECTIVES.has(name) ? ['Remove it'] : [`Define it (directive @${name} on ${location}), or remove it`],
        )
        continue
      }
      if (!spec.locations.has(location)) {
        fail(`@${name} cannot be used on ${LOCATION_NAMES[location] ?? location}`, directive.name, [
          `@${name} applies to ${[...spec.locations].map(where => LOCATION_NAMES[where] ?? where).join(', ')}`,
        ])
      }
      const previous = seen.get(name)
      if (previous !== undefined && !spec.repeatable) {
        fail(`@${name} is applied twice`, directive.name, ['Apply it once'], previous)
      }
      seen.set(name, directive.name)
      const given = new Set<string>()
      for (const arg of directive.arguments ?? []) {
        given.add(arg.name.value)
        if (!spec.args.has(arg.name.value)) {
          const names = [...spec.args.keys()]
          fail(`@${name} has no argument '${arg.name.value}'`, arg.name, [
            names.length === 0 ? `@${name} takes no argument` : `Its arguments: ${names.join(', ')}`,
          ])
        }
      }
      for (const [arg, required] of spec.args) {
        if (required && !given.has(arg))
          fail(`@${name} needs its argument '${arg}'`, directive.name, [`@${name}(${arg}: ...)`])
      }
    }
  }
  /** Members of a type: its definition and extensions, by name (fields, values, input fields). */
  const members = new Map<string, Map<string, ASTNode>>()
  const member = (typeName: string, kind: string, name: NameNode): void => {
    let seen = members.get(typeName)
    if (seen === undefined) {
      seen = new Map()
      members.set(typeName, seen)
    }
    const previous = seen.get(name.value)
    if (previous !== undefined) {
      fail(`${typeName}.${name.value} is declared twice`, name, [`Keep one ${kind} named ${name.value}`], previous)
      return
    }
    seen.set(name.value, name)
  }
  const inputValues = (owner: string, values: readonly InputValueDefinitionNode[] | undefined): void => {
    const seen = new Map<string, ASTNode>()
    for (const value of values ?? []) {
      const previous = seen.get(value.name.value)
      if (previous !== undefined) {
        fail(`Argument ${owner}(${value.name.value}:) is declared twice`, value.name, [], previous)
      }
      seen.set(value.name.value, value.name)
      known(namedType(value.type), `${owner}(${value.name.value}:)`)
      directivesOf(value.directives, 'ARGUMENT_DEFINITION')
    }
  }
  const fields = (owner: string, list: readonly FieldDefinitionNode[] | undefined): void => {
    for (const field of list ?? []) {
      member(owner, 'field', field.name)
      known(namedType(field.type), `${owner}.${field.name.value}`)
      inputValues(`${owner}.${field.name.value}`, field.arguments)
      directivesOf(field.directives, 'FIELD_DEFINITION')
    }
  }
  const operations = new Map<string, ASTNode>()
  for (const definition of document.definitions) {
    if (definition.kind === 'SchemaDefinition' || definition.kind === 'SchemaExtension') {
      for (const operation of definition.operationTypes ?? []) {
        known(operation.type, `schema ${operation.operation}`)
        const previous = operations.get(operation.operation)
        if (previous !== undefined) {
          fail(`The ${operation.operation} root type is declared twice`, operation, ['Keep one'], previous)
        }
        operations.set(operation.operation, operation)
      }
      directivesOf(definition.directives, 'SCHEMA')
      continue
    }
    if (definition.kind === 'DirectiveDefinition') {
      inputValues(`@${definition.name.value}`, definition.arguments)
      continue
    }
    const kind = TYPE_KINDS[definition.kind]
    if (kind === undefined) continue
    const node = definition as TypeNodeLike & {
      readonly fields?: readonly (FieldDefinitionNode | InputValueDefinitionNode)[]
      readonly interfaces?: readonly NamedTypeNode[]
      readonly types?: readonly NamedTypeNode[]
      readonly values?: readonly { readonly name: NameNode; readonly directives?: readonly DirectiveNode[] }[]
      readonly directives?: readonly DirectiveNode[]
    }
    const name = node.name.value
    if (definition.kind.endsWith('Extension')) {
      const base = definitions.get(name)
      if (base === undefined) {
        if (!PROVIDED_TYPES.has(name)) {
          const suggestion = closest(name, typeNames)
          fail(`Cannot extend ${kind} ${name}: it is not defined`, node.name, [
            suggestion === undefined ? `Define it: ${declaration(kind, kind, name)}` : `Did you mean ${suggestion}?`,
          ])
        }
        continue
      }
      if (TYPE_KINDS[base.kind] !== kind) {
        const actual = TYPE_KINDS[base.kind] as string
        fail(
          `Cannot extend ${name} as ${article(kind)} ${kind}: it is ${article(actual)} ${actual}`,
          node.name,
          [`Use ${declaration(`extend ${actual}`, actual, name)}`],
          base.name,
        )
        continue
      }
    }
    directivesOf(node.directives, TYPE_LOCATIONS[kind] as string)
    for (const implemented of node.interfaces ?? []) known(implemented, `${name} implements`)
    for (const target of node.types ?? []) known(target, `union ${name}`)
    for (const value of node.values ?? []) {
      member(name, 'value', value.name)
      directivesOf(value.directives, 'ENUM_VALUE')
    }
    if (kind === 'input') {
      for (const field of (node.fields ?? []) as readonly InputValueDefinitionNode[]) {
        member(name, 'field', field.name)
        known(namedType(field.type), `${name}.${field.name.value}`)
        directivesOf(field.directives, 'INPUT_FIELD_DEFINITION')
      }
    } else {
      fields(name, node.fields as readonly FieldDefinitionNode[] | undefined)
    }
  }
  return new Set(directives.keys())
}

/** `extend type Book { ... }`, `union Hit = ...`, `scalar Url`: valid SDL for a hint. */
function declaration(keyword: string, kind: string, name: string): string {
  if (kind === 'scalar') return `${keyword} ${name}`
  if (kind === 'union') return `${keyword} ${name} = ...`
  return `${keyword} ${name} { ... }`
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}

function namedType(type: TypeNode): NamedTypeNode {
  let current = type
  while (current.kind !== 'NamedType') current = current.type
  return current
}

/** Source locations of AST nodes (graphql-js `Source.name` is the absolute path of the file). */
class Locator {
  readonly #texts: ReadonlyMap<string, string>
  readonly #lines = new Map<string, number[]>()

  constructor(texts: ReadonlyMap<string, string>) {
    this.#texts = texts
  }

  locate(node: ASTNode | null | undefined): Location | undefined {
    if (node === null || node === undefined) return undefined
    const named = 'name' in node && node.name !== undefined && typeof node.name === 'object' ? node.name : node
    const loc = (named as ASTNode).loc ?? node.loc
    if (loc === undefined) return undefined
    return this.at(loc.source.name, loc.start, loc.end)
  }

  at(file: string, start: number, end: number): Location | undefined {
    const text = this.#texts.get(file)
    if (text === undefined) return undefined
    const lines = this.#lineStarts(file, text)
    const first = position(lines, start)
    const last = position(lines, Math.min(end, text.length))
    return { file, line: first.line, column: first.column, endLine: last.line, endColumn: last.column, start, end }
  }

  #lineStarts(file: string, text: string): number[] {
    let lines = this.#lines.get(file)
    if (lines === undefined) {
      lines = [0]
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index)
        if (code === 0x0a) lines.push(index + 1)
        else if (code === 0x0d) {
          if (text.charCodeAt(index + 1) === 0x0a) index++
          lines.push(index + 1)
        }
      }
      this.#lines.set(file, lines)
    }
    return lines
  }
}

/** 1-based line and column (UTF-16 code units) of an offset. */
function position(lines: readonly number[], offset: number): { line: number; column: number } {
  let low = 0
  let high = lines.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((lines[middle] as number) <= offset) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: offset - (lines[low] as number) + 1 }
}
