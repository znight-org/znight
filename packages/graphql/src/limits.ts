/**
 * Document limits (RFC 0005 §8.9): depth, aliases and directives, checked in one walk of the parsed
 * document **before** the specified validation rules, so that an abusive document is rejected
 * before rules whose cost grows with it (`OverlappingFieldsCanBeMerged`) run. Aliases are counted as
 * written, and, when the document spreads fragments, as each operation executes them (a fragment
 * spread several times counts each time). `maxTokens` is enforced by `parse()` itself.
 */
import type { DirectiveNode, DocumentNode, FragmentDefinitionNode, SelectionSetNode, ValidationRule } from 'graphql'

import { GraphQLError, Kind } from 'graphql'

import { GraphQLErrorCode } from './errors.ts'

/** Resolved limits: `undefined` disables one. */
export interface DocumentLimits {
  readonly maxDepth: number | undefined
  readonly maxAliases: number | undefined
  readonly maxDirectives: number | undefined
}

/** The limit errors of `document` (`QUERY_TOO_COMPLEX`), `undefined` when it is within its limits. */
export function checkLimits(document: DocumentNode, limits: DocumentLimits): GraphQLError[] | undefined {
  const { maxDepth, maxAliases, maxDirectives } = limits
  if (maxDepth === undefined && maxAliases === undefined && maxDirectives === undefined) return undefined
  const counter = { aliases: 0, directives: 0, spreads: 0 }
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition)
  }
  let errors: GraphQLError[] | undefined
  const fail = (message: string): void => {
    errors ??= []
    errors.push(new GraphQLError(message, { extensions: { code: GraphQLErrorCode.QueryTooComplex } }))
  }
  // counts every selection once, where it is written (fragment spreads expanded below for aliases)
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION || definition.kind === Kind.FRAGMENT_DEFINITION) {
      countDirectives(definition.directives, counter)
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        for (const variable of definition.variableDefinitions ?? []) countDirectives(variable.directives, counter)
      }
      count(definition.selectionSet, counter)
    }
  }
  if (maxAliases !== undefined) {
    if (counter.aliases > maxAliases) {
      fail(`The document has ${counter.aliases} aliases, more than the limit of ${maxAliases}.`)
    } else if (counter.spreads > 0) {
      // a fragment spread several times executes its aliases each time: counted as executed
      const memo = new Map<string, number>()
      for (const definition of document.definitions) {
        if (definition.kind !== Kind.OPERATION_DEFINITION) continue
        const executed = aliasesOf(definition.selectionSet, fragments, memo, new Set(), maxAliases + 1)
        if (executed > maxAliases) {
          const name = definition.name === undefined ? 'The operation' : `The operation ${definition.name.value}`
          fail(`${name} has more than ${maxAliases} aliases once its fragments are expanded.`)
          break
        }
      }
    }
  }
  if (maxDirectives !== undefined && counter.directives > maxDirectives) {
    fail(`The document has ${counter.directives} directives, more than the limit of ${maxDirectives}.`)
  }
  if (maxDepth !== undefined) {
    const depths = new Map<string, number>()
    for (const definition of document.definitions) {
      if (definition.kind !== Kind.OPERATION_DEFINITION) continue
      const depth = depthOf(definition.selectionSet, fragments, depths, new Set())
      if (depth > maxDepth) {
        const name = definition.name === undefined ? 'The operation' : `The operation ${definition.name.value}`
        fail(`${name} is ${depth} levels deep, more than the limit of ${maxDepth}.`)
      }
    }
  }
  return errors
}

/**
 * The limits as a graphql-js validation rule (`GraphQLEngine.rules`, RFC 0009), for GraphQL servers
 * that parse and validate documents themselves: the same check as {@link checkLimits}, run once on
 * the document node. `undefined` when every limit is disabled.
 */
export function limitsRule(limits: DocumentLimits): ValidationRule | undefined {
  if (limits.maxDepth === undefined && limits.maxAliases === undefined && limits.maxDirectives === undefined) {
    return undefined
  }
  const rule: ValidationRule = context => ({
    Document(node) {
      const errors = checkLimits(node, limits)
      if (errors !== undefined) for (const error of errors) context.reportError(error)
      // the whole document is checked at once: nothing to visit below it
      return false
    },
  })
  Object.defineProperty(rule, 'name', { value: 'ZnightDocumentLimitsRule' })
  return rule
}

interface Counter {
  aliases: number
  directives: number
  spreads: number
}

function countDirectives(directives: readonly DirectiveNode[] | undefined, counter: Counter): void {
  if (directives !== undefined) counter.directives += directives.length
}

function count(set: SelectionSetNode, counter: Counter): void {
  for (const selection of set.selections) {
    countDirectives(selection.directives, counter)
    if (selection.kind === Kind.FIELD) {
      if (selection.alias !== undefined) counter.aliases++
      if (selection.selectionSet !== undefined) count(selection.selectionSet, counter)
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      count(selection.selectionSet, counter)
    } else {
      counter.spreads++
    }
  }
}

/**
 * Aliases a selection set executes, fragment spreads expanded (`a: f { ...F } b: f { ...F }` counts
 * the aliases of `F` twice). Fragment counts are memoised, so the walk stays linear in the document;
 * counts saturate at `cap` (one more than the limit) and a fragment cycle counts 0 (validation
 * rejects it).
 */
function aliasesOf(
  set: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  memo: Map<string, number>,
  visiting: Set<string>,
  cap: number,
): number {
  let total = 0
  for (const selection of set.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.alias !== undefined) total++
      if (selection.selectionSet !== undefined)
        total += aliasesOf(selection.selectionSet, fragments, memo, visiting, cap)
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      total += aliasesOf(selection.selectionSet, fragments, memo, visiting, cap)
    } else {
      const name = selection.name.value
      let known = memo.get(name)
      if (known === undefined) {
        const fragment = fragments.get(name)
        if (fragment === undefined || visiting.has(name)) continue
        visiting.add(name)
        known = aliasesOf(fragment.selectionSet, fragments, memo, visiting, cap)
        visiting.delete(name)
        memo.set(name, known)
      }
      total += known
    }
    if (total >= cap) return cap
  }
  return total
}

/**
 * Field nesting of a selection set (`{ a { b } }` is 2). Introspection fields (`__schema`,
 * `__type`) do not count: `MaxIntrospectionDepthRule` bounds them. Fragment depths are memoised; a
 * fragment cycle counts 0 (validation rejects it).
 */
function depthOf(
  set: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  depths: Map<string, number>,
  visiting: Set<string>,
): number {
  let max = 0
  for (const selection of set.selections) {
    let depth = 0
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith('__')) continue
      depth =
        selection.selectionSet === undefined ? 1 : 1 + depthOf(selection.selectionSet, fragments, depths, visiting)
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      depth = depthOf(selection.selectionSet, fragments, depths, visiting)
    } else {
      const name = selection.name.value
      const known = depths.get(name)
      if (known === undefined) {
        const fragment = fragments.get(name)
        if (fragment === undefined || visiting.has(name)) continue
        visiting.add(name)
        depth = depthOf(fragment.selectionSet, fragments, depths, visiting)
        visiting.delete(name)
        depths.set(name, depth)
      } else depth = known
    }
    if (depth > max) max = depth
  }
  return max
}
