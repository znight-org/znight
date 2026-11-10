import type { CoreLogger } from './logger.ts'

import { isThenable } from './utils.ts'

/**
 * Typed registry of hook names and their event types. Third-party packages may augment it:
 *
 * ```ts
 * declare module '@znight/core' {
 *   interface ZnightHooks {
 *     'http:request': HttpRequestEvent
 *   }
 * }
 * ```
 */
export interface ZnightHooks {
  /** One HTTP request handled by `@znight/http` (wrapped with `hooks.run`). */
  'http:request': HttpRequestEvent
  /** One message delivery handled by `@znight/messaging` (wrapped with `hooks.run`). */
  'messaging:message': MessageDeliveryEvent
  /** One message published through `MessageBroker` of `@znight/messaging` (wrapped with `hooks.run`). */
  'messaging:publish': MessagePublishEvent
  /**
   * One occurrence of a job of `@znight/schedule`: executed runs are wrapped with `hooks.run`, then
   * emitted; occurrences that do not execute (`skipped`, `not-acquired`, a lock store failure) are
   * only emitted. In the wrappers, `outcome` stays `undefined` when the job did not start (veto,
   * drop, a wrapper that threw first): see `ScheduledRunEvent.outcome`.
   */
  'schedule:run': ScheduledRunEvent
  /**
   * One GraphQL operation handled by `@znight/graphql` (RFC 0005): a query or a mutation, or a whole
   * subscription from its start to its end. Wrapped with `hooks.run` when wrappers exist, then
   * emitted when listeners exist.
   */
  'graphql:operation': GraphQLOperationEvent
  /**
   * One inbound WebSocket message handled by `@znight/websocket` (RFC 0003): wrapped with
   * `hooks.run` when wrappers exist, then emitted when listeners exist. `$ping` frames do not run it.
   */
  'websocket:message': WebSocketMessageEvent
  /** A WebSocket connection of `@znight/websocket` opened or closed (emitted only). */
  'websocket:connection': WebSocketConnectionEvent
  /**
   * One publication of `@znight/events` (`EventPublisher.publish()` or `emit()`) that matched at least
   * one listener (RFC 0011): wraps the inline phase with `hooks.run` when wrappers exist, then is
   * emitted when listeners exist. A publication without listener produces nothing.
   */
  'events:publish': EventPublishEvent
  /**
   * One listener invocation of `@znight/events` (RFC 0011), inline or detached: wrapped with
   * `hooks.run` when wrappers exist, then emitted when listeners exist.
   */
  'events:listener': EventListenerEvent
  /**
   * An error the framework turned into a failure (a 5xx response, a failed delivery or run, a
   * detached listener or lifecycle failure): the cross-cutting hook of error reporters (Sentry...).
   * Emitted only (never wrapped), once per error, and only when listeners exist. Expected client
   * errors (4xx, validation, rejected GraphQL operations) are not reported.
   */
  'error:report': ErrorReportEvent
}

/** Where a reported error comes from (`ErrorReportEvent.source`). */
export type ErrorReportSource = 'http' | 'messaging' | 'schedule' | 'graphql' | 'websocket' | 'events' | 'lifecycle'

/**
 * Event of the `error:report` hook: one error the framework turned into a failure, reported by the
 * package that produced the failure. Each package already logs these errors: the hook adds no log
 * entry, it lets a reporter (Sentry, Bugsnag, Rollbar...) capture them with their context.
 */
export interface ErrorReportEvent {
  /** What was thrown or rejected with (the original error, not a wrapper, except for `lifecycle`). */
  readonly error: unknown
  readonly source: ErrorReportSource
  /**
   * Name of the failed operation, suitable as a transaction name: `GET /users/:id`, `orders`
   * (queue), `digest.daily` (job), `query Viewer`, `/chat message`, `UserCreated → Mail.send`,
   * `Plugin "db" onStop()`.
   */
  readonly operation: string
  /** Request id of the HTTP request, GraphQL operation or WebSocket handshake; `undefined` otherwise. */
  readonly requestId: string | undefined
  /** Flat tags describing the operation; the keys of each source are listed in the specification (§8.3). */
  readonly tags: Readonly<Record<string, string | number>>
  /**
   * The producer's context: `HttpContext` (`http`), `InboundMessage` (`messaging`), `JobContext`
   * (`schedule`), `GraphQLContext` (`graphql`), `WsMessageContext` (`websocket`); `undefined` for
   * `events` and `lifecycle`.
   */
  readonly context: unknown
}

/**
 * Instrumentation event of the `http:request` hook. Defined in core so that producers
 * (`@znight/http`) and observers (`@znight/observability`, user plugins) share one type.
 * Mutable fields are filled in by the producer while the request is processed.
 */
export interface HttpRequestEvent {
  readonly method: string
  /** Request path, without query string. */
  readonly path: string
  /** Matched route pattern (e.g. `/users/:id`), `undefined` when no route matched. */
  readonly route: string | undefined
  readonly requestId: string
  /** Lower-cased request headers. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** Adapter-neutral context (`HttpContext` from `@znight/http`). */
  readonly context: unknown
  /** `performance.now()` when the request started. */
  readonly startTime: number
  /** Final response status, set before `hooks.run` resolves. */
  status?: number
  /** Error thrown by the pipeline, if any (already mapped to `status`). */
  error?: unknown
  /** Response headers to add (e.g. trace context). */
  readonly responseHeaders: Record<string, string>
}

/**
 * Instrumentation event of the `messaging:publish` hook. Wrappers may add headers (e.g. W3C trace
 * context) before calling `next()`: they are sent with the message.
 */
export interface MessagePublishEvent {
  readonly queue: string
  readonly type: string | undefined
  readonly messageId: string
  /** Headers sent with the message (mutable until `next()` is called). */
  readonly headers: Record<string, string>
  /** `performance.now()` when the publication started. */
  readonly startTime: number
  /** Publication error, set before `next()` rejects in the wrappers. */
  error?: unknown
}

/** Instrumentation event of the `messaging:message` hook. */
export interface MessageDeliveryEvent {
  readonly queue: string
  readonly type: string | undefined
  readonly messageId: string
  /** 1-based delivery attempt. */
  readonly attempt: number
  readonly headers: Readonly<Record<string, string>>
  /** Display name of the consumer class. */
  readonly consumer: string
  /** Handler method, `undefined` when no handler matched. */
  readonly handler: string | undefined
  /** `InboundMessage` from `@znight/messaging`. */
  readonly message: unknown
  readonly startTime: number
  /** Outcome set before `hooks.run` resolves. */
  outcome?: 'ack' | 'retry' | 'dead-letter'
  error?: unknown
}

/** Outcome of an inbound WebSocket message (`WebSocketMessageEvent.outcome`). */
export type WebSocketMessageOutcome = 'ok' | 'error' | 'rejected' | 'unhandled' | 'timeout'

/** Who closed a WebSocket connection (`WsCloseInfo.initiator` of `@znight/websocket`). */
export type WebSocketCloseInitiator = 'client' | 'server' | 'shutdown' | 'heartbeat' | 'backpressure' | 'error'

/**
 * Instrumentation event of the `websocket:message` hook (RFC 0003 §8.10), one per inbound message
 * of a gateway. `outcome` and `error` are set before `hooks.run` resolves.
 */
export interface WebSocketMessageEvent {
  /** Display name of the gateway class. */
  readonly gateway: string
  /** Gateway path pattern, HTTP prefix included (`/api/chat`). */
  readonly path: string
  /** Event name (`events` gateways); `undefined` on `raw` gateways or for an undecodable frame. */
  readonly event: string | undefined
  /** Handler method; `undefined` when no handler matched. */
  readonly handler: string | undefined
  readonly connectionId: string
  /** The request id of the handshake. */
  readonly requestId: string
  /** Size of the frame, in bytes (characters for a text frame). */
  readonly bytes: number
  /** `WsMessageContext` from `@znight/websocket`. */
  readonly context: unknown
  /** `performance.now()` when the message was dispatched. */
  readonly startTime: number
  outcome?: WebSocketMessageOutcome
  error?: unknown
}

/** Instrumentation event of the `websocket:connection` hook (RFC 0003 §8.10). */
export interface WebSocketConnectionEvent {
  readonly type: 'open' | 'close'
  /** Display name of the gateway class. */
  readonly gateway: string
  /** Gateway path pattern, HTTP prefix included. */
  readonly path: string
  readonly connectionId: string
  /** The request id of the handshake. */
  readonly requestId: string
  /** `WsConnection` from `@znight/websocket`. */
  readonly connection: unknown
  /** `performance.now()` when the connection opened. */
  readonly openedAt: number
  /** Close code (`close` events). */
  readonly code?: number
  readonly reason?: string
  readonly initiator?: WebSocketCloseInitiator
  /** Messages received and sent by the connection (`close` events). */
  readonly messagesIn?: number
  readonly messagesOut?: number
}

/** How a scheduled run was triggered (`ScheduledRunEvent.trigger`). */
export type ScheduledRunTrigger = 'schedule' | 'start' | 'manual' | 'queued'

/** Outcome of a scheduled run (`ScheduledRunEvent.outcome`). */
export type ScheduledRunOutcome = 'completed' | 'failed' | 'skipped' | 'not-acquired'

/** Why a scheduled run was aborted (`ScheduledRunEvent.aborted`, the `reason` of `JobAbortedError`). */
export type ScheduledRunAbortReason = 'timeout' | 'lock-lost' | 'removed' | 'shutdown'

/**
 * Instrumentation event of the `schedule:run` hook, produced by `@znight/schedule` for every
 * occurrence of a job. Mutable fields are filled in by the producer.
 *
 * - **Listeners** (`hooks.on`) always see the final {@link ScheduledRunEvent.outcome}: the event is
 *   emitted once the occurrence is settled.
 * - **Occurrences that never reach the wrappers** (`context` is `undefined`: skipped by the overlap
 *   policy, `not-acquired`, a lock store failure, dropped while the lock lease was acquired) are
 *   only emitted, with their `outcome`.
 * - **Runs handed to the job** (`context` is set) are wrapped with `hooks.run`, where `outcome` is
 *   only known once the job settled, and stays `undefined` when the job did not start: see
 *   {@link ScheduledRunEvent.outcome} for what a wrapper reads after `next()`.
 */
export interface ScheduledRunEvent {
  /** Job name (`digest.daily`, `OutboxJobs.flush`). */
  readonly job: string
  readonly kind: 'cron' | 'interval' | 'timeout'
  /** Display name of the host class; `undefined` for dynamic jobs. */
  readonly host: string | undefined
  /** Job method; `undefined` for dynamic jobs. */
  readonly method: string | undefined
  /** Unique id of the run. */
  readonly runId: string
  readonly trigger: ScheduledRunTrigger
  /** Epoch milliseconds of the occurrence (scheduler clock). */
  readonly scheduledAt: number
  /**
   * `JobContext` from `@znight/schedule`; `undefined` for an occurrence that never reached the
   * wrappers (set for a run vetoed or dropped by the wrappers).
   */
  readonly context: unknown
  /** `performance.now()` when the run started, or was dropped. */
  readonly startTime: number
  /**
   * Outcome of the run. Listeners always see it. In a `hooks.run` wrapper, it is `undefined` until
   * the job settles, then:
   *
   * - `'completed'` when `next()` resolves after the job ran;
   * - `'failed'`, with {@link ScheduledRunEvent.error}, when `next()` rejects because the job threw;
   * - still `undefined` when the job never started: a wrapper returned without calling `next()` (a
   *   veto: `next()` of the outer wrappers resolves), the run was dropped while the wrappers waited
   *   (the job was removed or paused, the scheduler stops: `next()` resolves, `aborted` may be set),
   *   or a wrapper threw before calling `next()` (`next()` of the outer wrappers rejects with that
   *   error).
   *
   * The producer settles an `undefined` outcome after `hooks.run`: `'skipped'` for a veto or a
   * drop, `'failed'` (with `error`) when a wrapper, or the opening of the run scope, threw before the
   * job (a wrapper that swallows that rejection turns it into `'skipped'`: rethrow it). A wrapper
   * that fails after `next()` does not change the outcome of the job (the scheduler logs that error
   * on its own). A wrapper that reports the outcome reads
   * `event.outcome ?? (nextRejected ? 'failed' : 'skipped')`.
   */
  outcome?: ScheduledRunOutcome
  /**
   * What the job threw or rejected with (`failed`), what a wrapper threw before the job (set after
   * `hooks.run`), or the lock store failure.
   */
  error?: unknown
  /** Set when the run's signal was aborted. */
  aborted?: ScheduledRunAbortReason
}

/** Type of a GraphQL operation (`GraphQLOperationEvent.operationType`). */
export type GraphQLOperationType = 'query' | 'mutation' | 'subscription'

/**
 * How a GraphQL operation reached the server (`GraphQLOperationEvent.transport`): GraphQL over HTTP,
 * GraphQL over Server-Sent Events, GraphQL over WebSocket (`ws`, reserved for `graphql-ws`), or a
 * direct call (`execute()` / `subscribe()` of the plugin).
 */
export type GraphQLOperationTransport = 'http' | 'sse' | 'ws' | 'direct'

/**
 * Outcome of a GraphQL operation (`GraphQLOperationEvent.outcome`):
 *
 * - `'success'`: executed, no error;
 * - `'partial'`: executed, with data and field errors;
 * - `'error'`: executed, without data (a non-null root field failed, or the execution threw);
 * - `'rejected'`: never executed (parse, validation, variable coercion or limit errors).
 */
export type GraphQLOperationOutcome = 'success' | 'partial' | 'error' | 'rejected'

/** One error of a GraphQL response, as sent to the client (masked when it is unexpected). */
export interface GraphQLOperationError {
  readonly message: string
  /** `extensions.code` of the error (`FORBIDDEN`, `GRAPHQL_PARSE_FAILED`...). */
  readonly code: string | undefined
  /** Response path of the field that failed; absent for request errors. */
  readonly path?: readonly (string | number)[]
}

/**
 * Instrumentation event of the `graphql:operation` hook, produced by `@znight/graphql` (RFC 0005)
 * once per operation. For a subscription, it covers its whole life: wrappers see it start, and
 * `outcome` is set when it ends. Mutable fields are filled in by the producer before `hooks.run`
 * resolves; listeners see the final values.
 */
export interface GraphQLOperationEvent {
  /** `undefined` when the request was rejected before an operation was selected (parse error...). */
  readonly operationType: GraphQLOperationType | undefined
  /** `undefined` for an anonymous operation, or when none was selected. */
  readonly operationName: string | undefined
  /** SHA-256 (hex) of the query text, cached with the parsed document; `undefined` without a query. */
  readonly documentId: string | undefined
  readonly transport: GraphQLOperationTransport
  /**
   * The GraphQL driver that received the operation (RFC 0009): `'builtin'` for the built-in
   * transport and for direct calls, `'yoga'`, `'apollo'` or a third-party driver's name otherwise.
   */
  readonly driver: string
  readonly requestId: string
  /** `GraphQLContext` from `@znight/graphql`. */
  readonly context: unknown
  /** `performance.now()` when the operation started. */
  readonly startTime: number
  /** Outcome, set before `hooks.run` resolves. */
  outcome?: GraphQLOperationOutcome
  /** Errors of the response (field and request errors), set before `hooks.run` resolves. */
  errors?: readonly GraphQLOperationError[]
}

/** How an application event was published (`EventPublishEvent.mode`). */
export type EventPublishMode = 'publish' | 'emit'

/**
 * Instrumentation event of the `events:publish` hook, produced by `@znight/events` (RFC 0011) for a
 * publication that matched at least one listener. The wrappers surround the inline phase (the
 * detached listeners are scheduled after it succeeded); `error` and `failedListener` are set before
 * `next()` rejects.
 */
export interface EventPublishEvent {
  /** Class name of the event (`UserCreated`). */
  readonly event: string
  /** The published object. */
  readonly payload: object
  readonly mode: EventPublishMode
  /** Number of inline listeners matched. */
  readonly inline: number
  /** Number of detached listeners matched. */
  readonly detached: number
  /** `performance.now()` when the publication started. */
  readonly startTime: number
  /** First inline error, set before `next()` rejects in the wrappers. */
  error?: unknown
  /** `Class.method` of the inline listener that failed. */
  failedListener?: string
}

/**
 * Instrumentation event of the `events:listener` hook, produced by `@znight/events` (RFC 0011) for
 * every listener invocation. Inline listeners run in the publisher's async context, detached ones in
 * a fresh scope of their own; `error` is set before `next()` rejects.
 */
export interface EventListenerEvent {
  /** Class name of the event. */
  readonly event: string
  /** The published object. */
  readonly payload: object
  /** `Class.method` of the listener (`WelcomeMail.send`). */
  readonly listener: string
  readonly detached: boolean
  /** `performance.now()` when the invocation started. */
  readonly startTime: number
  /** What the listener threw or rejected with. */
  error?: unknown
}

/** Name of a declared hook. */
export type HookName = keyof ZnightHooks

/** Event type of hook `K`. */
export type HookEvent<K extends HookName> = ZnightHooks[K]

/** Observer of a hook. Errors (thrown or rejected) are reported to the logger, never to the emitter. */
export type HookListener<K extends HookName> = (event: HookEvent<K>) => unknown

/**
 * Middleware around a hooked operation (`hooks.run()`). Must call `next()` to run the inner
 * wrappers and the operation; `next()` resolves with the operation's result. The value returned by
 * the wrapper itself is ignored.
 */
export type HookWrapper<K extends HookName> = (event: HookEvent<K>, next: () => Promise<unknown>) => Promise<unknown>

export interface HooksOptions {
  /** Receives listener failures. Default: the console. */
  readonly logger?: CoreLogger
}

type AnyListener = (event: unknown) => unknown
type AnyWrapper = (event: unknown, next: () => Promise<unknown>) => unknown

const EMPTY: readonly never[] = Object.freeze([])

/**
 * Lightweight, typed event bus used by plugins to observe (`on`/`emit`) and wrap (`wrap`/`run`)
 * framework operations (`http:request`, `messaging:message`...). Registration is copy-on-write, so
 * emitting allocates nothing.
 */
export class Hooks {
  readonly #listeners = new Map<PropertyKey, readonly AnyListener[]>()
  readonly #wrappers = new Map<PropertyKey, readonly AnyWrapper[]>()
  readonly #logger: CoreLogger | undefined

  constructor(options: HooksOptions = {}) {
    this.#logger = options.logger
  }

  /** Adds a listener. Returns a function removing it (idempotent). */
  on<K extends HookName>(name: K, listener: HookListener<K>): () => void {
    return add(this.#listeners, name, listener as AnyListener)
  }

  /**
   * Calls every listener of `name` synchronously, in registration order. A failing listener
   * (thrown error or rejected promise) is reported to the logger and does not affect the others.
   */
  emit<K extends HookName>(name: K, event: HookEvent<K>): void {
    const listeners = this.#listeners.get(name)
    if (listeners === undefined) return
    for (const listener of listeners) {
      try {
        const result = listener(event)
        if (isThenable(result)) result.then(undefined, error => this.#report(name, error))
      } catch (error) {
        this.#report(name, error)
      }
    }
  }

  /** Adds a wrapper around operations run with {@link run}. Returns a function removing it (idempotent). */
  wrap<K extends HookName>(name: K, wrapper: HookWrapper<K>): () => void {
    return add(this.#wrappers, name, wrapper as AnyWrapper)
  }

  /**
   * Runs `fn` through the wrappers of `name` (onion model: the first registered wrapper is the
   * outermost) and resolves with the result of `fn`. Without wrappers, `fn` is called directly.
   * If a wrapper does not call `next()`, `fn` does not run and the promise resolves with `undefined`.
   */
  run<K extends HookName, R>(name: K, event: HookEvent<K>, fn: () => Promise<R>): Promise<R> {
    const wrappers = this.#wrappers.get(name) ?? EMPTY
    if (wrappers.length === 0) {
      try {
        return Promise.resolve(fn())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    let result: R | undefined
    const dispatch = async (index: number): Promise<unknown> => {
      if (index === wrappers.length) {
        result = await fn()
        return result
      }
      const wrapper = wrappers[index] as AnyWrapper
      await wrapper(event, () => dispatch(index + 1))
      return result
    }
    return dispatch(0).then(() => result as R)
  }

  /** Whether `name` has listeners (lets emitters skip building costly events). */
  hasListeners(name: HookName): boolean {
    return (this.#listeners.get(name)?.length ?? 0) > 0
  }

  /** Whether `name` has wrappers. */
  hasWrappers(name: HookName): boolean {
    return (this.#wrappers.get(name)?.length ?? 0) > 0
  }

  #report(name: PropertyKey, error: unknown): void {
    const message = `Hook listener for "${String(name)}" failed`
    if (this.#logger === undefined) console.error(`[znight] ${message}`, error)
    else this.#logger.error(message, { hook: String(name), err: error })
  }
}

function add<F>(registry: Map<PropertyKey, readonly F[]>, name: PropertyKey, fn: F): () => void {
  registry.set(name, [...(registry.get(name) ?? EMPTY), fn])
  let active = true
  return () => {
    if (!active) return
    active = false
    const current = registry.get(name) ?? EMPTY
    const index = current.indexOf(fn)
    if (index === -1) return
    const next = [...current.slice(0, index), ...current.slice(index + 1)]
    if (next.length === 0) registry.delete(name)
    else registry.set(name, next)
  }
}
