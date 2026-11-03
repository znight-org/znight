/**
 * The implementation of `GraphQLContext` (RFC 0005 §5.8): one per operation, passed to graphql-js
 * as `contextValue` and stored in the request scope (`@znight/graphql#GraphQLContext`).
 *
 * Everything that is not needed by every operation is computed on first read: the request id (a
 * UUID for direct executions), the HTTP context of an enclosing request, the signal, the state map
 * and the loader registry.
 */
import type { Container, ScopeContext, Token } from '@znight/core'
import type { HttpContext } from '@znight/http'
import type { DocumentNode, OperationDefinitionNode } from 'graphql'
import type { LoaderFactory } from './loaders.ts'
import type {
  BatchLoad,
  BatchLoadClass,
  BatchLoader,
  GraphQLContext,
  GraphQLOperationKind,
  GraphQLTransport,
  LoaderKey,
  LoaderValue,
} from './types.ts'

import { randomUUID } from 'node:crypto'
import { ErrorCode, ZnightError } from '@znight/core'
import { HttpTokens } from '@znight/http'

/** What every operation context of a plugin shares. */
export interface ContextRuntime {
  readonly container: Container
  readonly loaders: LoaderFactory
  /** The plugin's own signal (aborted by `onStop`): the signal of direct executions. */
  readonly signal: AbortSignal
}

/** What a request carries that the context exposes (a `GraphQLRequest`). */
export interface ContextRequest {
  readonly variables?: Readonly<Record<string, unknown>> | null | undefined
}

/** How the request reached the executor (`ExecuteOptions`). */
export interface ContextOptions {
  readonly transport?: GraphQLTransport
  readonly http?: HttpContext
  readonly signal?: AbortSignal
  readonly requestId?: string
}

const NO_VARIABLES: Readonly<Record<string, unknown>> = Object.freeze({})

/**
 * The `GraphQLContext` of one operation. Built from references the executor already holds (the
 * operation node, the request, the options, the enclosing scope): one allocation per operation,
 * every field read on demand.
 */
export class OperationContext implements GraphQLContext {
  readonly document: DocumentNode
  readonly #runtime: ContextRuntime
  readonly #operation: OperationDefinitionNode
  readonly #request: ContextRequest
  readonly #options: ContextOptions
  readonly #scope: ScopeContext | undefined
  #requestId: string | undefined
  #http: HttpContext | null | undefined
  #signal: AbortSignal | undefined
  #ended: AbortSignal | undefined
  #state: Map<string | symbol, unknown> | undefined
  #loaders: Map<Token, BatchLoader<unknown, unknown>> | undefined

  constructor(
    runtime: ContextRuntime,
    document: DocumentNode,
    operation: OperationDefinitionNode,
    request: ContextRequest,
    options: ContextOptions,
    scope: ScopeContext | undefined,
  ) {
    this.#runtime = runtime
    this.document = document
    this.#operation = operation
    this.#request = request
    this.#options = options
    this.#scope = scope
    this.#requestId = options.requestId
  }

  get transport(): GraphQLTransport {
    return this.#options.transport ?? 'direct'
  }

  get operationType(): GraphQLOperationKind {
    return this.#operation.operation
  }

  get operationName(): string | undefined {
    return this.#operation.name?.value
  }

  get requestId(): string {
    let id = this.#requestId
    if (id === undefined) {
      const http = this.http
      const scoped = http === undefined ? this.#scope?.get(HttpTokens.RequestId) : undefined
      id = http?.requestId ?? (typeof scoped === 'string' ? scoped : randomUUID())
      this.#requestId = id
    }
    return id
  }

  get http(): HttpContext | undefined {
    let http = this.#http
    if (http === undefined) {
      // a controller calling plugin.execute(): the HTTP request of the enclosing scope
      http = this.#options.http ?? this.#scope?.get(HttpTokens.Context) ?? null
      this.#http = http
    }
    return http ?? undefined
  }

  get variables(): Readonly<Record<string, unknown>> {
    return this.#request.variables ?? NO_VARIABLES
  }

  get signal(): AbortSignal {
    let signal = this.#signal
    if (signal === undefined) {
      // HttpContext.signal is created on first read: only read it when someone asks
      const base = this.#options.signal ?? this.http?.signal ?? this.#runtime.signal
      const ended = this.#ended
      signal = ended === undefined ? base : AbortSignal.any([base, ended])
      this.#signal = signal
    }
    return signal
  }

  /**
   * Ties {@link signal} to the end of a subscription: it also aborts when `ended` does (the stream
   * ended by itself or with `return()`). Called before any resolver runs.
   */
  endsWith(ended: AbortSignal): void {
    this.#ended = ended
  }

  get state(): Map<string | symbol, unknown> {
    this.#state ??= new Map()
    return this.#state
  }

  loader<L extends BatchLoad<unknown, unknown>>(loader: BatchLoadClass<L>): BatchLoader<LoaderKey<L>, LoaderValue<L>>
  loader(token: Token): BatchLoader<unknown, unknown>
  loader(key: Token | BatchLoadClass): BatchLoader<unknown, unknown> {
    const token = typeof key === 'string' ? key : this.#tokenOf(key)
    let loaders = this.#loaders
    if (loaders === undefined) {
      loaders = new Map()
      this.#loaders = loaders
    }
    let loader = loaders.get(token)
    if (loader === undefined) {
      loader = this.#runtime.loaders.create(token)
      loaders.set(token, loader)
    }
    return loader
  }

  /** Starts a new execution (a subscription event): loaders and their caches are renewed. */
  resetLoaders(): void {
    this.#loaders = undefined
  }

  #tokenOf(loader: BatchLoadClass): Token {
    const token = typeof loader === 'function' ? this.#runtime.container.tokenOf(loader) : undefined
    if (token === undefined) {
      const name = typeof loader === 'function' ? loader.name || '<anonymous>' : String(loader)
      throw new ZnightError(ErrorCode.MissingProvider, `GraphQLContext.loader(): ${name} is not a provider`, {
        hints: ['Add @Injectable() to the loader class (it implements BatchLoad<K, V>)'],
      })
    }
    return token
  }
}
