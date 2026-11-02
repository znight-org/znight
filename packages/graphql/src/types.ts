/**
 * Type-level contracts of `@znight/graphql` (RFC 0005 §5.5, §5.8–§5.10, §7.1): what resolvers,
 * guards, loaders and error mappers implement or receive. The runtime implements them; the compiler
 * extension recognises some of them by identity (`compiler/ids.ts`).
 *
 * Types only: this module emits no code and imports types only (`graphql` and `@znight/http` are
 * required peers), so both the runtime and the compiler extension may reference it.
 */
import type { Token } from '@znight/core'
import type { GuardEnforcement, HttpContext, RouteMetaCarrier } from '@znight/http'
import type { ConstValueNode, DocumentNode, GraphQLResolveInfo } from 'graphql'
import type { GraphQLException } from './errors.ts'

/** Arguments of a field, after GraphQL coercion (and null handling, §7.3), by argument name. */
export type GraphQLArgs = Readonly<Record<string, unknown>>

/** Kind of a GraphQL operation. */
export type GraphQLOperationKind = 'query' | 'mutation' | 'subscription'

/** How an operation reached the server: GraphQL over HTTP, GraphQL over SSE, or `plugin.execute()`. */
export type GraphQLTransport = 'http' | 'sse' | 'direct'

/**
 * Options of a loader (§5.5), read once per loader class: the `options` property of a
 * {@link BatchLoad} provider. They are DataLoader's, except `batchScheduleFn` (Znight batches per
 * tick of the execution).
 */
export interface LoaderOptions<K = unknown> {
  /** Largest number of keys passed to one `load()` call. Default: unlimited. */
  readonly maxBatchSize?: number
  /** Cache values per execution (by key). Default `true`. */
  readonly cache?: boolean
  /** Cache key of a key, for object keys (`key => key.id`). Default: the key itself. */
  cacheKeyFn?(key: K): unknown
}

/**
 * A batch loader (§5.5): a provider that loads many keys at once. Inject its per-execution
 * DataLoader with `@Loader() authors: Loader<AuthorsById>`.
 *
 * ```ts
 * @Injectable()
 * export class AuthorsById implements BatchLoad<ID, Author> {
 *   constructor(private readonly authors: AuthorRepository) {}
 *
 *   async load(ids: readonly ID[]): Promise<readonly (Author | Error)[]> {
 *     return orderByKeys(ids, await this.authors.findMany(ids), author => author.id)
 *   }
 * }
 * ```
 */
export interface BatchLoad<K, V> {
  /**
   * Loads the values of `keys`: one value (or an `Error` failing that key only) per key, in the
   * order of the keys. Another number of values fails every key of the batch (ZNIGHT065).
   */
  load(keys: readonly K[]): Promise<readonly (V | Error)[]>
  /** DataLoader options, read once per loader class. */
  readonly options?: LoaderOptions<K>
}

/** Key type of a {@link BatchLoad} provider. */
export type LoaderKey<L> = L extends { load(keys: readonly (infer K)[]): unknown } ? K : never

/** Value type of a {@link BatchLoad} provider (`Error`s excluded). */
export type LoaderValue<L> = L extends { load(keys: never): Promise<readonly (infer V)[]> } ? Exclude<V, Error> : never

/**
 * The DataLoader of one execution for a loader (§5.5): the part of the `dataloader` API resolvers
 * use. `Loader<L>` (exported with the `@Loader()` decorator) is this view for the provider `L`.
 */
export interface BatchLoader<K, V> {
  /** The value of `key`, batched with the other keys requested in the same tick. */
  load(key: K): Promise<V>
  /** The values of `keys`: a value or an `Error` per key, never a rejection. */
  loadMany(keys: readonly K[]): Promise<(V | Error)[]>
  /** Forgets the cached value of `key`. */
  clear(key: K): this
  /** Forgets every cached value. */
  clearAll(): this
  /** Caches a value for `key` (no effect when `key` is already cached). */
  prime(key: K, value: V | PromiseLike<V> | Error): this
}

/** A class of {@link BatchLoad} providers. */
export type BatchLoadClass<L extends BatchLoad<unknown, unknown> = BatchLoad<unknown, unknown>> = abstract new (
  ...args: never[]
) => L

/**
 * The context of one GraphQL operation (§5.8): a request-scoped external
 * (`@znight/graphql#GraphQLContext`), injected with `@Ctx()` in resolvers, in request-scoped
 * providers, or as `Lazy<GraphQLContext>` in singletons. It is not a bag for user data: the
 * authenticated user is a request-scoped provider filled by a guard.
 */
export interface GraphQLContext {
  /** Id of the request carrying the operation (`HttpContext.requestId` over HTTP). */
  readonly requestId: string
  readonly transport: GraphQLTransport
  /** The HTTP request carrying the operation; `undefined` for `plugin.execute()`. */
  readonly http: HttpContext | undefined
  readonly operationType: GraphQLOperationKind
  readonly operationName: string | undefined
  /** The parsed (and validated) document, shared through the document cache: never mutate it. */
  readonly document: DocumentNode
  readonly variables: Readonly<Record<string, unknown>>
  /**
   * Over HTTP, the request's `ctx.signal` (RFC 0006): client gone, SSE stream closed on shutdown or
   * `maxDuration`. Passed to graphql-js as `abortSignal`. Direct executions get the plugin's own.
   */
  readonly signal: AbortSignal
  /** Per-operation storage. */
  readonly state: Map<string | symbol, unknown>
  /** The DataLoader of the current execution for a loader class (`ctx.loader(AuthorsById)`). */
  loader<L extends BatchLoad<unknown, unknown>>(loader: BatchLoadClass<L>): BatchLoader<LoaderKey<L>, LoaderValue<L>>
  /**
   * The DataLoader of the current execution for a loader provider token: what the generated
   * `invoke` functions call (`c.loader('src/a.loader.ts#AuthorsById')`), with no class lookup.
   */
  loader(token: Token): BatchLoader<unknown, unknown>
}

/**
 * What a {@link GraphQLGuard} receives for one resolver call (§5.9). It satisfies the
 * `RouteMetaCarrier` of `@znight/http`, so route decorators read it: `Roles.get(ctx)`.
 */
export interface ResolverContext<TParent = unknown, TArgs extends GraphQLArgs = GraphQLArgs> extends RouteMetaCarrier {
  /** Effective metadata of the field (method decisions over class decisions) and its schema coordinate. */
  readonly route: {
    readonly meta: Readonly<Record<string, unknown>>
    /** `Query.books`, `Book.author`. */
    readonly coordinate: string
  }
  /** The operation. */
  readonly operation: GraphQLContext
  /** Name of the type owning the field (`Query`, `Book`). */
  readonly parentType: string
  /** Name of the field. */
  readonly field: string
  readonly args: TArgs
  /** The parent object (`undefined` for root fields, unless a root value is configured). */
  readonly parent: TParent
  readonly info: GraphQLResolveInfo
  /** `operation.http`. */
  readonly http: HttpContext | undefined
}

/**
 * A guard of GraphQL fields (§5.9). Guards run global (plugin option) → class `@UseGuard` → method
 * `@UseGuard`; `false` fails the field with a `FORBIDDEN` error, a thrown error is mapped (§5.10).
 * One class may also implement `CanActivate` (HTTP routes).
 */
export interface GraphQLGuard {
  canResolve(ctx: ResolverContext): boolean | Promise<boolean>
}

/** A class producing {@link GraphQLGuard}s, with the route decorators it enforces (`static enforces`). */
export type GraphQLGuardClass = (abstract new (...args: never[]) => GraphQLGuard) & GuardEnforcement

/**
 * Converts application errors to GraphQL errors (§5.10). Mappers are tried in order for every
 * error of `errors[]` that is not a `GraphQLException` already; the first one returning an
 * exception wins, `undefined` passes. Synchronous: errors are formatted once the execution
 * finished, without an extra await per error.
 */
export interface GraphQLErrorMapper {
  map(error: unknown, ctx: GraphQLContext): GraphQLException | undefined
}

/** A class producing {@link GraphQLErrorMapper}s. */
export type GraphQLErrorMapperClass = abstract new (...args: never[]) => GraphQLErrorMapper

/**
 * The implementation of a custom scalar (§5.7), given to `scalar<T>(name, definition)`. The
 * runtime maps it to graphql-js 17 `GraphQLScalarType` coercers: `serialize` → `coerceOutputValue`,
 * `parseValue` → `coerceInputValue`, `parseLiteral` → `coerceInputLiteral` (the deprecated
 * graphql-js names are never passed on).
 */
export interface ScalarDefinition<T> {
  readonly description?: string
  /** URL of the specification of the scalar (`@specifiedBy`). */
  readonly specifiedByURL?: string
  /** Internal value → response value. */
  serialize(value: T): unknown
  /** Variable value (JSON) → internal value; throw to reject it. */
  parseValue(value: unknown): T
  /** Literal of the document → internal value. Default: `parseValue` of the literal's JSON value. */
  parseLiteral?(literal: ConstValueNode): T
}
