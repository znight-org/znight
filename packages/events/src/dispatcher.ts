/**
 * Dispatch of application events (RFC 0011 §5.7–§5.11, architecture §9.8).
 *
 * - **Inline** listeners run one after the other in the caller's async context (its request scope),
 *   each awaited before the next; the first error stops the phase and reaches the caller unchanged.
 *   When no scope is active and an inline listener is request-scoped, the phase runs in a scope of
 *   its own.
 * - **Detached** listeners start on a macrotask once the inline phase succeeded, each in a fresh
 *   scope, concurrently; their errors are reported (`onError`, logs, hooks), never thrown.
 * - **`emit()`** is a publication started on a macrotask in a fresh scope; every error is reported.
 *
 * The fast path (no hook observer) allocates nothing for a class without listener and only awaits
 * what listeners return; the observed path builds the `events:publish` and `events:listener` events.
 * Detached listeners and `emit()` work are tracked: `onStop` waits for them (`drain`); after it,
 * `publish()` awaits its own detached listeners, so none outlives the providers.
 */
import type { Container, CoreLogger, EventListenerEvent, EventPublishEvent, Hooks } from '@znight/core'
import type { EventErrorHandler, EventErrorInfo } from './options.ts'
import type { DispatchPlan, Listener, ListenerRegistry } from './registry.ts'

import { notAnEventError } from './errors.ts'
import { EMPTY_PLAN, eventNameOf } from './registry.ts'

/** Lifecycle of the dispatcher: `stopped` once the plugin's `onStop` started. */
export type DispatcherState = 'running' | 'stopped' | 'disposed'

/** What the dispatcher needs from the application. */
export interface DispatcherContext {
  readonly container: Container
  readonly hooks: Hooks
  readonly logger: CoreLogger
  readonly onError: EventErrorHandler | undefined
}

/** One piece of tracked background work (a detached listener, an `emit()`). */
interface Work {
  readonly name: string
}

/** Observer of every publication, with or without listeners (`recordEvents()` of the testing entry). */
export type PublicationObserver = (event: object, eventName: string, mode: 'publish' | 'emit') => void

/** A publication observed by hooks: the failing inline listener is recorded on it. */
interface Failure {
  listener: Listener | undefined
}

const RESOLVED: Promise<void> = Promise.resolve()
const NO_WORK: ReadonlySet<Work> = new Set()

/** A caller waiting until no work but `ignore` is in flight. */
interface Waiter {
  readonly ignore: ReadonlySet<Work>
  readonly resolve: () => void
}

/** Dispatches the events of one running application. */
export class Dispatcher {
  readonly #registry: ListenerRegistry
  readonly #container: Container
  readonly #hooks: Hooks
  readonly #logger: CoreLogger
  readonly #onError: EventErrorHandler | undefined
  readonly #running = new Set<Work>()
  #waiters: Waiter[] = []
  /** Work in flight when `stop()` began: `stop()` drains it, `dispose()` does not wait for it again. */
  #beforeStop: ReadonlySet<Work> = NO_WORK
  #state: DispatcherState = 'running'
  /** Observers of every publication; replaced, never mutated (copy-on-write). */
  observers: readonly PublicationObserver[] = []

  constructor(registry: ListenerRegistry, context: DispatcherContext) {
    this.#registry = registry
    this.#container = context.container
    this.#hooks = context.hooks
    this.#logger = context.logger
    this.#onError = context.onError
  }

  get state(): DispatcherState {
    return this.#state
  }

  /** Names of the background work in flight (`WelcomeMail.send (UserCreated)`, `emit UserCreated`). */
  inflight(): string[] {
    return this.#names(NO_WORK)
  }

  /** Names of the work in flight started after `stop()` began (all of it before `stop()`). */
  late(): string[] {
    return this.#names(this.#beforeStop)
  }

  #names(ignore: ReadonlySet<Work>): string[] {
    const names: string[] = []
    for (const work of this.#running) if (!ignore.has(work)) names.push(work.name)
    return names
  }

  // ------------------------------------------------------------------------------------- publish

  publish(event: object): Promise<void> {
    let plan: DispatchPlan
    try {
      plan = this.#planOf(event, 'publish')
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.observers.length !== 0) this.#notify(event, plan, 'publish')
    if (plan === EMPTY_PLAN) return RESOLVED
    if (this.#observed()) return this.#publishObserved(event, plan, 'publish', undefined)
    try {
      const inline = plan.inline.length === 0 ? undefined : this.#inlinePhase(event, plan)
      return inline === undefined
        ? this.#afterInline(event, plan, 'publish')
        : inline.then(() => this.#afterInline(event, plan, 'publish'))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  emit(event: object): void {
    const plan = this.#planOf(event, 'emit')
    if (this.observers.length !== 0) this.#notify(event, plan, 'emit')
    if (plan === EMPTY_PLAN) return
    const work = this.#begin(`emit ${plan.eventName}`)
    setImmediate(() => {
      const failure: Failure = { listener: undefined }
      void this.#container
        .runInScope(() =>
          this.#observed()
            ? this.#publishObserved(event, plan, 'emit', failure)
            : this.#runInlineTracked(event, plan, failure).then(() => this.#afterInline(event, plan, 'emit')),
        )
        .then(undefined, error => this.#report(error, event, plan, failure.listener, 'emit'))
        .then(() => this.#end(work))
    })
  }

  #planOf(event: object, action: 'publish' | 'emit'): DispatchPlan {
    if (typeof event !== 'object' || event === null) throw notAnEventError(action, event)
    const prototype: object | null = Object.getPrototypeOf(event)
    if (prototype === Object.prototype || prototype === null || Array.isArray(event)) {
      throw notAnEventError(action, event)
    }
    return this.#registry.planOf(prototype)
  }

  #notify(event: object, plan: DispatchPlan, mode: 'publish' | 'emit'): void {
    const name = plan === EMPTY_PLAN ? eventNameOf(Object.getPrototypeOf(event) as object) : plan.eventName
    for (const observer of this.observers) {
      try {
        observer(event, name, mode)
      } catch (error) {
        this.#logger.error('An observer of the publications failed', { err: error })
      }
    }
  }

  #observed(): boolean {
    const hooks = this.#hooks
    return (
      hooks.hasWrappers('events:publish') ||
      hooks.hasListeners('events:publish') ||
      hooks.hasWrappers('events:listener') ||
      hooks.hasListeners('events:listener')
    )
  }

  // ------------------------------------------------------------------------------- inline phase

  /** Fast path: `undefined` when every inline listener completed synchronously. */
  #inlinePhase(event: object, plan: DispatchPlan): Promise<void> | undefined {
    if (plan.inlineScoped && this.#container.currentScope() === undefined) {
      return this.#container.runInScope(() => this.#runInline(event, plan.inline, 0))
    }
    return this.#runInline(event, plan.inline, 0)
  }

  /** Invokes `listeners[start..]` in order, awaiting only what they return. Throws synchronously. */
  #runInline(event: object, listeners: readonly Listener[], start: number): Promise<void> | undefined {
    const container = this.#container
    for (let index = start; index < listeners.length; index++) {
      const listener = listeners[index] as Listener
      const result = listener.invoke(container.get(listener.token), event)
      if (isThenable(result)) {
        return Promise.resolve(result).then(() => this.#runInline(event, listeners, index + 1))
      }
    }
    return undefined
  }

  /** Inline phase recording the failing listener and producing `events:listener` (scope included). */
  #runInlineTracked(event: object, plan: DispatchPlan, failure: Failure): Promise<void> {
    if (plan.inline.length === 0) return RESOLVED
    const run = async (): Promise<void> => {
      for (const listener of plan.inline) {
        try {
          await this.#invoke(listener, event, plan, false)
        } catch (error) {
          failure.listener = listener
          throw error
        }
      }
    }
    if (plan.inlineScoped && this.#container.currentScope() === undefined) return this.#container.runInScope(run)
    return run()
  }

  /** The `events:publish` hook around the inline phase; detached listeners are scheduled inside it. */
  async #publishObserved(
    event: object,
    plan: DispatchPlan,
    mode: 'publish' | 'emit',
    failure: Failure | undefined,
  ): Promise<void> {
    const hooks = this.#hooks
    const tracked = failure ?? { listener: undefined }
    if (!hooks.hasWrappers('events:publish') && !hooks.hasListeners('events:publish')) {
      await this.#runInlineTracked(event, plan, tracked)
      await this.#afterInline(event, plan, mode)
      return
    }
    const record: EventPublishEvent = {
      event: plan.eventName,
      payload: event,
      mode,
      inline: plan.inline.length,
      detached: plan.detached.length,
      startTime: performance.now(),
    }
    try {
      await hooks.run('events:publish', record, async () => {
        try {
          await this.#runInlineTracked(event, plan, tracked)
        } catch (error) {
          record.error = error
          if (tracked.listener !== undefined) record.failedListener = tracked.listener.name
          throw error
        }
        // inside the wrappers: detached listeners inherit the publication's trace context
        await this.#afterInline(event, plan, mode)
      })
    } finally {
      if (hooks.hasListeners('events:publish')) hooks.emit('events:publish', record)
    }
  }

  /** One listener invocation, through the `events:listener` hook when it is observed. */
  #invoke(listener: Listener, event: object, plan: DispatchPlan, detached: boolean): unknown {
    const hooks = this.#hooks
    if (!hooks.hasWrappers('events:listener') && !hooks.hasListeners('events:listener')) {
      return listener.invoke(this.#container.get(listener.token), event)
    }
    const record: EventListenerEvent = {
      event: plan.eventName,
      payload: event,
      listener: listener.name,
      detached,
      startTime: performance.now(),
    }
    return hooks
      .run('events:listener', record, async () => {
        try {
          return await listener.invoke(this.#container.get(listener.token), event)
        } catch (error) {
          record.error = error
          throw error
        }
      })
      .finally(() => {
        if (hooks.hasListeners('events:listener')) hooks.emit('events:listener', record)
      })
  }

  // ----------------------------------------------------------------------------- detached phase

  /**
   * Once the inline phase succeeded: schedules the detached listeners (running), or runs them and
   * waits for them (after `onStop`: none may outlive the providers). Never rejects.
   */
  #afterInline(event: object, plan: DispatchPlan, mode: 'publish' | 'emit'): Promise<void> {
    const listeners = plan.detached
    if (listeners.length === 0) return RESOLVED
    if (this.#state !== 'running') return this.#runDetached(event, plan, mode)
    const works = listeners.map(listener => this.#begin(`${listener.name} (${plan.eventName})`))
    setImmediate(() => {
      for (let index = 0; index < listeners.length; index++) {
        const work = works[index] as Work
        void this.#detached(event, plan, listeners[index] as Listener, mode).then(() => this.#end(work))
      }
    })
    return RESOLVED
  }

  #runDetached(event: object, plan: DispatchPlan, mode: 'publish' | 'emit'): Promise<void> {
    return Promise.all(plan.detached.map(listener => this.#detached(event, plan, listener, mode))).then(() => undefined)
  }

  /**
   * One detached listener in a fresh scope; never rejects, and settles once its error (if any) is
   * reported. `mode`: the publication that scheduled it.
   */
  #detached(event: object, plan: DispatchPlan, listener: Listener, mode: 'publish' | 'emit'): Promise<void> {
    return this.#container
      .runInScope(() => this.#invoke(listener, event, plan, true))
      .then(
        () => undefined,
        error => this.#report(error, event, plan, listener, mode),
      )
  }

  // ---------------------------------------------------------------------------------- reporting

  /**
   * Reports an error to `onError` (default: the logger). Returns the promise of an async handler,
   * settled and never rejected, so that the tracked work (and the drain) covers the report.
   */
  #report(
    error: unknown,
    event: object,
    plan: DispatchPlan,
    listener: Listener | undefined,
    mode: 'publish' | 'emit',
  ): Promise<void> | undefined {
    const info: EventErrorInfo = {
      event,
      eventName: plan.eventName,
      listener: listener?.name,
      detached: listener?.detached ?? false,
      mode,
    }
    const handler = this.#onError
    if (handler === undefined) {
      this.#logger.error(`Event listener failed: ${info.listener ?? 'emit'} on ${info.eventName}`, {
        event: info.eventName,
        listener: info.listener,
        detached: info.detached,
        err: error,
      })
      return undefined
    }
    try {
      const result = handler(error, info)
      if (isThenable(result)) {
        return Promise.resolve(result).then(
          () => undefined,
          failure => this.#onErrorFailed(failure, error),
        )
      }
    } catch (failure) {
      this.#onErrorFailed(failure, error)
    }
    return undefined
  }

  #onErrorFailed(failure: unknown, original: unknown): void {
    this.#logger.error('The onError handler of EventsPlugin failed', { err: failure, cause: original })
  }

  // ----------------------------------------------------------------------------------- tracking

  #begin(name: string): Work {
    const work: Work = { name }
    this.#running.add(work)
    return work
  }

  #end(work: Work): void {
    this.#running.delete(work)
    if (this.#waiters.length === 0) return
    const waiting: Waiter[] = []
    for (const waiter of this.#waiters) {
      if (this.#settled(waiter.ignore)) waiter.resolve()
      else waiting.push(waiter)
    }
    this.#waiters = waiting
  }

  /** Whether no work but `ignore` is in flight. */
  #settled(ignore: ReadonlySet<Work>): boolean {
    if (this.#running.size > ignore.size) return false
    for (const work of this.#running) if (!ignore.has(work)) return false
    return true
  }

  #until(ignore: ReadonlySet<Work>): Promise<void> {
    if (this.#settled(ignore)) return RESOLVED
    return new Promise(resolve => {
      this.#waiters.push({ ignore, resolve })
    })
  }

  /** Resolves once no detached listener nor `emit()` work is in flight. */
  idle(): Promise<void> {
    return this.#until(NO_WORK)
  }

  /** `onStop`: publications from now on await their detached listeners; waits for the work in flight. */
  stop(timeoutMs: number): Promise<readonly string[]> {
    if (this.#state === 'running') {
      this.#state = 'stopped'
      this.#beforeStop = new Set(this.#running)
    }
    return this.#waitIdle(timeoutMs, NO_WORK)
  }

  /**
   * `onDispose`: waits for the work started after `stop()` began (bounded; the work `stop()` drains
   * is not waited for again, even when that drain timed out), then refuses publications.
   */
  async dispose(timeoutMs: number): Promise<readonly string[]> {
    const late = await this.#waitIdle(timeoutMs, this.#beforeStop)
    this.#state = 'disposed'
    return late
  }

  /** Waits until no work but `ignore` is in flight, or `timeoutMs`; returns the other work still running. */
  async #waitIdle(timeoutMs: number, ignore: ReadonlySet<Work>): Promise<readonly string[]> {
    if (this.#settled(ignore)) return []
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout =
      timeoutMs === Number.POSITIVE_INFINITY
        ? undefined
        : new Promise<void>(resolve => {
            timer = setTimeout(resolve, timeoutMs)
            timer.unref?.()
          })
    const settled = this.#until(ignore)
    await (timeout === undefined ? settled : Promise.race([settled, timeout]))
    if (timer !== undefined) clearTimeout(timer)
    return this.#names(ignore)
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
