/**
 * Execution (RFC 0005 §8.4, §8.7–§8.10): the document cache, request checks, operation selection,
 * graphql-js `execute` and subscriptions, error formatting and the `graphql:operation` hook.
 *
 * `GraphQLExecutor` is the internal API of the transports (`plugin.execute()`, GraphQL over HTTP
 * and SSE): `execute()` answers a request with a status and a formatted result, `subscribe()` with
 * a stream of formatted results (or a rejection). The `*Document()` methods are what the public
 * `GraphQLEngine` of the drivers calls (RFC 0009 §4.2): graphql-js-shaped, on a parsed document,
 * answering `GraphQLError` instances. They share the document cache, the context, the pipelines,
 * the formatting and the hook with the transport methods, whose code they leave untouched.
 *
 * Per operation, on the hot path (a cached query over a scope that already exists): one cache
 * lookup, one context object, graphql-js `execute`, and the result as graphql-js returned it when
 * it has no error. Synchronous when every resolver is; nothing is awaited that is not a promise.
 * The hook event is built only when the hook has wrappers or listeners.
 */
import type { Container, CoreLogger, GraphQLOperationEvent, Hooks, ScopeContext } from '@znight/core'
import type { HttpContext } from '@znight/http'
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  FormattedExecutionResult,
  GraphQLError,
  GraphQLFormattedError,
  GraphQLSchema,
  OperationDefinitionNode,
  Source,
  ValidatedSubscriptionArgs,
  ValidationRule,
} from 'graphql'
import type { ContextRuntime } from './context.ts'
import type { ErrorFormatter } from './format.ts'
import type { DocumentLimits } from './limits.ts'
import type { GraphQLOperationKind, GraphQLTransport } from './types.ts'

import { createHash, randomUUID } from 'node:crypto'
import { ErrorCode, ZnightError } from '@znight/core'
import { HttpTokens } from '@znight/http'
import {
  AbortedGraphQLExecutionError,
  createSourceEventStream,
  execute,
  executeSubscriptionEvent,
  GraphQLError as GraphQLErrorClass,
  Kind,
  NoSchemaIntrospectionCustomRule,
  parse,
  print,
  specifiedRules,
  validate,
  validateSubscriptionArgs,
} from 'graphql'

import { OperationContext } from './context.ts'
import { GraphQLErrorCode } from './errors.ts'
import { requestError, withCode } from './format.ts'
import { checkLimits, limitsRule } from './limits.ts'
import { GraphQLTokens } from './tokens.ts'
import { DeferredAbort } from './transport/abort.ts'

/** A GraphQL request: the body of a GraphQL-over-HTTP request, or the argument of `plugin.execute()`. */
export interface GraphQLRequest {
  readonly query: string
  readonly operationName?: string | null | undefined
  readonly variables?: Readonly<Record<string, unknown>> | null | undefined
  /** Request extensions (ignored by the executor; available to transports). */
  readonly extensions?: Readonly<Record<string, unknown>> | null | undefined
}

/** How a request reached the executor. */
export interface ExecuteOptions {
  /** Default `'direct'`. */
  readonly transport?: GraphQLTransport
  /** The HTTP request carrying the operation (GraphQL over HTTP and SSE). */
  readonly http?: HttpContext
  /**
   * Cancels the operation (passed to graphql-js `abortSignal`, and `GraphQLContext.signal`). Only
   * passed when given: graphql-js then adds an abort listener per execution. Over HTTP, the
   * transport passes `ctx.signal`.
   */
  readonly signal?: AbortSignal
  /**
   * Passed to graphql-js as `abortSignal` instead of {@link signal} (which stays the signal of
   * `GraphQLContext.signal`). The HTTP transport passes a stand-in that reads `ctx.signal` only when
   * an execution turns asynchronous (see `transport/abort.ts`).
   */
  readonly abortSignal?: AbortSignal
  /** Default: the HTTP request id, the request id of the enclosing scope, or a UUID (on first read). */
  readonly requestId?: string
  /** GET: queries only, other operations are rejected with 405 and `allow: POST`. */
  readonly queriesOnly?: boolean
  /**
   * {@link GraphQLExecutor.execute} answers a subscription with {@link SUBSCRIBE} (nothing observed
   * yet) instead of a 400: the HTTP transport then streams it (the client accepts an event stream).
   */
  readonly streamSubscriptions?: boolean
  /** The driver that received the operation (`GraphQLOperationEvent.driver`). Default `'builtin'`. */
  readonly driver?: string
  /** The driver's context (`ExecutionArgs.contextValue`): `GraphQLContext.serverContext`. */
  readonly serverContext?: unknown
}

/**
 * The answer of {@link GraphQLExecutor.execute} to a subscription with
 * {@link ExecuteOptions.streamSubscriptions}: start it with {@link GraphQLExecutor.subscribe}.
 */
export const SUBSCRIBE: GraphQLResponse = Object.freeze({ status: 0, result: Object.freeze({}) })

/** The answer to a request: an HTTP-like status and the formatted result. */
export interface GraphQLResponse {
  /**
   * 200: executed (the result may hold field errors); 400: request error (parse, validation,
   * variables, limits, operation selection, subscription without stream); 405: not a query with
   * `queriesOnly`; 503: too many active subscriptions.
   */
  readonly status: number
  readonly result: FormattedExecutionResult
  /** Headers of the HTTP response (`allow` with a 405). */
  readonly headers?: Readonly<Record<string, string>>
}

/** The results of a subscription (one per event), or the single result of a query sent as a stream. */
export interface GraphQLResultStream extends AsyncIterableIterator<FormattedExecutionResult> {
  /** Ends the stream: the source event stream is returned (unsubscribed). */
  return(): Promise<IteratorResult<FormattedExecutionResult>>
}

/** The stream of results of a subscription started through the engine (`GraphQLEngine.subscribe`). */
export type EngineStream = AsyncGenerator<ExecutionResult, void, void>

/** Any result the hook reads: a transport response, or an engine one (`GraphQLError` instances). */
interface Settled {
  readonly status: number
  readonly result: {
    readonly data?: unknown
    readonly errors?: readonly {
      readonly message: string
      readonly path?: readonly (string | number)[] | undefined
      readonly extensions?: { readonly [key: string]: unknown } | undefined
    }[]
  }
}

/** The answer to an engine execution: like {@link GraphQLResponse}, with a graphql-js result. */
interface EngineResponse {
  readonly status: number
  readonly result: ExecutionResult
}

/** What {@link GraphQLExecutor} is built from (resolved plugin options). */
export interface ExecutorOptions {
  readonly schema: GraphQLSchema
  readonly container: Container
  readonly hooks: Hooks
  readonly logger: CoreLogger
  readonly formatter: ErrorFormatter
  readonly runtime: ContextRuntime
  readonly limits: DocumentLimits & { readonly maxTokens: number | undefined }
  readonly introspection: boolean
  /** Entries of the document cache, 0 disables it. */
  readonly documentCache: number
  /** Active subscriptions cap, `undefined`: none. */
  readonly maxActiveSubscriptions: number | undefined
  /**
   * `subscriptions: false`: the engine answers a subscription with a `BAD_REQUEST` error result
   * (the built-in transport refuses event streams itself). Default `true`.
   */
  readonly subscriptions?: boolean
}

const OPERATION_HOOK = 'graphql:operation'
const DIRECT: ExecuteOptions = Object.freeze({})
const NO_ERRORS: readonly GraphQLError[] = Object.freeze([])
const DONE: IteratorResult<FormattedExecutionResult> = Object.freeze({ done: true, value: undefined })

/** SHA-256 (hex) of a query text: `GraphQLOperationEvent.documentId`. */
function documentId(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex')
}

/** A parsed and validated document, kept by the document cache. */
class CachedDocument {
  readonly query: string
  readonly document: DocumentNode
  /** The operation of a single-operation document. */
  readonly single: OperationDefinitionNode | undefined
  /** Operations by name (documents with several operations). */
  readonly named: ReadonlyMap<string, OperationDefinitionNode> | undefined
  #id: string | undefined

  constructor(query: string, document: DocumentNode) {
    this.query = query
    this.document = document
    let single: OperationDefinitionNode | undefined
    let named: Map<string, OperationDefinitionNode> | undefined
    let count = 0
    for (const definition of document.definitions) {
      if (definition.kind !== Kind.OPERATION_DEFINITION) continue
      count++
      single = definition
      if (definition.name !== undefined) {
        named ??= new Map()
        named.set(definition.name.value, definition)
      }
    }
    this.single = count === 1 ? single : undefined
    this.named = named
  }

  /** SHA-256 of the query, computed on first read (only the hook needs it). */
  get id(): string {
    this.#id ??= documentId(this.query)
    return this.#id
  }
}

/** A bounded LRU of documents by exact query text. */
class DocumentCache {
  readonly #max: number
  readonly #entries = new Map<string, CachedDocument>()
  #last: string | undefined

  constructor(max: number) {
    this.#max = max
  }

  get size(): number {
    return this.#entries.size
  }

  get(query: string): CachedDocument | undefined {
    const entry = this.#entries.get(query)
    // refresh the recency (a re-insertion), except for the most recent entry: the hot loop of one query
    if (entry !== undefined && this.#last !== query) {
      this.#entries.delete(query)
      this.#entries.set(query, entry)
      this.#last = query
    }
    return entry
  }

  set(query: string, entry: CachedDocument): void {
    if (this.#max === 0) return
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next()
      if (oldest.done !== true) this.#entries.delete(oldest.value)
    }
    this.#entries.set(query, entry)
    this.#last = query
  }

  clear(): void {
    this.#entries.clear()
    this.#last = undefined
  }
}

/** A request refused before execution. */
class Rejection {
  readonly status: number
  readonly errors: GraphQLFormattedError[]
  readonly operationType: GraphQLOperationKind | undefined
  readonly operationName: string | undefined
  readonly documentId: string | undefined
  readonly headers: Readonly<Record<string, string>> | undefined

  constructor(
    status: number,
    errors: GraphQLFormattedError[],
    documentId: string | undefined,
    operation?: OperationDefinitionNode,
    headers?: Readonly<Record<string, string>>,
  ) {
    this.status = status
    this.errors = errors
    this.documentId = documentId
    this.operationType = operation?.operation
    this.operationName = operation?.name?.value
    this.headers = headers
  }

  response(): GraphQLResponse {
    return {
      status: this.status,
      result: { errors: this.errors },
      ...(this.headers === undefined ? {} : { headers: this.headers }),
    }
  }
}

/** A request ready to execute. */
interface Prepared {
  readonly entry: CachedDocument
  readonly operation: OperationDefinitionNode
}

/** What starting a subscription gives: a stream, a rejection, or (engine) an error result. */
type Started = GraphQLResultStream | EngineStream | ExecutionResult | Rejection

/** The GraphQL executor of a plugin. */
export class GraphQLExecutor {
  readonly #schema: GraphQLSchema
  readonly #container: Container
  readonly #hooks: Hooks
  readonly #logger: CoreLogger
  readonly #formatter: ErrorFormatter
  readonly #runtime: ContextRuntime
  readonly #rules: readonly ValidationRule[]
  readonly #limits: DocumentLimits
  readonly #maxTokens: number | undefined
  readonly #hideSuggestions: boolean
  readonly #cache: DocumentCache
  readonly #maxActive: number | undefined
  readonly #subscriptions: boolean
  readonly #streams = new Set<SubscriptionStream<unknown>>()
  /**
   * The streams the plugin ends in `onStop`: direct subscriptions and those of the engine. The SSE
   * streams of the built-in transport are ended by `HttpPlugin`'s shutdown (with a `retry` hint).
   */
  readonly #owned = new Set<SubscriptionStream<unknown>>()
  /** The streams of the engine (drivers), a part of {@link #owned}: ended when `HttpPlugin` drains. */
  readonly #engineStreams = new Set<SubscriptionStream<unknown>>()
  /** The application stops (`HttpPlugin` drains, or the plugin stops): the engine refuses new subscriptions (503). */
  #closing = false
  /** Subscriptions counted against `maxActive` while their source starts (not yet in `#streams`). */
  #starting = 0
  /** The engine's extra rules (`GraphQLEngine.rules`): the limits, introspection. Built on first use. */
  #engineRules: readonly ValidationRule[] | undefined
  /** The document limits as a rule, `undefined` when every limit is off. */
  readonly #limitsRule: ValidationRule | undefined
  /** Documents parsed by {@link parseDocument}: within their limits, not checked again by validation. */
  readonly #limited = new WeakSet<DocumentNode>()
  /** Operations of the documents the engine executed, by document (the server's or the cache's). */
  readonly #documents = new WeakMap<DocumentNode, CachedDocument>()

  constructor(options: ExecutorOptions) {
    this.#schema = options.schema
    this.#container = options.container
    this.#hooks = options.hooks
    this.#logger = options.logger
    this.#formatter = options.formatter
    this.#runtime = options.runtime
    this.#rules = options.introspection ? specifiedRules : [...specifiedRules, NoSchemaIntrospectionCustomRule]
    this.#limits = options.limits
    this.#maxTokens = options.limits.maxTokens
    // without introspection, suggestions would leak field and type names
    this.#hideSuggestions = !options.introspection
    this.#cache = new DocumentCache(options.documentCache)
    this.#maxActive = options.maxActiveSubscriptions
    this.#subscriptions = options.subscriptions !== false
    this.#limitsRule = limitsRule(options.limits)
  }

  /** The schema operations run against. */
  get schema(): GraphQLSchema {
    return this.#schema
  }

  /** The engine's own validation rules (`GraphQLEngine.rules`): the limits, and introspection when it is off. */
  get engineRules(): readonly ValidationRule[] {
    let rules = this.#engineRules
    if (rules === undefined) {
      const list: ValidationRule[] = []
      if (this.#limitsRule !== undefined) list.push(this.#limitsRule)
      if (this.#hideSuggestions) list.push(NoSchemaIntrospectionCustomRule)
      rules = Object.freeze(list)
      this.#engineRules = rules
    }
    return rules
  }

  /** Active subscriptions (every transport). */
  get activeSubscriptions(): number {
    return this.#streams.size
  }

  /** Documents in the cache. */
  get cachedDocuments(): number {
    return this.#cache.size
  }

  /**
   * Executes a query or a mutation. Resolves (or returns, when every resolver is synchronous) a
   * response; rejects only when `options.signal` aborts the execution (with the signal's reason).
   * A subscription is a 400: it needs {@link subscribe} ({@link SUBSCRIBE} with
   * `streamSubscriptions`).
   */
  execute(request: GraphQLRequest, options: ExecuteOptions = DIRECT): GraphQLResponse | Promise<GraphQLResponse> {
    const prepared = this.#prepare(request, options)
    if (prepared instanceof Rejection) return this.#reject(prepared, request, options)
    if (prepared.operation.operation === 'subscription') {
      if (options.streamSubscriptions === true) return SUBSCRIBE
      return this.#reject(
        new Rejection(
          400,
          [
            requestError(
              'Subscriptions are delivered as a stream: send the request with accept: text/event-stream (GraphQL over SSE), or call GraphQLPlugin.subscribe()',
              GraphQLErrorCode.BadRequest,
            ),
          ],
          prepared.entry.id,
          prepared.operation,
        ),
        request,
        options,
      )
    }
    const scope = this.#container.currentScope()
    const ctx = this.#context(prepared, request, options, scope)
    const hooks = this.#hooks
    if (!hooks.hasWrappers(OPERATION_HOOK) && !hooks.hasListeners(OPERATION_HOOK)) {
      return this.#inScope(scope, ctx, () => this.#run(prepared, request, options, ctx))
    }
    return this.#inScope(scope, ctx, () =>
      this.#observed(ctx, prepared.entry.id, () => this.#run(prepared, request, options, ctx)),
    )
  }

  /**
   * Subscribes: a stream of results, one per source event, or a rejection (status 400, 405 or 503).
   * A query or a mutation gives a stream of its single result. The stream ends when the source
   * ends, when `options.signal` aborts, or with `return()`; a source failure ends it with a final
   * error result (`SUBSCRIPTION_OVERFLOW` for a subscriber that fell behind `MemoryPubSub`).
   */
  async subscribe(
    request: GraphQLRequest,
    options: ExecuteOptions = DIRECT,
  ): Promise<GraphQLResponse | GraphQLResultStream> {
    const prepared = this.#prepare(request, options)
    if (prepared instanceof Rejection) return this.#reject(prepared, request, options)
    if (prepared.operation.operation !== 'subscription') {
      const response = await this.execute(request, options)
      return response.status === 200 ? new SingleResultStream(response.result) : response
    }
    if (this.#full()) return this.#reject(overflow(prepared), request, options)
    const started = await this.#start(prepared, request, options, false)
    return started instanceof Rejection ? started.response() : (started as GraphQLResultStream)
  }

  /** Every slot of `subscriptions.maxActive` is taken (started streams and starting ones). */
  #full(): boolean {
    return this.#maxActive !== undefined && this.#streams.size + this.#starting >= this.#maxActive
  }

  /**
   * Starts a subscription in the current scope (or in one of its own, open as long as the stream):
   * the slot reserved, the context and the hook observer created, the source started. A rejection
   * (variables) is observed and returned for the caller to answer.
   */
  async #start(
    prepared: Prepared,
    request: GraphQLRequest,
    options: ExecuteOptions,
    engine: boolean,
  ): Promise<Started> {
    // the slot is reserved before the source starts (guards and subscribe methods may be async):
    // concurrent subscriptions see it; released once the stream is counted or did not start
    let reserved = this.#maxActive !== undefined
    if (reserved) this.#starting++
    const release = (): void => {
      if (reserved) {
        reserved = false
        this.#starting--
      }
    }
    const outer = this.#container.currentScope()
    const ctx = this.#context(prepared, request, options, outer)
    // ctx.signal also aborts when the stream ends (return() included, on every transport): the
    // source, started before the first read (SubscriptionStream), then lets go of its PubSub topic
    const ended = new AbortController()
    ctx.endsWith(ended.signal)
    let run: <R>(fn: () => R) => R
    let close: () => void
    if (outer === undefined) {
      // a direct subscription: its own scope, open as long as the stream
      const opened = this.#container.openScope([[GraphQLTokens.Context, ctx]])
      run = fn => opened.run(fn)
      close = () => {
        ended.abort()
        opened.close()?.catch(error => this.#runtimeLogError('Failed to close the scope of a subscription', error))
      }
    } else {
      outer.set(GraphQLTokens.Context, ctx)
      run = fn => fn()
      close = () => ended.abort()
    }
    const observer = this.#observer(ctx, prepared.entry.id)
    try {
      const stream = await run(() =>
        this.#startSubscription(prepared, request, options, ctx, observer, run, close, release, engine),
      )
      release()
      if (stream instanceof Rejection) {
        close()
        observer?.end('rejected', stream.errors)
      }
      return stream
    } catch (error) {
      release()
      close()
      observer?.end('error', undefined)
      throw error
    }
  }

  /**
   * Ends every subscription the plugin owns (plugin `onStop`): direct ones and those started
   * through the engine (drivers). Built-in SSE streams end with `HttpPlugin`'s shutdown.
   */
  async stopStreams(): Promise<void> {
    this.#closing = true
    await Promise.all([...this.#owned].map(stream => stream.return()))
  }

  /**
   * Ends the subscriptions of the engine (`HttpPlugin` drains, `GraphQLPlugin.onHttpDrain()`): a
   * driver serves them as streamed responses `HttpPlugin` does not close. New ones are refused (503).
   */
  async stopEngineStreams(): Promise<void> {
    this.#closing = true
    await Promise.all([...this.#engineStreams].map(stream => stream.return()))
  }

  /** Forgets every cached document. */
  clear(): void {
    this.#cache.clear()
  }

  // ------------------------------------------------------------------------------------------------
  // engine (RFC 0009 §4.2): graphql-js-shaped, on parsed documents, for GraphQL servers (drivers)

  /**
   * `GraphQLEngine.parse`: the document of the cache for a valid text, otherwise the text parsed
   * with `maxTokens` and checked against the depth, aliases and directives limits. Throws a
   * `GraphQLError` (`GRAPHQL_PARSE_FAILED`, `QUERY_TOO_COMPLEX`), observed as a rejected operation.
   */
  parseDocument(source: string | Source, driver: string): DocumentNode {
    const text = typeof source === 'string' ? source : (source as Source | undefined)?.body
    if (typeof text === 'string') {
      const cached = this.#cache.get(text)
      if (cached !== undefined) return cached.document
    }
    let document: DocumentNode
    try {
      document = parse(source, this.#maxTokens === undefined ? undefined : { maxTokens: this.#maxTokens })
    } catch (error) {
      if (!(error instanceof GraphQLErrorClass)) throw error
      const failed = coded(error, GraphQLErrorCode.ParseFailed)
      this.#rejectedDocument([failed], text, driver)
      throw failed
    }
    const limited = checkLimits(document, this.#limits)
    if (limited !== undefined) {
      this.#rejectedDocument(limited, text, driver)
      throw limited[0]
    }
    this.#limited.add(document)
    return document
  }

  /**
   * `GraphQLEngine.validate`: `rules` (default: graphql-js `specifiedRules`) plus the engine's own
   * (the limits, unless {@link parseDocument} checked them, and introspection), with
   * `hideSuggestions` when introspection is off. With the default rules on the engine's schema, a
   * cached document is not validated again, and a valid one enters the document cache. Errors carry
   * `GRAPHQL_VALIDATION_FAILED` (or the limit's code) and are observed as a rejected operation.
   */
  validateDocument(
    schema: GraphQLSchema,
    document: DocumentNode,
    rules: readonly ValidationRule[] | undefined,
    driver: string,
  ): readonly GraphQLError[] {
    const standard = rules === undefined || isSpecifiedRules(rules)
    const cacheable = standard && schema === this.#schema
    const text = document.loc?.source.body
    if (cacheable && text !== undefined && this.#cache.get(text)?.document === document) return NO_ERRORS
    const limited = this.#limited.has(document)
    let all: readonly ValidationRule[]
    if (standard) {
      all = limited || this.#limitsRule === undefined ? this.#rules : [this.#limitsRule, ...this.#rules]
    } else {
      // the server's rules (Envelop plugins add some) and the engine's, each once
      const merged = new Set<ValidationRule>(limited ? rules : [...this.engineRules, ...rules])
      for (const rule of this.engineRules) merged.add(rule)
      if (limited && this.#limitsRule !== undefined) merged.delete(this.#limitsRule)
      all = [...merged]
    }
    const errors = validate(schema, document, all, { hideSuggestions: this.#hideSuggestions })
    if (errors.length === 0) {
      if (cacheable && text !== undefined) {
        const entry = new CachedDocument(text, document)
        this.#cache.set(text, entry)
        this.#documents.set(document, entry)
      }
      return NO_ERRORS
    }
    const failed = errors.map(error =>
      coded(error, error.extensions['code'] === undefined ? GraphQLErrorCode.ValidationFailed : undefined),
    )
    this.#rejectedDocument(failed, text, driver)
    return failed
  }

  /**
   * `GraphQLEngine.execute`: a validated query or mutation of `args.document`, in the current
   * request scope (or one of its own), with the operation's `GraphQLContext` as `contextValue`
   * (`args.contextValue` becomes `serverContext`). The result is graphql-js's, its errors mapped
   * and masked, as `GraphQLError` instances without `originalError`. Without `options.signal`, an
   * execution that turns asynchronous follows `GraphQLContext.signal` (the HTTP request's).
   */
  executeDocument(args: ExecutionArgs, options: ExecuteOptions): ExecutionResult | Promise<ExecutionResult> {
    const prepared = this.#prepareDocument(args)
    if (prepared instanceof Rejection) return asEngineResult(this.#reject(prepared, requestOf(args), options))
    if (prepared.operation.operation === 'subscription') {
      return asEngineResult(
        this.#reject(
          new Rejection(
            400,
            [requestError('Subscriptions are started with GraphQLEngine.subscribe()', GraphQLErrorCode.BadRequest)],
            prepared.entry.id,
            prepared.operation,
          ),
          requestOf(args),
          options,
        ),
      )
    }
    const request: GraphQLRequest = {
      query: prepared.entry.query,
      operationName: args.operationName,
      variables: args.variableValues,
    }
    let abort: DeferredAbort | undefined
    let effective = options
    if (options.signal === undefined) {
      // like the HTTP transport: the request's signal is only followed once the execution is pending
      abort = new DeferredAbort()
      effective = { ...options, abortSignal: abort.asSignal() }
    }
    const scope = this.#container.currentScope()
    const ctx = this.#context(prepared, request, effective, scope)
    const run = (): EngineResponse | Promise<EngineResponse> =>
      this.#runEngine(prepared, request, effective, ctx, args.rootValue)
    const hooks = this.#hooks
    const response =
      !hooks.hasWrappers(OPERATION_HOOK) && !hooks.hasListeners(OPERATION_HOOK)
        ? this.#inScope(scope, ctx, run)
        : this.#inScope(scope, ctx, () => this.#observed(ctx, prepared.entry.id, run))
    if (!isPromise(response)) return response.result
    abort?.follow(() => ctx.signal)
    return response.then(resultOf)
  }

  /**
   * `GraphQLEngine.subscribe`: starts a validated subscription, a stream of graphql-js results (its
   * loaders renewed per event), or a single error result (rejected, past `maxActive`, a source that
   * could not start). A query or a mutation is executed: its single result. The stream ends with
   * `return()`, `options.signal` (default: the HTTP request's), its source, or the plugin's stop.
   */
  async subscribeDocument(args: ExecutionArgs, options: ExecuteOptions): Promise<EngineStream | ExecutionResult> {
    const prepared = this.#prepareDocument(args)
    if (prepared instanceof Rejection) return asEngineResult(this.#reject(prepared, requestOf(args), options))
    if (prepared.operation.operation !== 'subscription') return this.executeDocument(args, options)
    if (!this.#subscriptions) {
      return asEngineResult(
        this.#reject(
          new Rejection(
            400,
            [requestError('Subscriptions are disabled on this server', GraphQLErrorCode.BadRequest)],
            prepared.entry.id,
            prepared.operation,
          ),
          requestOf(args),
          options,
        ),
      )
    }
    if (this.#full() || this.#closing) {
      return asEngineResult(this.#reject(unavailable(prepared, this.#closing), requestOf(args), options))
    }
    const request: GraphQLRequest = {
      query: prepared.entry.query,
      operationName: args.operationName,
      variables: args.variableValues,
    }
    let effective = options
    if (options.signal === undefined) {
      const http = this.#container.currentScope()?.get(HttpTokens.Context) as HttpContext | undefined
      if (http !== undefined) effective = { ...options, signal: http.signal }
    }
    const started = await this.#start(prepared, request, effective, true)
    if (started instanceof Rejection) return { errors: started.errors.map(fromFormatted) }
    return started as EngineStream | ExecutionResult
  }

  /** The document of `args` and its operation, or a rejection (operation selection). */
  #prepareDocument(args: ExecutionArgs): Prepared | Rejection {
    if (args?.schema !== this.#schema) {
      throw new ZnightError(
        ErrorCode.InvalidGraphQLSetup,
        "GraphQLEngine: the operation targets another schema than the engine's (ExecutionArgs.schema)",
        { hints: ["Give the GraphQL server engine.schema: its resolvers are the engine's pipelines"] },
      )
    }
    const document = args.document
    let entry = this.#documents.get(document)
    if (entry === undefined) {
      const text = document.loc?.source.body
      const cached = text === undefined ? undefined : this.#cache.get(text)
      entry =
        cached !== undefined && cached.document === document
          ? cached
          : new CachedDocument(text ?? print(document), document)
      this.#documents.set(document, entry)
    }
    const operationName = args.operationName
    let operation: OperationDefinitionNode | undefined
    if (operationName === undefined || operationName === null) {
      operation = entry.single
      if (operation === undefined) {
        return new Rejection(
          400,
          [
            requestError(
              'Must provide operation name if query contains multiple operations.',
              GraphQLErrorCode.BadRequest,
            ),
          ],
          entry.id,
        )
      }
    } else {
      operation = entry.named?.get(operationName)
      if (operation === undefined) {
        return new Rejection(
          400,
          [requestError(`Unknown operation named "${operationName}".`, GraphQLErrorCode.BadRequest)],
          entry.id,
        )
      }
    }
    return { entry, operation }
  }

  #runEngine(
    prepared: Prepared,
    request: GraphQLRequest,
    options: ExecuteOptions,
    ctx: OperationContext,
    rootValue: unknown,
  ): EngineResponse | Promise<EngineResponse> {
    let result: ExecutionResult | Promise<ExecutionResult>
    try {
      result = execute({
        schema: this.#schema,
        document: prepared.entry.document,
        rootValue,
        operationName: request.operationName,
        variableValues: request.variables,
        contextValue: ctx,
        abortSignal: options.abortSignal ?? options.signal,
        hideSuggestions: this.#hideSuggestions,
      })
    } catch (error) {
      return Promise.reject(abortReason(error, options))
    }
    if (isPromise(result)) {
      return result.then(
        settled => this.#respondEngine(settled, ctx),
        (error: unknown) => Promise.reject(abortReason(error, options)),
      )
    }
    return this.#respondEngine(result, ctx)
  }

  /** {@link #respond} for the engine: the errors as `GraphQLError` instances. */
  #respondEngine(result: ExecutionResult, ctx: OperationContext): EngineResponse {
    const errors = result.errors
    if (errors === undefined) return { status: 200, result }
    if (!('data' in result)) {
      // no data: graphql-js refused the variables before executing
      return {
        status: 400,
        result: {
          errors: errors.map(error =>
            coded(error, error.extensions['code'] === undefined ? GraphQLErrorCode.BadUserInput : undefined),
          ),
        },
      }
    }
    return {
      status: 200,
      result: {
        data: result.data,
        errors: asGraphQLErrors(errors, this.#formatter.format(errors, ctx)),
        ...(result.extensions === undefined ? {} : { extensions: result.extensions }),
      },
    }
  }

  /** A document rejected by {@link parseDocument} or {@link validateDocument}, for the hook. */
  #rejectedDocument(errors: readonly GraphQLError[], text: string | undefined, driver: string): void {
    const hooks = this.#hooks
    const wrapped = hooks.hasWrappers(OPERATION_HOOK)
    if (!wrapped && !hooks.hasListeners(OPERATION_HOOK)) return
    const event: GraphQLOperationEvent = {
      operationType: undefined,
      operationName: undefined,
      documentId: text === undefined ? undefined : documentId(text),
      transport: 'http',
      driver,
      requestId: this.#scopedRequestId(),
      context: undefined,
      startTime: performance.now(),
      outcome: 'rejected',
      errors: summaries(errors),
    }
    if (!wrapped) {
      hooks.emit(OPERATION_HOOK, event)
      return
    }
    // parse and validate are synchronous: wrappers see the rejection, they cannot delay it
    hooks
      .run(OPERATION_HOOK, event, () => Promise.resolve())
      .then(
        () => {
          if (hooks.hasListeners(OPERATION_HOOK)) hooks.emit(OPERATION_HOOK, event)
        },
        (error: unknown) => this.#runtimeLogError('A "graphql:operation" hook wrapper failed', error),
      )
  }

  // ------------------------------------------------------------------------------------------------
  // preparation

  /** Request checks, the document (cached, or parsed, limited and validated), the operation. */
  #prepare(request: GraphQLRequest, options: ExecuteOptions): Prepared | Rejection {
    const query: unknown = request?.query
    if (typeof query !== 'string' || query === '') {
      return badRequest(typeof query === 'string' ? 'The query is empty' : 'Missing query (a string)')
    }
    const operationName: unknown = request.operationName
    if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') {
      return badRequest('operationName must be a string')
    }
    const variables: unknown = request.variables
    if (variables !== undefined && variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) {
      return badRequest('variables must be an object')
    }
    const entry = this.#cache.get(query) ?? this.#load(query)
    if (entry instanceof Rejection) return entry
    let operation: OperationDefinitionNode | undefined
    if (operationName === undefined || operationName === null) {
      operation = entry.single
      if (operation === undefined) {
        return new Rejection(
          400,
          [
            requestError(
              'Must provide operation name if query contains multiple operations.',
              GraphQLErrorCode.BadRequest,
            ),
          ],
          entry.id,
        )
      }
    } else {
      operation = entry.named?.get(operationName)
      if (operation === undefined) {
        return new Rejection(
          400,
          [requestError(`Unknown operation named "${operationName}".`, GraphQLErrorCode.BadRequest)],
          entry.id,
        )
      }
    }
    if (options.queriesOnly === true && operation.operation !== 'query') {
      return new Rejection(
        405,
        [requestError(`A ${operation.operation} cannot be sent with GET: use POST`, GraphQLErrorCode.BadRequest)],
        entry.id,
        operation,
        { allow: 'POST' },
      )
    }
    return { entry, operation }
  }

  /** Parses, limits and validates a document; caches it when valid (rejected documents are not cached). */
  #load(query: string): CachedDocument | Rejection {
    let document: DocumentNode
    try {
      document = parse(query, this.#maxTokens === undefined ? undefined : { maxTokens: this.#maxTokens })
    } catch (error) {
      if (!(error instanceof GraphQLErrorClass)) throw error
      return new Rejection(400, [withCode(error, GraphQLErrorCode.ParseFailed)], documentId(query))
    }
    const limited = checkLimits(document, this.#limits)
    if (limited !== undefined) {
      return new Rejection(
        400,
        limited.map(error => withCode(error, undefined)),
        documentId(query),
      )
    }
    const errors = validate(this.#schema, document, this.#rules, { hideSuggestions: this.#hideSuggestions })
    if (errors.length > 0) {
      return new Rejection(
        400,
        errors.map(error => withCode(error, GraphQLErrorCode.ValidationFailed)),
        documentId(query),
      )
    }
    const entry = new CachedDocument(query, document)
    this.#cache.set(query, entry)
    return entry
  }

  #context(
    prepared: Prepared,
    request: GraphQLRequest,
    options: ExecuteOptions,
    scope: ScopeContext | undefined,
  ): OperationContext {
    return new OperationContext(this.#runtime, prepared.entry.document, prepared.operation, request, options, scope)
  }

  // ------------------------------------------------------------------------------------------------
  // execution

  /** Runs `fn` in the current scope (the GraphQL context set in it) or in a new one, closed after. */
  #inScope<R>(scope: ScopeContext | undefined, ctx: OperationContext, fn: () => R | Promise<R>): R | Promise<R> {
    if (scope !== undefined) {
      scope.set(GraphQLTokens.Context, ctx)
      return fn()
    }
    const opened = this.#container.openScope([[GraphQLTokens.Context, ctx]])
    let result: R | Promise<R>
    try {
      result = opened.run(fn)
    } catch (error) {
      const closing = opened.close()
      if (closing === undefined) throw error
      return closing.then(
        () => Promise.reject(error),
        () => Promise.reject(error),
      )
    }
    if (isPromise(result)) {
      return result.then(
        value => {
          const closing = opened.close()
          return closing === undefined ? value : closing.then(() => value)
        },
        (error: unknown) => {
          const closing = opened.close()
          if (closing === undefined) throw error
          return closing.then(
            () => Promise.reject(error),
            () => Promise.reject(error),
          )
        },
      )
    }
    // request-scoped providers created by a synchronous execution: disposed before answering
    const closing = opened.close()
    return closing === undefined ? result : closing.then(() => result)
  }

  #run(
    prepared: Prepared,
    request: GraphQLRequest,
    options: ExecuteOptions,
    ctx: OperationContext,
  ): GraphQLResponse | Promise<GraphQLResponse> {
    let result: ExecutionResult | Promise<ExecutionResult>
    try {
      result = execute({
        schema: this.#schema,
        document: prepared.entry.document,
        operationName: request.operationName,
        variableValues: request.variables,
        contextValue: ctx,
        // undefined: no abort listener in graphql-js (one per execution otherwise)
        abortSignal: options.abortSignal ?? options.signal,
        hideSuggestions: this.#hideSuggestions,
      })
    } catch (error) {
      return Promise.reject(abortReason(error, options))
    }
    if (isPromise(result)) {
      return result.then(
        settled => this.#respond(settled, ctx),
        (error: unknown) => Promise.reject(abortReason(error, options)),
      )
    }
    return this.#respond(result, ctx)
  }

  /** The response of an execution result: as is without errors, formatted errors otherwise. */
  #respond(result: ExecutionResult, ctx: OperationContext): GraphQLResponse {
    const errors = result.errors
    if (errors === undefined) return { status: 200, result: result as FormattedExecutionResult }
    if (!('data' in result)) {
      // no data: graphql-js refused the variables before executing
      return { status: 400, result: { errors: errors.map(variableError) } }
    }
    return {
      status: 200,
      result: {
        data: result.data,
        errors: this.#formatter.format(errors, ctx),
        ...(result.extensions === undefined ? {} : { extensions: result.extensions }),
      },
    }
  }

  /** Formats a subscription result: an event, a source that could not start or failed (field errors). */
  formatEvent(result: ExecutionResult, ctx: OperationContext): FormattedExecutionResult {
    const errors = result.errors
    if (errors === undefined) return result as FormattedExecutionResult
    return {
      ...('data' in result ? { data: result.data } : {}),
      errors: this.#formatter.format(errors, ctx),
    }
  }

  /** {@link formatEvent} for the engine: the errors formatted, then given back as `GraphQLError` instances. */
  engineEvent(result: ExecutionResult, ctx: OperationContext): ExecutionResult {
    const errors = result.errors
    if (errors === undefined) return result
    return {
      ...('data' in result ? { data: result.data } : {}),
      errors: asGraphQLErrors(errors, this.#formatter.format(errors, ctx)),
    }
  }

  /**
   * Starts the source of a subscription. `engine`: the results are graphql-js results
   * ({@link engineEvent}) and a source that could not start is an error result instead of a stream
   * of one result.
   */
  #startSubscription(
    prepared: Prepared,
    request: GraphQLRequest,
    options: ExecuteOptions,
    ctx: OperationContext,
    observer: Observer | undefined,
    run: <R>(fn: () => R) => R,
    close: () => void,
    release: () => void,
    engine: boolean,
  ): Promise<Started> | Started {
    const validated = validateSubscriptionArgs({
      schema: this.#schema,
      document: prepared.entry.document,
      operationName: request.operationName,
      variableValues: request.variables,
      contextValue: ctx,
      abortSignal: options.signal,
      hideSuggestions: this.#hideSuggestions,
    })
    if (!('schema' in validated)) {
      return new Rejection(400, validated.map(variableError), prepared.entry.id, prepared.operation)
    }
    const start = (source: AsyncIterable<unknown> | ExecutionResult): Started => {
      // the reservation becomes the stream (counted in #streams), or ends with the failed start
      release()
      if (!isAsyncIterable(source)) {
        // the subscription could not start (guard, resolver error): one error result
        if (engine) {
          const result = this.engineEvent(source, ctx)
          close()
          observer?.end('error', result.errors)
          return result
        }
        const result = this.formatEvent(source, ctx)
        close()
        observer?.end('error', result.errors)
        return new SingleResultStream(result)
      }
      const stream = new SubscriptionStream<unknown>({
        executor: this,
        source: source[Symbol.asyncIterator](),
        validated,
        ctx,
        run,
        signal: options.signal,
        field: responseKey(prepared.operation),
        engine,
        onEnd: (outcome, errors) => {
          this.#streams.delete(stream)
          this.#owned.delete(stream)
          if (engine) this.#engineStreams.delete(stream)
          close()
          observer?.end(outcome, errors)
        },
      })
      this.#streams.add(stream)
      if (engine || ctx.transport === 'direct') this.#owned.add(stream)
      if (engine) {
        this.#engineStreams.add(stream)
        // stopped while its source started: ended at once
        if (this.#closing) void stream.return()
      }
      return stream as GraphQLResultStream | EngineStream
    }
    const source = createSourceEventStream(validated)
    return isPromise(source) ? source.then(start) : start(source)
  }

  // ------------------------------------------------------------------------------------------------
  // hook

  /** A rejection as a response, observed by the hook (outcome `rejected`). */
  #reject(
    rejection: Rejection,
    request: GraphQLRequest,
    options: ExecuteOptions,
  ): GraphQLResponse | Promise<GraphQLResponse> {
    const hooks = this.#hooks
    const wrapped = hooks.hasWrappers(OPERATION_HOOK)
    if (!wrapped && !hooks.hasListeners(OPERATION_HOOK)) return rejection.response()
    const event: GraphQLOperationEvent = {
      operationType: rejection.operationType,
      operationName:
        rejection.operationName ?? (typeof request?.operationName === 'string' ? request.operationName : undefined),
      documentId: rejection.documentId,
      transport: options.transport ?? 'direct',
      driver: options.driver ?? 'builtin',
      requestId: options.requestId ?? options.http?.requestId ?? this.#scopedRequestId(),
      context: undefined,
      startTime: performance.now(),
      outcome: 'rejected',
      errors: summaries(rejection.errors),
    }
    if (!wrapped) {
      hooks.emit(OPERATION_HOOK, event)
      return rejection.response()
    }
    return hooks
      .run(OPERATION_HOOK, event, () => Promise.resolve(rejection.response()))
      .then(response => {
        if (hooks.hasListeners(OPERATION_HOOK)) hooks.emit(OPERATION_HOOK, event)
        return response
      })
  }

  /** An executed query or mutation, observed by the hook. */
  #observed<T extends Settled>(ctx: OperationContext, id: string, run: () => T | Promise<T>): T | Promise<T> {
    const hooks = this.#hooks
    const event = operationEvent(ctx, id)
    const done = (response: T): T => {
      event.outcome = outcomeOf(response)
      if (response.result.errors !== undefined) event.errors = summaries(response.result.errors)
      return response
    }
    const failed = (error: unknown): never => {
      event.outcome = 'error'
      throw error
    }
    const emit = (): void => {
      if (hooks.hasListeners(OPERATION_HOOK)) hooks.emit(OPERATION_HOOK, event)
    }
    if (hooks.hasWrappers(OPERATION_HOOK)) {
      const promise = hooks.run(OPERATION_HOOK, event, () => Promise.resolve(run()).then(done, failed))
      return promise.then(
        response => {
          emit()
          return response
        },
        (error: unknown) => {
          emit()
          throw error
        },
      )
    }
    // listeners only: no promise added to a synchronous execution
    let response: T | Promise<T>
    try {
      response = run()
    } catch (error) {
      event.outcome = 'error'
      emit()
      throw error
    }
    if (!isPromise(response)) {
      done(response)
      emit()
      return response
    }
    return response.then(
      settled => {
        done(settled)
        emit()
        return settled
      },
      (error: unknown) => {
        event.outcome = 'error'
        emit()
        throw error
      },
    )
  }

  /** The hook of a subscription, for its whole life (`end()` settles it), or `undefined` without wrappers nor listeners. */
  #observer(ctx: OperationContext, id: string): Observer | undefined {
    const hooks = this.#hooks
    const wrapped = hooks.hasWrappers(OPERATION_HOOK)
    if (!wrapped && !hooks.hasListeners(OPERATION_HOOK)) return undefined
    const event = operationEvent(ctx, id)
    let resolve: (() => void) | undefined
    if (wrapped) {
      const ended = new Promise<void>(settle => {
        resolve = settle
      })
      hooks
        .run(OPERATION_HOOK, event, () => ended)
        .catch(error => this.#runtimeLogError('A "graphql:operation" hook wrapper failed', error))
    }
    let ended = false
    return {
      end: (outcome, errors) => {
        if (ended) return
        ended = true
        event.outcome = outcome
        if (errors !== undefined && errors.length > 0) event.errors = summaries(errors)
        resolve?.()
        if (hooks.hasListeners(OPERATION_HOOK)) hooks.emit(OPERATION_HOOK, event)
      },
    }
  }

  /** The request id of the enclosing scope (a controller calling GraphQL), or a new one. */
  #scopedRequestId(): string {
    const id = this.#container.currentScope()?.get(HttpTokens.RequestId)
    return typeof id === 'string' ? id : randomUUID()
  }

  #runtimeLogError(message: string, error: unknown): void {
    this.#logger.error(`GraphQLPlugin: ${message}`, { err: error })
  }
}

/** Settles the hook event of a subscription. */
interface Observer {
  end(
    outcome: NonNullable<GraphQLOperationEvent['outcome']>,
    errors: NonNullable<Settled['result']['errors']> | undefined,
  ): void
}

/** The 503 of a subscription past `subscriptions.maxActive`. */
function overflow(prepared: Prepared): Rejection {
  return new Rejection(
    503,
    [requestError('Too many active subscriptions, retry later', GraphQLErrorCode.ServiceUnavailable)],
    prepared.entry.id,
    prepared.operation,
  )
}

/** The 503 of an engine subscription past `subscriptions.maxActive`, or while the application stops. */
function unavailable(prepared: Prepared, closing: boolean): Rejection {
  if (!closing) return overflow(prepared)
  return new Rejection(
    503,
    [requestError('The server is shutting down, retry later', GraphQLErrorCode.ServiceUnavailable)],
    prepared.entry.id,
    prepared.operation,
  )
}

/** Whether `rules` are graphql-js `specifiedRules` (the same list, or a copy of it). */
function isSpecifiedRules(rules: readonly ValidationRule[]): boolean {
  if (rules === specifiedRules) return true
  if (rules.length !== specifiedRules.length) return false
  for (let index = 0; index < rules.length; index++) if (rules[index] !== specifiedRules[index]) return false
  return true
}

/** The request of engine arguments, for the hook of a rejection (its operation name). */
function requestOf(args: ExecutionArgs): GraphQLRequest {
  return { query: '', operationName: args.operationName }
}

function resultOf(response: EngineResponse): ExecutionResult {
  return response.result
}

/** `error` with `extensions.code` set to `code` (as is without code), without its original error. */
function coded(error: GraphQLError, code: string | undefined): GraphQLError {
  if (code === undefined) return error
  return new GraphQLErrorClass(error.message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
    extensions: { ...error.extensions, code },
  })
}

/**
 * The formatted errors of an execution as `GraphQLError` instances (RFC 0009 §4.2, rule 5): the
 * formatted message and extensions, the locations and path of the error they come from, no
 * `originalError` (servers such as Apollo Server wrap anything that is not an `Error`).
 */
function asGraphQLErrors(
  originals: readonly GraphQLError[],
  formatted: readonly GraphQLFormattedError[],
): GraphQLError[] {
  const errors: GraphQLError[] = new Array(formatted.length)
  for (let index = 0; index < formatted.length; index++) {
    const original = originals[index] as GraphQLError
    const shown = formatted[index] as GraphQLFormattedError
    errors[index] = new GraphQLErrorClass(shown.message, {
      nodes: original.nodes,
      source: original.source,
      positions: original.positions,
      path: original.path,
      extensions: shown.extensions,
    })
  }
  return errors
}

/** A request error (formatted, without location) as a `GraphQLError`. */
function fromFormatted(error: GraphQLFormattedError): GraphQLError {
  return new GraphQLErrorClass(error.message, { path: error.path, extensions: error.extensions })
}

/** A rejection answered to the engine: a result of `GraphQLError`s. */
function asEngineResult(
  response: GraphQLResponse | Promise<GraphQLResponse>,
): ExecutionResult | Promise<ExecutionResult> {
  const settle = (settled: GraphQLResponse): ExecutionResult => ({
    errors: (settled.result.errors ?? []).map(fromFormatted),
  })
  return isPromise(response) ? response.then(settle) : settle(response)
}

function noop(): void {}

function badRequest(message: string): Rejection {
  return new Rejection(400, [requestError(message, GraphQLErrorCode.BadRequest)], undefined)
}

function variableError(error: GraphQLError): GraphQLFormattedError {
  return withCode(error, error.extensions['code'] === undefined ? GraphQLErrorCode.BadUserInput : undefined)
}

/** graphql-js rejects with `AbortedGraphQLExecutionError`: callers get the reason of their signal. */
function abortReason(error: unknown, options: ExecuteOptions): unknown {
  const signal = options.abortSignal ?? options.signal
  if (error instanceof AbortedGraphQLExecutionError && signal?.aborted === true) return signal.reason
  return error
}

function operationEvent(ctx: OperationContext, id: string): GraphQLOperationEvent {
  return {
    operationType: ctx.operationType,
    operationName: ctx.operationName,
    documentId: id,
    transport: ctx.transport,
    driver: ctx.driver,
    requestId: ctx.requestId,
    context: ctx,
    startTime: performance.now(),
  }
}

function outcomeOf(response: Settled): NonNullable<GraphQLOperationEvent['outcome']> {
  if (response.status !== 200) return 'rejected'
  const result = response.result
  if (result.errors === undefined || result.errors.length === 0) return 'success'
  return result.data === null || result.data === undefined ? 'error' : 'partial'
}

function summaries(errors: NonNullable<Settled['result']['errors']>): NonNullable<GraphQLOperationEvent['errors']> {
  return errors.map(error => {
    const code = error.extensions?.['code']
    return {
      message: error.message,
      code: typeof code === 'string' ? code : undefined,
      ...(error.path === undefined ? {} : { path: error.path }),
    }
  })
}

/** The response key of the root field of a subscription (its single selection). */
function responseKey(operation: OperationDefinitionNode): string | undefined {
  const selection = operation.selectionSet.selections[0]
  return selection?.kind === Kind.FIELD ? (selection.alias ?? selection.name).value : undefined
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

/** A stream of one result (a query sent as a stream, a rejection for `plugin.subscribe()`). */
export function singleResult(result: FormattedExecutionResult): GraphQLResultStream {
  return new SingleResultStream(result)
}

/** The stream of a query or a mutation sent as a stream (SSE): its single result. */
class SingleResultStream implements GraphQLResultStream {
  #result: FormattedExecutionResult | undefined

  constructor(result: FormattedExecutionResult) {
    this.#result = result
  }

  next(): Promise<IteratorResult<FormattedExecutionResult>> {
    const result = this.#result
    if (result === undefined) return Promise.resolve(DONE)
    this.#result = undefined
    return Promise.resolve({ done: false, value: result })
  }

  return(): Promise<IteratorResult<FormattedExecutionResult>> {
    this.#result = undefined
    return Promise.resolve(DONE)
  }

  [Symbol.asyncIterator](): GraphQLResultStream {
    return this
  }
}

interface SubscriptionStreamInit {
  readonly executor: GraphQLExecutor
  readonly source: AsyncIterator<unknown>
  readonly validated: ValidatedSubscriptionArgs
  readonly ctx: OperationContext
  readonly run: <R>(fn: () => R) => R
  readonly signal: AbortSignal | undefined
  readonly field: string | undefined
  /** Results as graphql-js results with `GraphQLError` instances (the engine), or formatted. */
  readonly engine: boolean
  readonly onEnd: (
    outcome: NonNullable<GraphQLOperationEvent['outcome']>,
    errors: NonNullable<Settled['result']['errors']> | undefined,
  ) => void
}

/**
 * The results of a subscription: each source event executed with `executeSubscriptionEvent`, a
 * fresh per-execution state (loaders) and the operation's `GraphQLContext`. `R` is
 * `FormattedExecutionResult` for the transports (`GraphQLResultStream`), `ExecutionResult` for the
 * engine (`EngineStream`).
 *
 * The source is started at once: its first `next()` is requested when the stream is created, so
 * that a resolver written as an async generator (`for await (const x of pubsub.subscribe(...))`)
 * has subscribed when `subscribe()` resolves, whatever the transport and however late its consumer
 * reads (an SSE body pulled on demand). Only that first event is read ahead; the next ones are read
 * when the consumer asks (backpressure).
 */
class SubscriptionStream<R> implements AsyncIterableIterator<R> {
  readonly #init: SubscriptionStreamInit
  readonly #onAbort: (() => void) | undefined
  /** The first `next()` of the source, requested at creation and consumed by the first read. */
  #first: Promise<IteratorResult<unknown>> | undefined
  /** `next()` calls of the source still pending. */
  #reading = 0
  #ended = false
  #partial = false

  constructor(init: SubscriptionStreamInit) {
    this.#init = init
    const signal = init.signal
    if (signal !== undefined) {
      this.#onAbort = () => {
        void this.return()
      }
      signal.addEventListener('abort', this.#onAbort, { once: true })
    }
    const first = init.run(() => this.#read())
    // handled by the first read; ignored when the stream ends before it
    first.catch(noop)
    this.#first = first
    // the client may have left while the operation was starting (async guards): end at once
    if (signal?.aborted === true) void this.return()
  }

  next(): Promise<IteratorResult<R, void>> {
    if (this.#ended) return Promise.resolve(DONE as IteratorResult<R, void>)
    return this.#init.run(() => this.#pull())
  }

  /** The next event of the source. */
  async #read(): Promise<IteratorResult<unknown>> {
    this.#reading++
    try {
      return await this.#init.source.next()
    } finally {
      this.#reading--
    }
  }

  /** A result of the subscription, formatted for its consumer. */
  #format(result: ExecutionResult): R {
    const init = this.#init
    return (
      init.engine ? init.executor.engineEvent(result, init.ctx) : init.executor.formatEvent(result, init.ctx)
    ) as R
  }

  async #pull(): Promise<IteratorResult<R, void>> {
    const init = this.#init
    let step: IteratorResult<unknown>
    try {
      const first = this.#first
      this.#first = undefined
      step = await (first ?? this.#read())
    } catch (error) {
      if (this.#ended) return DONE as IteratorResult<R, void>
      // the source failed (MemoryPubSub overflow...): a final error result, then the end
      const result = this.#format({
        errors: [
          new GraphQLErrorClass(errorMessage(error), {
            originalError: asError(error),
            path: init.field === undefined ? undefined : [init.field],
          }),
        ],
      })
      this.#end('error', (result as Settled['result']).errors)
      return { done: false, value: result }
    }
    if (step.done === true || this.#ended) {
      this.#end(this.#partial ? 'partial' : 'success', undefined)
      return DONE as IteratorResult<R, void>
    }
    init.ctx.resetLoaders()
    const executed = executeSubscriptionEvent({ ...init.validated, rootValue: step.value })
    const result = this.#format(isPromise(executed) ? await executed : executed)
    if ((result as Settled['result']).errors !== undefined) this.#partial = true
    return { done: false, value: result }
  }

  async return(): Promise<IteratorResult<R, void>> {
    if (this.#ended) return DONE as IteratorResult<R, void>
    this.#first = undefined
    // ends ctx.signal: a source following it (MemoryPubSub, a generator iterating it) ends at once
    this.#end(this.#partial ? 'partial' : 'success', undefined)
    const reading = this.#reading > 0
    try {
      const returned = Promise.resolve(this.#init.source.return?.())
      // an async generator runs return() only once its pending next() settles, which a source
      // ignoring ctx.signal may never do: do not wait for it then
      if (reading) returned.catch(noop)
      else await returned
    } catch {
      // the source is gone either way
    }
    return DONE as IteratorResult<R, void>
  }

  throw(): Promise<IteratorResult<R, void>> {
    return this.return()
  }

  [Symbol.asyncIterator](): this {
    return this
  }

  /** `await using`: ends the stream (an `AsyncGenerator` is disposable). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.return()
  }

  #end(
    outcome: NonNullable<GraphQLOperationEvent['outcome']>,
    errors: NonNullable<Settled['result']['errors']> | undefined,
  ): void {
    if (this.#ended) return
    this.#ended = true
    if (this.#onAbort !== undefined) this.#init.signal?.removeEventListener('abort', this.#onAbort)
    this.#init.onEnd(outcome, errors)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
