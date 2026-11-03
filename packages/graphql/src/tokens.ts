import type { TypedToken } from '@znight/core'
import type { GraphQLPlugin } from './plugin.ts'
import type { PubSub } from './pubsub.ts'
import type { GraphQLContext } from './types.ts'

/**
 * Tokens of the values `GraphQLPlugin` supplies to the container (declared in the package
 * manifest). `GraphQLContext` is a request-scoped external: inject it in request-scoped providers
 * or through `Lazy<GraphQLContext>`.
 */
export const GraphQLTokens: {
  /** The {@link GraphQLContext} of the current operation (request scope). */
  readonly Context: TypedToken<GraphQLContext>
  /** The application {@link PubSub} (singleton). */
  readonly PubSub: TypedToken<PubSub>
  /** The {@link GraphQLPlugin} instance (singleton). */
  readonly Plugin: TypedToken<GraphQLPlugin>
} = Object.freeze({
  Context: '@znight/graphql#GraphQLContext',
  PubSub: '@znight/graphql#PubSub',
  Plugin: '@znight/graphql#GraphQLPlugin',
})
