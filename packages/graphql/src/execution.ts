/**
 * Execution (RFC 0005 §8.4, §8.7–§8.10): the document cache, request checks, operation selection,
 * graphql-js `execute` and subscriptions, error formatting and the `graphql:operation` hook.
 *
 * `GraphQLExecutor` is the internal API of the transports (`plugin.execute()`, GraphQL over HTTP
 * and SSE): `execute()` answers a request with a status and a formatted result, `subscribe()` with
 * a stream of formatted results (or a rejection).
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
  ExecutionResult,
  FormattedExecutionResult,
  GraphQLError,
  GraphQLFormattedError,
  GraphQLSchema,
  OperationDefinitionNode,
  ValidatedSubscriptionArgs,
  ValidationRule,
} from 'graphql'
import type { ContextRuntime } from './context.ts'
import type { ErrorFormatter } from './format.ts'
import type { DocumentLimits } from './limits.ts'
import type { GraphQLOperationKind, GraphQLTransport } from './types.ts'

import { createHash, randomUUID } from 'node:crypto'
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
  specifiedRules,
  validate,
  validateSubscriptionArgs,
} from 'graphql'

import { OperationContext } from './context.ts'
import { GraphQLErrorCode } from './errors.ts'
import { requestError, withCode } from './format.ts'
import { checkLimits } from './limits.ts'
import { GraphQLTokens } from './tokens.ts'

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
}

const OPERATION_HOOK = 'graphql:operation'
const DIRECT: ExecuteOptions = Object.freeze({})
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
  readonly #streams = new Set<SubscriptionStream>()
  readonly #direct = new Set<SubscriptionStream>()
  /** Subscriptions counted against `maxActive` while their source starts (not yet in `#streams`). */
  #starting = 0

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
    const limited = this.#maxActive !== undefined
    if (limited && this.#streams.size + this.#starting >= (this.#maxActive as number)) {
      return this.#reject(
        new Rejection(
          503,
          [requestError('Too many active subscriptions, retry later', GraphQLErrorCode.ServiceUnavailable)],
          prepared.entry.id,
          prepared.operation,
        ),
        request,
        options,
      )
    }
    // the slot is reserved before the source starts (guards and subscribe methods may be async):
    // concurrent subscriptions see it; released once the stream is counted or did not start
    let reserved = limited
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
        this.#startSubscription(prepared, request, options, ctx, observer, run, close, release),
      )
      release()
      if (stream instanceof Rejection) {
        close()
        observer?.end('rejected', stream.errors)
        return stream.response()
      }
      return stream
    } catch (error) {
      release()
      close()
      observer?.end('error', undefined)
      throw error
    }
  }

  /** Ends every subscription started with `transport: 'direct'` (plugin `onStop`). */
  async stopDirect(): Promise<void> {
    await Promise.all([...this.#direct].map(stream => stream.return()))
  }

  /** Forgets every cached document. */
  clear(): void {
    this.#cache.clear()
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

  #startSubscription(
    prepared: Prepared,
    request: GraphQLRequest,
    options: ExecuteOptions,
    ctx: OperationContext,
    observer: Observer | undefined,
    run: <R>(fn: () => R) => R,
    close: () => void,
    release: () => void,
  ): Promise<GraphQLResultStream | Rejection> | GraphQLResultStream | Rejection {
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
    const start = (source: AsyncIterable<unknown> | ExecutionResult): GraphQLResultStream => {
      // the reservation becomes the stream (counted in #streams), or ends with the failed start
      release()
      if (!isAsyncIterable(source)) {
        // the subscription could not start (guard, resolver error): one error result
        const result = this.formatEvent(source, ctx)
        close()
        observer?.end('error', result.errors)
        return new SingleResultStream(result)
      }
      const stream = new SubscriptionStream({
        executor: this,
        source: source[Symbol.asyncIterator](),
        validated,
        ctx,
        run,
        signal: options.signal,
        field: responseKey(prepared.operation),
        onEnd: (outcome, errors) => {
          this.#streams.delete(stream)
          this.#direct.delete(stream)
          close()
          observer?.end(outcome, errors)
        },
      })
      this.#streams.add(stream)
      if (ctx.transport === 'direct') this.#direct.add(stream)
      return stream
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
  #observed(
    ctx: OperationContext,
    id: string,
    run: () => GraphQLResponse | Promise<GraphQLResponse>,
  ): GraphQLResponse | Promise<GraphQLResponse> {
    const hooks = this.#hooks
    const event = operationEvent(ctx, id)
    const done = (response: GraphQLResponse): GraphQLResponse => {
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
    let response: GraphQLResponse | Promise<GraphQLResponse>
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
    errors: readonly GraphQLFormattedError[] | undefined,
  ): void
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
    requestId: ctx.requestId,
    context: ctx,
    startTime: performance.now(),
  }
}

function outcomeOf(response: GraphQLResponse): NonNullable<GraphQLOperationEvent['outcome']> {
  if (response.status !== 200) return 'rejected'
  const result = response.result
  if (result.errors === undefined || result.errors.length === 0) return 'success'
  return result.data === null || result.data === undefined ? 'error' : 'partial'
}

function summaries(errors: readonly GraphQLFormattedError[]): NonNullable<GraphQLOperationEvent['errors']> {
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
  readonly onEnd: (
    outcome: NonNullable<GraphQLOperationEvent['outcome']>,
    errors: readonly GraphQLFormattedError[] | undefined,
  ) => void
}

/**
 * The results of a subscription: each source event executed with `executeSubscriptionEvent`, a
 * fresh per-execution state (loaders) and the operation's `GraphQLContext`.
 *
 * The source is started at once: its first `next()` is requested when the stream is created, so
 * that a resolver written as an async generator (`for await (const x of pubsub.subscribe(...))`)
 * has subscribed when `subscribe()` resolves, whatever the transport and however late its consumer
 * reads (an SSE body pulled on demand). Only that first event is read ahead; the next ones are read
 * when the consumer asks (backpressure).
 */
class SubscriptionStream implements GraphQLResultStream {
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
  }

  next(): Promise<IteratorResult<FormattedExecutionResult>> {
    if (this.#ended) return Promise.resolve(DONE)
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

  async #pull(): Promise<IteratorResult<FormattedExecutionResult>> {
    const init = this.#init
    let step: IteratorResult<unknown>
    try {
      const first = this.#first
      this.#first = undefined
      step = await (first ?? this.#read())
    } catch (error) {
      if (this.#ended) return DONE
      // the source failed (MemoryPubSub overflow...): a final error result, then the end
      const result = init.executor.formatEvent(
        {
          errors: [
            new GraphQLErrorClass(errorMessage(error), {
              originalError: asError(error),
              path: init.field === undefined ? undefined : [init.field],
            }),
          ],
        },
        init.ctx,
      )
      this.#end('error', result.errors)
      return { done: false, value: result }
    }
    if (step.done === true || this.#ended) {
      this.#end(this.#partial ? 'partial' : 'success', undefined)
      return DONE
    }
    init.ctx.resetLoaders()
    const executed = executeSubscriptionEvent({ ...init.validated, rootValue: step.value })
    const result = init.executor.formatEvent(isPromise(executed) ? await executed : executed, init.ctx)
    if (result.errors !== undefined) this.#partial = true
    return { done: false, value: result }
  }

  async return(): Promise<IteratorResult<FormattedExecutionResult>> {
    if (this.#ended) return DONE
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
    return DONE
  }

  throw(): Promise<IteratorResult<FormattedExecutionResult>> {
    return this.return()
  }

  [Symbol.asyncIterator](): GraphQLResultStream {
    return this
  }

  #end(
    outcome: NonNullable<GraphQLOperationEvent['outcome']>,
    errors: readonly GraphQLFormattedError[] | undefined,
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
