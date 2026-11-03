/**
 * `@znight/graphql`: code-first GraphQL whose schema is derived from TypeScript types at build time
 * (RFC 0005). Resolvers are providers marked with `@Resolver`, `@Query`, `@Mutation`,
 * `@Subscription` and `@ResolveField`; the compiler extension (`@znight/graphql/compiler`) generates
 * `metadata.extensions.graphql`, served by `GraphQLPlugin` on graphql-js 17.
 */

export type { StandardSchemaV1 } from '@znight/http'
export type { Float, ID, Int, JSONValue, ResolverOptions } from './decorators.ts'
export type { GraphQLRequest, GraphQLResultStream } from './execution.ts'
export type {
  AnyPubSub,
  GraphQLErrorMapperRef,
  GraphQLGuardRef,
  GraphQLHttpOptions,
  GraphQLLimits,
  GraphQLPluginOptions,
  GraphQLResultMapperRef,
  GraphQLSubscriptionOptions,
} from './options.ts'
export type {
  BatchLoad,
  BatchLoadClass,
  BatchLoader,
  GraphQLArgs,
  GraphQLContext,
  GraphQLErrorMapper,
  GraphQLErrorMapperClass,
  GraphQLGuard,
  GraphQLGuardClass,
  GraphQLOperationKind,
  GraphQLResultMapper,
  GraphQLResultMapperClass,
  GraphQLResultTypes,
  GraphQLTransport,
  LoaderKey,
  LoaderOptions,
  LoaderValue,
  ResolverContext,
  ScalarDefinition,
} from './types.ts'

/** `Loader` is both the `@Loader()` parameter decorator and the `Loader<L>` parameter type. */
export {
  Args,
  Ctx,
  Info,
  Loader,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Subscription,
  scalar,
  UseGuard,
} from './decorators.ts'
export {
  GraphQLErrorCode,
  type GraphQLErrorCodeValue,
  GraphQLException,
  type GraphQLExceptionOptions,
} from './errors.ts'
export { type OrderByKeysOptions, orderByKeys } from './loaders.ts'
export { MemoryPubSub, type MemoryPubSubOptions } from './memory-pubsub.ts'
export {
  GRAPHQL_METADATA_VERSION,
  type GraphQLArgumentDefinition,
  type GraphQLBuiltinScalarDefinition,
  type GraphQLCustomScalarDefinition,
  type GraphQLDiscriminator,
  type GraphQLEnumTypeDefinition,
  type GraphQLEnumValueDefinition,
  type GraphQLFieldDefinition,
  type GraphQLInputFieldDefinition,
  type GraphQLInputTypeDefinition,
  type GraphQLInterfaceTypeDefinition,
  type GraphQLMetadata,
  type GraphQLObjectTypeDefinition,
  type GraphQLResolverBinding,
  type GraphQLResolverOperation,
  type GraphQLRootTypes,
  type GraphQLTypeDefinition,
  type GraphQLUnionTypeDefinition,
} from './metadata.ts'
export { type DirectExecuteOptions, GraphQLPlugin, type MaybePromise } from './plugin.ts'
export { PubSub, type SubscribeOptions } from './pubsub.ts'
export { GraphQLTokens } from './tokens.ts'
export { validateArgs } from './validate-args.ts'
