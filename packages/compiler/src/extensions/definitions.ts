/**
 * `definitionsOf(callee)` of the extension contexts: the top-level `const` declarations of the
 * scanned files initialised with a call to a given function, such as
 * `export const Roles = createRouteDecorator('roles', { group: 'access', required: true })`.
 *
 * It lets an extension know every definition of the application, including the ones that are
 * applied nowhere (RFC 0001: a required route decision group whose decorators are not used yet).
 */
import type { Expression, VariableDeclarator } from 'oxc-parser'
import type { Project, ScopeRef, TypeInfo } from '../project/index.ts'
import type { DefinitionInfo } from './api.ts'

import { evaluateArguments } from '../analysis/arguments.ts'
import { isEntityName } from '../analysis/decorators.ts'
import { docAt } from '../analysis/jsdoc.ts'
import { compareStrings } from '../project/compare.ts'

/** Memoized `definitionsOf` for one compile. */
export class DefinitionIndex {
  readonly #project: Project
  readonly #byCallee = new Map<string, readonly DefinitionInfo[]>()

  constructor(project: Project) {
    this.#project = project
  }

  definitionsOf(callee: string): readonly DefinitionInfo[] {
    if (typeof callee !== 'string' || callee === '') {
      throw new TypeError('[znight] definitionsOf(callee): callee must be a canonical identity')
    }
    let found = this.#byCallee.get(callee)
    if (!found) {
      found = Object.freeze(this.#collect(callee))
      this.#byCallee.set(callee, found)
    }
    return found
  }

  #collect(callee: string): DefinitionInfo[] {
    const project = this.#project
    const found: DefinitionInfo[] = []
    for (const file of project.files()) {
      for (const declarations of file.facts.declarations.values()) {
        for (const declaration of declarations) {
          if (declaration.kind !== 'const' || declaration.destructured) {
            continue
          }
          const declarator = declaration.node as VariableDeclarator
          const call = declarator.init ? unwrap(declarator.init) : undefined
          if (call?.type !== 'CallExpression' || !isEntityName(call.callee)) {
            continue
          }
          const scope: ScopeRef = { file, namespace: declaration.namespace }
          if (project.resolveIdentifier(scope, call.callee, 'value').identity?.identity !== callee) {
            continue
          }
          const identity = project.identities.identityOfDeclaration(declaration)
          const route = project.importRoute(declaration)
          const typeArgs: TypeInfo[] = (call.typeArguments?.params ?? []).map(node => project.resolveType(scope, node))
          found.push({
            identity: identity.identity,
            name: declaration.name,
            displayName: identity.displayName,
            file: file.path,
            location: file.location(declaration.span),
            call: file.location(call),
            args: evaluateArguments(project, scope, call.arguments, VALUE_ARGUMENTS, declaration.name, IGNORE),
            typeArgs,
            doc: docAt(file, declarator.start),
            exported: route.ok && !route.route.typeOnly,
          })
        }
      }
    }
    return found.sort((a, b) => compareStrings(a.identity, b.identity))
  }
}

const VALUE_ARGUMENTS = { params: [], rest: 'value' } as const

const IGNORE = (): void => {}

function unwrap(expression: Expression): Expression {
  let current = expression
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression'
  ) {
    current = current.expression
  }
  return current
}
