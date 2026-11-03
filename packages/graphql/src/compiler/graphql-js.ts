/**
 * The graphql-js modules schema-first compiles use (RFC 0007 §7): the language (parser, AST), the
 * type system (`validateSchema`, type predicates) and the utilities (`buildASTSchema`,
 * `concatAST`, `valueFromASTUntyped`). Loaded lazily, on the first schema-first compile, with
 * `createRequire`: code-first compiles never load graphql-js, and the execution engine
 * (`graphql/execution`, the `graphql` root entry) and dataloader are never loaded at build time
 * (tests/boundaries.test.ts). graphql is a required peer of `@znight/graphql`.
 */
import type * as Language from 'graphql/language'
import type * as Type from 'graphql/type'
import type * as Utilities from 'graphql/utilities'

import { createRequire } from 'node:module'

/** The build-time graphql-js modules. */
export interface GraphQLBuildModules {
  readonly language: typeof Language
  readonly type: typeof Type
  readonly utilities: typeof Utilities
}

/** The only graphql-js modules the compiler extension may load (checked by tests/boundaries.test.ts). */
export const GRAPHQL_BUILD_MODULES: readonly string[] = Object.freeze([
  'graphql/language',
  'graphql/type',
  'graphql/utilities',
])

let loaded: GraphQLBuildModules | undefined

/** The graphql-js modules, loaded on first use. */
export function graphqlModules(): GraphQLBuildModules {
  if (loaded === undefined) {
    const load = createRequire(import.meta.url)
    loaded = Object.freeze({
      language: load('graphql/language') as typeof Language,
      type: load('graphql/type') as typeof Type,
      utilities: load('graphql/utilities') as typeof Utilities,
    })
  }
  return loaded
}
