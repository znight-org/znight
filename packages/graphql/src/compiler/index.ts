/**
 * `@znight/graphql/compiler`: the compiler extension of `@znight/graphql` (RFC 0005 §6).
 *
 * Loaded by `@znight/compiler` through the package manifest (`package.json#znight.compiler`). It
 * owns the GraphQL decorators (their targets and argument kinds are declared here); resolver
 * analysis, the schema model, the diagnostics (ZNIGHT060–066) and the generation of
 * `metadata.extensions.graphql` plug into this object.
 *
 * This entry only `import type`s from `@znight/compiler`, may import the runtime-free
 * `@znight/http/compiler`, and never loads the GraphQL runtime, graphql-js nor dataloader: it reaches
 * the import-free modules `src/type-ref.ts`, `src/sdl.ts`, `src/names.ts` and `src/schema-hash.ts`
 * (`node:crypto`) only (tests/boundaries.test.ts).
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'

import { EXTENSION_NAME, GraphQLIds } from './ids.ts'

const FIELD: DecoratorSpec = { targets: ['method'], params: ['static'] }
const NO_ARGUMENT: DecoratorSpec = { targets: ['parameter'], params: [] }

/** Decorators owned by the extension, by canonical identity (static / value arguments, §4.6). */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [GraphQLIds.Resolver]: { targets: ['class'], params: ['static'] },
  [GraphQLIds.Query]: FIELD,
  [GraphQLIds.Mutation]: FIELD,
  [GraphQLIds.Subscription]: FIELD,
  [GraphQLIds.ResolveField]: FIELD,
  [GraphQLIds.Args]: { targets: ['parameter'], params: ['value', 'value'] },
  [GraphQLIds.Parent]: NO_ARGUMENT,
  [GraphQLIds.Ctx]: NO_ARGUMENT,
  [GraphQLIds.Info]: NO_ARGUMENT,
  [GraphQLIds.Loader]: NO_ARGUMENT,
  [GraphQLIds.UseGuard]: { targets: ['class', 'method'], params: [], rest: 'value' },
} satisfies Record<string, DecoratorSpec>)

/** The `@znight/graphql` compiler extension. */
export const graphqlCompilerExtension: CompilerExtension = Object.freeze({
  apiVersion: 1,
  name: EXTENSION_NAME,
  decorators,
})

export default graphqlCompilerExtension
