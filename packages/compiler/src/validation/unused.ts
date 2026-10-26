/**
 * ZNIGHT019 (with `reportUnused`) and the reachability used by `prune`.
 *
 * **Roots** are the providers the application uses without being injected:
 * 1. providers registered by compiler extensions (controllers, consumers, config classes...);
 * 2. providers with a lifecycle hook (`onStart`, `onReady`, `onStop`): they do work on their own;
 * 3. providers referenced as a value in the scanned application code, outside type positions,
 *    imports/exports and decorators — e.g. `app.container.get(UserService)` in `main.ts` or an
 *    `overrides` entry (a reference to an alias key such as an abstract class marks its provider).
 *
 * Every provider reachable from a root through any edge (parameters, multi, optional, `Lazy`,
 * interceptors, factories, extension edges) is used; the others are unused.
 */
import type { Token } from '@znight/core'
import type { Expression, Node } from 'oxc-parser'
import type { Reporter } from '../analysis/arguments.ts'
import type { AliasNode, GraphEdge, ProviderNode, Reachability } from '../graph/types.ts'
import type { Project, SourceFile } from '../project/index.ts'

import { ErrorCode } from '@znight/core'

import { walk } from '../analysis/ast.ts'
import { compareStrings } from '../project/compare.ts'

/** TypeScript nodes containing values (every other `TS*` node is a type and is skipped). */
const VALUE_TS_NODES = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'TSParameterProperty',
  'TSEnumDeclaration',
  'TSEnumBody',
  'TSEnumMember',
  'TSModuleDeclaration',
  'TSModuleBlock',
  'TSExportAssignment',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSAbstractAccessorProperty',
  'TSEmptyBodyFunctionExpression',
])

const SKIPPED_NODES = new Set(['ImportDeclaration', 'ExportAllDeclaration', 'Decorator'])

/** Computes roots and unreachable providers. */
export function computeReachability(
  project: Project,
  providers: readonly ProviderNode[],
  edges: readonly GraphEdge[],
  aliases: readonly AliasNode[],
): Reachability {
  const tokens = new Set(providers.map(provider => provider.token))
  const roots = new Set<Token>()
  for (const provider of providers) {
    if (provider.registeredBy !== 'core' && provider.registeredBy !== 'auto') {
      roots.add(provider.token)
    }
    if (
      provider.lifecycle.some(
        hook => !hook.static && (hook.hook === 'onStart' || hook.hook === 'onReady' || hook.hook === 'onStop'),
      )
    ) {
      roots.add(provider.token)
    }
  }
  const aliasTargets = new Map(aliases.map(alias => [alias.key, alias.token]))
  for (const token of valueReferences(project, tokens, aliasTargets)) {
    roots.add(token)
  }

  const outgoing = new Map<Token, Token[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.from)
    if (list) {
      list.push(edge.to)
    } else {
      outgoing.set(edge.from, [edge.to])
    }
  }
  const reachable = new Set<Token>(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.pop() as Token
    for (const target of outgoing.get(current) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target)
        queue.push(target)
      }
    }
  }
  return {
    roots: [...roots].sort(compareStrings),
    unreachable: providers.map(provider => provider.token).filter(token => !reachable.has(token)),
  }
}

/** ZNIGHT019 warnings for unreachable providers. */
export function reportUnused(providers: readonly ProviderNode[], reachability: Reachability, report: Reporter): void {
  const unreachable = new Set(reachability.unreachable)
  for (const provider of providers) {
    if (!unreachable.has(provider.token)) {
      continue
    }
    report({
      code: ErrorCode.UnusedProvider,
      severity: 'warning',
      message: `${provider.displayName} is never used: no root depends on it`,
      location: provider.location,
      hints: [
        'Roots are extension providers (controllers, consumers...), providers with lifecycle hooks and providers referenced in code (container.get(X))',
        'Remove the provider, or enable "prune" to drop unused providers from the build',
      ],
    })
  }
}

/** Provider tokens referenced as values in the scanned application files. */
function valueReferences(
  project: Project,
  tokens: ReadonlySet<Token>,
  aliases: ReadonlyMap<string, Token>,
): Set<Token> {
  const found = new Set<Token>()
  for (const file of project.files()) {
    if (project.ownerOf(file.path).kind !== 'application') {
      continue
    }
    const candidates = new Set<string>(file.facts.imports.keys())
    for (const [name, declarations] of file.facts.declarations) {
      if (declarations.some(declaration => declaration.kind === 'class')) {
        candidates.add(name)
      }
    }
    if (candidates.size === 0) {
      continue
    }
    const cache = new Map<string, Token | null>()
    scanValues(file, candidates, (key, node) => {
      let token = cache.get(key)
      if (token === undefined) {
        const identity = project.resolveIdentifier(file, node as Expression, 'value').identity?.identity
        token = identity === undefined ? null : providerOf(identity, tokens, aliases)
        cache.set(key, token)
      }
      if (token !== null) {
        found.add(token)
      }
    })
  }
  return found
}

function providerOf(identity: string, tokens: ReadonlySet<Token>, aliases: ReadonlyMap<string, Token>): Token | null {
  if (tokens.has(identity)) {
    return identity
  }
  return aliases.get(identity) ?? null
}

/** Calls `visit` for identifiers (and namespace member accesses) in value positions. */
function scanValues(file: SourceFile, candidates: ReadonlySet<string>, visit: (key: string, node: Node) => void): void {
  const ignored = new WeakSet<object>()
  walk(file.program, node => {
    if (ignored.has(node) || SKIPPED_NODES.has(node.type)) {
      return false
    }
    if (node.type.startsWith('TS') && !VALUE_TS_NODES.has(node.type)) {
      return false
    }
    switch (node.type) {
      case 'ExportNamedDeclaration':
        for (const specifier of node.specifiers) {
          ignored.add(specifier)
        }
        return true
      case 'ExportDefaultDeclaration':
        if (node.declaration.type === 'Identifier') {
          ignored.add(node.declaration)
        }
        return true
      case 'ClassDeclaration':
      case 'ClassExpression':
        // `extends Base` is inheritance, not a use of the Base provider
        if (node.superClass) {
          ignored.add(node.superClass)
        }
        if (node.id) {
          ignored.add(node.id)
        }
        return true
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (node.id) {
          ignored.add(node.id)
        }
        return true
      case 'VariableDeclarator':
        ignored.add(node.id)
        return true
      case 'MemberExpression':
        if (!node.computed) {
          ignored.add(node.property)
          const object = node.object
          if (
            object.type === 'Identifier' &&
            candidates.has(object.name) &&
            file.facts.imports.get(object.name)?.kind === 'namespace'
          ) {
            ignored.add(object)
            visit(`${object.name}.${file.textOf(node.property)}`, node)
          }
        }
        return true
      case 'MethodDefinition':
      case 'PropertyDefinition':
      case 'AccessorProperty':
      case 'Property':
        if (!node.computed) {
          ignored.add(node.key)
        }
        return true
      case 'LabeledStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
        if (node.label) {
          ignored.add(node.label)
        }
        return true
      case 'Identifier':
        if (candidates.has(node.name)) {
          visit(node.name, node)
        }
        return false
      default:
        return true
    }
  })
}
