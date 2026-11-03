/**
 * Canonical identities the `@znight/graphql` compiler extension recognises (RFC 0005 §5.14,
 * §6.2, §6.5): its decorators, `scalar<T>()`, the scalar aliases, the loader and context types, and
 * the look-alike decorators of `@znight/http` it reports (ZNIGHT005).
 *
 * Constants only: this module must stay free of runtime imports (the compiler loads the extension
 * entry, which must never load the GraphQL runtime, graphql-js or dataloader).
 */

/** Package name: the prefix of every identity below. */
export const GRAPHQL_PACKAGE = '@znight/graphql'

/** Name of the extension, also the key of `metadata.extensions.graphql`. */
export const EXTENSION_NAME = 'graphql'

/** Module the generated code imports its runtime helpers and types from. */
export const RUNTIME_MODULE = '@znight/graphql'

/** Canonical identities of the exports of `@znight/graphql` the compiler reads. */
export const GraphQLIds: {
  /** `@Resolver(options?)`, class decorator. */
  readonly Resolver: string
  /** `@Query(name?)`, method decorator. */
  readonly Query: string
  /** `@Mutation(name?)`, method decorator. */
  readonly Mutation: string
  /** `@Subscription(name?)`, method decorator. */
  readonly Subscription: string
  /** `@ResolveField(name?)`, method decorator. */
  readonly ResolveField: string
  /** `@Args(nameOrSchema?, schema?)`, parameter decorator. */
  readonly Args: string
  /** `@Parent()`, parameter decorator. */
  readonly Parent: string
  /** `@Ctx()`, parameter decorator (`GraphQLContext`). */
  readonly Ctx: string
  /** `@Info()`, parameter decorator (graphql-js `GraphQLResolveInfo`). */
  readonly Info: string
  /** `@Loader()` parameter decorator **and** the `Loader<L>` parameter type (same export name). */
  readonly Loader: string
  /** `@UseGuard(...guards)`, class or method decorator. */
  readonly UseGuard: string
  /** `scalar<T>(name, definition)`. */
  readonly scalar: string
  /** `type ID = string` → `ID`. */
  readonly ID: string
  /** `type Int = number` → `Int`. */
  readonly Int: string
  /** `type Float = number` → `Float`. */
  readonly Float: string
  /** `type JSONValue` → `JSON`. */
  readonly JSONValue: string
  /** `interface BatchLoad<K, V>`: what loader providers implement (ZNIGHT065). */
  readonly BatchLoad: string
  /** `interface GraphQLContext`: the request-scoped external (manifest `provides`). */
  readonly GraphQLContext: string
  /** `interface ResolverContext`: what guards receive. */
  readonly ResolverContext: string
  /** `abstract class PubSub`: the singleton external (manifest `provides`). */
  readonly PubSub: string
  /** `GraphQLPlugin`: the singleton external (manifest `provides`). */
  readonly GraphQLPlugin: string
} = Object.freeze({
  Resolver: '@znight/graphql#Resolver',
  Query: '@znight/graphql#Query',
  Mutation: '@znight/graphql#Mutation',
  Subscription: '@znight/graphql#Subscription',
  ResolveField: '@znight/graphql#ResolveField',
  Args: '@znight/graphql#Args',
  Parent: '@znight/graphql#Parent',
  Ctx: '@znight/graphql#Ctx',
  Info: '@znight/graphql#Info',
  Loader: '@znight/graphql#Loader',
  UseGuard: '@znight/graphql#UseGuard',
  scalar: '@znight/graphql#scalar',
  ID: '@znight/graphql#ID',
  Int: '@znight/graphql#Int',
  Float: '@znight/graphql#Float',
  JSONValue: '@znight/graphql#JSONValue',
  BatchLoad: '@znight/graphql#BatchLoad',
  GraphQLContext: '@znight/graphql#GraphQLContext',
  ResolverContext: '@znight/graphql#ResolverContext',
  PubSub: '@znight/graphql#PubSub',
  GraphQLPlugin: '@znight/graphql#GraphQLPlugin',
})

/** Field decorators → the kind of field they declare (`GraphQLResolverBinding.operation`). */
export const FIELD_DECORATORS: ReadonlyMap<string, 'query' | 'mutation' | 'subscription' | 'field'> = new Map([
  [GraphQLIds.Query, 'query'],
  [GraphQLIds.Mutation, 'mutation'],
  [GraphQLIds.Subscription, 'subscription'],
  [GraphQLIds.ResolveField, 'field'],
])

/** Parameter decorators → what the generated `invoke` passes (§7.3). */
export const PARAMETER_DECORATORS: ReadonlyMap<string, 'args' | 'parent' | 'ctx' | 'info' | 'loader'> = new Map([
  [GraphQLIds.Args, 'args'],
  [GraphQLIds.Parent, 'parent'],
  [GraphQLIds.Ctx, 'ctx'],
  [GraphQLIds.Info, 'info'],
  [GraphQLIds.Loader, 'loader'],
])

/** Scalar aliases of `@znight/graphql` → their GraphQL scalar (§6.2). */
export const SCALAR_ALIASES: ReadonlyMap<string, 'ID' | 'Int' | 'Float' | 'JSON'> = new Map([
  [GraphQLIds.ID, 'ID'],
  [GraphQLIds.Int, 'Int'],
  [GraphQLIds.Float, 'Float'],
  [GraphQLIds.JSONValue, 'JSON'],
])

/**
 * Decorators of `@znight/http` that look like GraphQL ones, on a resolver: ZNIGHT005 with the
 * `@znight/graphql` decorator to import instead (§6.5).
 */
export const HTTP_LOOK_ALIKES: ReadonlyMap<string, string> = new Map([
  ['@znight/http#Ctx', GraphQLIds.Ctx],
  ['@znight/http#Query', GraphQLIds.Args],
  ['@znight/http#Param', GraphQLIds.Args],
  ['@znight/http#Body', GraphQLIds.Args],
  ['@znight/http#UseGuard', GraphQLIds.UseGuard],
])

/** `@Controller` of `@znight/http`: a class cannot be both a controller and a resolver (ZNIGHT005). */
export const HTTP_CONTROLLER = '@znight/http#Controller'

/** graphql-js `GraphQLResolveInfo`, the type of `@Info()` parameters. */
export const GRAPHQL_RESOLVE_INFO = 'graphql#GraphQLResolveInfo'
