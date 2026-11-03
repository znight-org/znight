/**
 * `@znight/graphql/compiler`: the compiler extension of `@znight/graphql` (RFC 0005 §6).
 *
 * Loaded by `@znight/compiler` through the package manifest (`package.json#znight.compiler`):
 *
 * - `analyzeClass`: `@Resolver` classes become providers (and roots), their field methods and
 *   parameters are checked, guards and loaders bound with lazy edges, route decorators read;
 * - `validate`: the schema model, derived from the TypeScript types reachable from the root fields
 *   (§6.2–§6.6), with every ZNIGHT060–065 diagnostic and the access decisions (ZNIGHT023);
 * - `generate`: `metadata.extensions.graphql` (§7), and the SDL artifact when configured.
 *
 * The default export is the extension with its default options; `configure(options)` returns a
 * configured copy, declared in `znight.config.ts` (it replaces the discovered extension):
 *
 * ```ts
 * import graphql from '@znight/graphql/compiler'
 * export default { extensions: [graphql.configure({ sdl: 'schema.graphql' })] } satisfies ZnightOptions
 * ```
 *
 * This entry only `import type`s from `@znight/compiler`, imports the runtime-free
 * `@znight/http/compiler`, and never loads the GraphQL runtime, graphql-js nor dataloader: it
 * reaches the import-free modules `src/type-ref.ts`, `src/sdl.ts`, `src/names.ts`,
 * `src/metadata.ts` and `src/schema-hash.ts` (`node:crypto`) only (tests/boundaries.test.ts).
 */
import type { ApplicationGraph, CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { GraphQLData } from './data.ts'
import type { GraphQLModel } from './model.ts'
import type { GraphQLCompilerOptions, ResolvedGraphQLCompilerOptions } from './options.ts'

import { analyzeGraphQLClass } from './analyze.ts'
import { buildModel } from './builder.ts'
import { generateGraphQL } from './generate.ts'
import { EXTENSION_NAME, GraphQLIds } from './ids.ts'
import { DEFAULT_OPTIONS, resolveOptions } from './options.ts'
import { buildSchemaFirstModel } from './schema-first.ts'

export type { FieldData, FieldOperation, GraphQLData, ParamData, ResolverData } from './data.ts'
export type { GraphQLCompilerOptions, ResolvedGraphQLCompilerOptions } from './options.ts'

const FIELD: DecoratorSpec = { targets: ['method'], params: ['static'] }
const NO_ARGUMENT: DecoratorSpec = { targets: ['parameter'], params: [] }

/** Decorators owned by the extension, by canonical identity (static / value arguments, §4.6). */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [GraphQLIds.Resolver]: { targets: ['class'], params: ['static', 'static'] },
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

/** The `@znight/graphql` compiler extension, with its options and `configure()`. */
export interface GraphQLCompilerExtension extends CompilerExtension<GraphQLData> {
  /** The options of this copy (defaults filled in). */
  readonly options: ResolvedGraphQLCompilerOptions
  /** A copy of the extension with `options` merged onto the options of this one. */
  configure(options: GraphQLCompilerOptions): GraphQLCompilerExtension
}

function createExtension(options: ResolvedGraphQLCompilerOptions): GraphQLCompilerExtension {
  /**
   * Models by compile, built by `validate`, read by `generate`. The key is `graph.extensions`: the
   * validate and generate contexts of one compile get different graph objects sharing this array.
   */
  const models = new WeakMap<object, GraphQLModel | undefined>()
  const modelOf = (graph: ApplicationGraph): GraphQLModel | undefined => models.get(graph.extensions)
  return Object.freeze({
    apiVersion: 1,
    name: EXTENSION_NAME,
    decorators,
    options,
    analyzeClass: (cls, ctx) => analyzeGraphQLClass(cls, ctx, options),
    validate(ctx) {
      const schema = options.schema
      models.set(ctx.graph.extensions, schema === false ? buildModel(ctx, options) : buildSchemaFirstModel(ctx, schema))
    },
    generate(ctx) {
      return generateGraphQL(ctx, modelOf(ctx.graph), options)
    },
    configure(next: GraphQLCompilerOptions): GraphQLCompilerExtension {
      return createExtension(resolveOptions(options, next))
    },
  } satisfies GraphQLCompilerExtension)
}

/** The `@znight/graphql` compiler extension with its default options. */
export const graphqlCompilerExtension: GraphQLCompilerExtension = createExtension(DEFAULT_OPTIONS)

export default graphqlCompilerExtension
