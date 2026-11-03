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
    const node = problem.nodes?.find(candidate => candidate.loc !== undefined)
    fail(`Invalid schema: ${problem.message}`, node)
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
        [`Extend it instead (extend ${kind} ${node.name.value} { ... }), or rename one of them`],
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
  const directivesOf = (nodes: readonly DirectiveNode[] | undefined): void => {
    for (const directive of nodes ?? []) {
      const name = directive.name.value
      if (KNOWN_DIRECTIVES.has(name) || directives.has(name)) continue
      fail(`Unknown directive @${name}`, directive.name, [
        `Define it (directive @${name} on FIELD_DEFINITION), or remove it`,
      ])
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
      directivesOf(value.directives)
    }
  }
  const fields = (owner: string, list: readonly FieldDefinitionNode[] | undefined): void => {
    for (const field of list ?? []) {
      member(owner, 'field', field.name)
      known(namedType(field.type), `${owner}.${field.name.value}`)
      inputValues(`${owner}.${field.name.value}`, field.arguments)
      directivesOf(field.directives)
    }
  }
  for (const definition of document.definitions) {
    if (definition.kind === 'SchemaDefinition' || definition.kind === 'SchemaExtension') {
      for (const operation of definition.operationTypes ?? []) known(operation.type, `schema ${operation.operation}`)
      directivesOf(definition.directives)
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
            suggestion === undefined ? `Define it: ${kind} ${name} { ... }` : `Did you mean ${suggestion}?`,
          ])
        }
        continue
      }
      if (TYPE_KINDS[base.kind] !== kind) {
        fail(`Cannot extend ${name} as a ${kind}: it is a ${TYPE_KINDS[base.kind]}`, node.name, [], base.name)
        continue
      }
    }
    directivesOf(node.directives)
    for (const implemented of node.interfaces ?? []) known(implemented, `${name} implements`)
    for (const target of node.types ?? []) known(target, `union ${name}`)
    for (const value of node.values ?? []) {
      member(name, 'value', value.name)
      directivesOf(value.directives)
    }
    if (kind === 'input') {
      for (const field of (node.fields ?? []) as readonly InputValueDefinitionNode[]) {
        member(name, 'field', field.name)
        known(namedType(field.type), `${name}.${field.name.value}`)
        directivesOf(field.directives)
      }
    } else {
      fields(name, node.fields as readonly FieldDefinitionNode[] | undefined)
    }
  }
  return new Set(directives.keys())
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
