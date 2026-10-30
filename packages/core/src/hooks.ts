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
