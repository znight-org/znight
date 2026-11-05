/**
 * The GraphQL engine (RFC 0009 §4.2): what a GraphQL server (a driver) calls to run Znight's
 * schema. Its functions have the shape of graphql-js's (`parse`, `validate`, `execute`,
 * `subscribe`), so they fit Envelop's `useEngine`, `graphql-ws`, `graphql-sse` and `graphql-http`
 * handlers as they are, and they keep everything `GraphQLPlugin` guarantees: the document cache and
 * limits, the request scope and `GraphQLContext`, guards, loaders, result mappers, error mapping
 * and masking, the subscriptions cap and the `graphql:operation` hook.
 *
 * A layer over the internal `GraphQLExecutor`: the built-in transport keeps calling the executor
 * directly, so the engine costs nothing to an application without driver.
 */
import type { ByteSize } from '@znight/http'
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLError,
  GraphQLSchema,
  Source,
  ValidationRule,
} from 'graphql'
import type { EngineStream, ExecuteOptions, GraphQLExecutor } from './execution.ts'

/** A value of type `T` or a promise of it (graphql-js `PromiseOrValue`). */
type PromiseOrValue<T> = T | Promise<T>

/** Options of {@link GraphQLEngine.execute} and {@link GraphQLEngine.subscribe}. */
export interface EngineExecuteOptions {
  /**
   * The protocol that carried the operation (`GraphQLOperationEvent.transport`,
   * `GraphQLContext.transport`): `'http'` (default), `'sse'` for an event stream, `'ws'` for
   * `graphql-ws`.
   */
  readonly transport?: 'http' | 'sse' | 'ws'
  /**
   * Cancels the operation (graphql-js `abortSignal`, `GraphQLContext.signal`). Default:
   * `ExecutionArgs.abortSignal`, else the signal of the HTTP request of the current scope.
   */
  readonly signal?: AbortSignal
  /** `GraphQLContext.requestId`. Default: the request id of the HTTP request of the scope. */
  readonly requestId?: string
}

/** The resolved options a GraphQL server needs to configure itself (read-only). */
export interface GraphQLEngineSettings {
  /** The endpoint path, the `HttpPlugin` prefix included (`/api/graphql`). */
  readonly path: string
  readonly introspection: boolean
  /** The `graphiql` option: serve the server's IDE. */
  readonly ide: boolean
  readonly exposeErrors: boolean
  /** `limits.maxTokens`, for servers that parse documents themselves. */
  readonly maxTokens: number | undefined
  readonly subscriptions: false | { readonly maxActive: number }
  readonly http: false | { readonly get: boolean; readonly bodyLimit: ByteSize }
}

/**
 * The engine of a bootstrapped `GraphQLPlugin` (`plugin.engine`, and the first argument of
 * `GraphQLDriver.start()`). Its functions are bound: pass them around as they are.
 *
 * ```ts
 * const handler = createHandler({
 *   schema: engine.schema,
 *   parse: engine.parse,
 *   validate: engine.validate,
 *   execute: args => engine.execute(args),
 * })
 * ```
 */
export interface GraphQLEngine {
  /** The executable schema: its resolvers are Znight's pipelines. */
  readonly schema: GraphQLSchema
  readonly settings: GraphQLEngineSettings
  /**
   * graphql-js `parse` through the document cache: `maxTokens`, then the depth, aliases and
   * directives limits. Throws a `GraphQLError` (`GRAPHQL_PARSE_FAILED`, `QUERY_TOO_COMPLEX`), like
   * graphql-js. A text the engine validated returns the same `DocumentNode`.
   */
  parse(source: string | Source): DocumentNode
  /**
   * graphql-js `validate` with `rules` (default: graphql-js `specifiedRules`), to which the engine
   * adds its own ({@link rules}), with `hideSuggestions` when introspection is off. With the
   * default rules on {@link schema}, a document is validated once (then cached).
   */
  validate(schema: GraphQLSchema, document: DocumentNode, rules?: readonly ValidationRule[]): readonly GraphQLError[]
  /** The engine's own rules (limits, introspection), for servers that validate documents themselves. */
  readonly rules: readonly ValidationRule[]
  /**
   * Executes a validated query or mutation in the current request scope (or a scope of its own),
   * with the operation's `GraphQLContext` as `contextValue` (`args.contextValue` becomes
   * `GraphQLContext.serverContext`). Errors are mapped and masked, as `GraphQLError` instances.
   */
  execute(args: ExecutionArgs, options?: EngineExecuteOptions): PromiseOrValue<ExecutionResult>
  /**
   * Starts a validated subscription: a stream of results, or a single error result (rejected, past
   * `subscriptions.maxActive`, a source that could not start). The plugin ends the stream when the
   * application stops.
   */
  subscribe(
    args: ExecutionArgs,
    options?: EngineExecuteOptions,
  ): PromiseOrValue<AsyncGenerator<ExecutionResult, void, void> | ExecutionResult>
}

/** The engine of a plugin: bound functions over its executor. */
export class Engine implements GraphQLEngine {
  readonly schema: GraphQLSchema
  readonly settings: GraphQLEngineSettings
  readonly rules: readonly ValidationRule[]
  readonly parse: (source: string | Source) => DocumentNode
  readonly validate: (
    schema: GraphQLSchema,
    document: DocumentNode,
    rules?: readonly ValidationRule[],
  ) => readonly GraphQLError[]
  readonly execute: (args: ExecutionArgs, options?: EngineExecuteOptions) => PromiseOrValue<ExecutionResult>
  readonly subscribe: (args: ExecutionArgs, options?: EngineExecuteOptions) => Promise<EngineStream | ExecutionResult>

  constructor(executor: GraphQLExecutor, settings: GraphQLEngineSettings, driver: string) {
    this.schema = executor.schema
    this.settings = Object.freeze({ ...settings })
    this.rules = executor.engineRules
    // extra arguments of graphql-js (parse options, validation options) are not used: the engine's apply
    this.parse = source => executor.parseDocument(source, driver)
    this.validate = (schema, document, rules) => executor.validateDocument(schema, document, rules, driver)
    this.execute = (args, options) => executor.executeDocument(args, executeOptions(args, options, driver))
    this.subscribe = (args, options) => executor.subscribeDocument(args, executeOptions(args, options, driver))
  }
}

function executeOptions(
  args: ExecutionArgs,
  options: EngineExecuteOptions | undefined,
  driver: string,
): ExecuteOptions {
  const signal = options?.signal ?? args?.abortSignal ?? undefined
  const requestId = options?.requestId
  return {
    transport: options?.transport ?? 'http',
    driver,
    serverContext: args?.contextValue,
    ...(signal === undefined ? {} : { signal }),
    ...(requestId === undefined ? {} : { requestId }),
  }
}
